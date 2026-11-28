import { planKernelDispatch, requestedPipelines, selectPipeline, pipelineSource, type PipelineKey, type PipelineSelection,
  type KernelDispatchPlan } from "./kernel-dispatch.js";
import { webGpuComputations, webGpuKernel } from "./kernel-catalogue.js";
import { gpuTensorCapacityBytes } from "./webgpu-capacity.js";
import type { BackendCapabilities, ExecutionBackend, ProgramBinding, ResidentAllocation } from "../../execution/backend.js";
import { assertResidentTensor, assertTensorPayload, hostTensorPayload, type HostTensorPayload } from "../../execution/tensor-payload.js";
import { alignedByteLength, checkedElementBytes, TENSOR_STORAGE_ENCODINGS, tensorDType, type TensorDType, type TensorDTypeDescriptor } from "../../shared/tensor-dtype.js";
import { TabgradError } from "../../shared/errors.js";
import { assertBackendProgram } from "../../execution/backend.js";
import type { ExecutableProgram, LoweredComputation, ProgramSlot, ProgramValue } from "../../execution/executable-program.js";
import { WEBGPU_COEFFICIENT_UNIFORM_BYTES } from "./kernels/coefficient-addition.js";
import { WEBGPU_MATRIX_UNIFORM_BYTES } from "./kernels/matrix-product.js";
import { ExecutionTicket } from "../../execution/execution-ticket.js";
import { indexSelectionBoundsError } from "../../execution/index-selection.js";
import { INDEX_SELECTION_VALID } from "./kernels/index-selection.js";
import { WEBGPU_RECEIVING_UNIFORM_BYTES } from "./kernels/receiving.js";

// WebGPU flag values are fixed by the API. The selected DOM declarations expose
// their numeric types but not the namespace objects; no ambient typing patch is needed.
const GPUBufferUsage = Object.freeze({ MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 });
const GPUMapMode = Object.freeze({ READ: 1 });

export interface WebGpuDiagnostics {
  readonly state: "ready" | "lost" | "closed";
  readonly adapter: Readonly<{ vendor: string; architecture: string; device: string; description: string; isFallbackAdapter: boolean }>;
  readonly features: readonly string[];
  readonly limits: Readonly<{ maxBufferSize: number; maxStorageBufferBindingSize: number; maxComputeWorkgroupsPerDimension: number }>;
  readonly ownedBufferBytes: number;
  readonly peakOwnedBufferBytes: number;
  readonly pendingSubmissions: number;
  readonly unknownCompletionBytes: number;
  readonly uploadBytes: number;
  readonly readbackBytes: number;
  readonly kernelCalls: number;
}

/** Private physical owner contract shared by local and connected placement. */
export interface WebGpuExecutionBackend extends ExecutionBackend {
  diagnostics(): WebGpuDiagnostics;
}

class GpuAllocation {
  released = false;
  format?: TensorDTypeDescriptor;
  constructor(readonly buffer: GPUBuffer, readonly byteLength: number) {}
}

interface GpuInvocationStorage {
  readonly allocations: Map<ProgramSlot, GpuAllocation>;
  readonly created: Set<GpuAllocation>;
  indexStatus?: GpuAllocation;
  indexValidation?: Promise<void>;
  drained?: Promise<void>;
  success: boolean;
  queuedWrites: boolean;
}

interface GpuReadback {
  staging?: GpuAllocation;
  drained?: Promise<void>;
  mapping?: Promise<HostTensorPayload>;
}

/** Transfer whole GPU words, copying only the final partial word on the host. */
function writeTensorBytes(queue: GPUQueue, buffer: GPUBuffer, bytes: Uint8Array<ArrayBuffer>): void {
  const aligned = bytes.byteLength - bytes.byteLength % 4;
  if (aligned === bytes.byteLength) { queue.writeBuffer(buffer, 0, bytes); return; }
  if (aligned !== 0) queue.writeBuffer(buffer, 0, bytes.subarray(0, aligned));
  const tail = new Uint8Array(4);
  tail.set(bytes.subarray(aligned));
  queue.writeBuffer(buffer, aligned, tail);
}
/** Owns the acquired device, its private buffers, pipelines and physical completion. */
export class WebGpuBackend implements WebGpuExecutionBackend {
  readonly synchronousObservation = false;
  readonly capabilities: BackendCapabilities;
  readonly #device: GPUDevice;
  readonly #identities = new WeakSet<object>();
  readonly #owned = new Set<GpuAllocation>();
  readonly #waiters = new Set<(error: TabgradError) => void>();
  readonly #adapter: WebGpuDiagnostics["adapter"];
  readonly #features: readonly string[];
  readonly #limits: WebGpuDiagnostics["limits"];
  #failure: TabgradError | undefined;
  #closed = false;
  readonly #pipelines = new Map<PipelineKey, GPUComputePipeline>();
  readonly #preparations = new Map<PipelineKey, Promise<void>>();
  #ownedBytes = 0;
  #peakBytes = 0;
  #pendingSubmissions = 0;
  #unknownBytes = 0;
  #uploadBytes = 0;
  #readbackBytes = 0;
  #kernelCalls = 0;

  constructor(device: GPUDevice) {
    this.#device = device;
    const info = device.adapterInfo;
    this.#adapter = Object.freeze({ vendor: info.vendor, architecture: info.architecture,
      device: info.device, description: info.description, isFallbackAdapter: info.isFallbackAdapter });
    this.#features = Object.freeze(Array.from(device.features).sort());
    this.#limits = Object.freeze({ maxBufferSize: device.limits.maxBufferSize,
      maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
      maxComputeWorkgroupsPerDimension: device.limits.maxComputeWorkgroupsPerDimension });
    this.capabilities = Object.freeze({ device: "webgpu", storageEncodings: TENSOR_STORAGE_ENCODINGS, computations: webGpuComputations(device.limits),
      gradients: true, maximumTensorBytes: gpuTensorCapacityBytes(this.#limits) });
    void device.lost.then((info) => {
      if (!this.#closed) this.#retire(new TabgradError("BACKEND_STATUS_ERROR", "The WebGPU device was lost.", {
        backend: "webgpu", device: "webgpu", phase: "device-loss", reason: info.reason,
      }, info));
    });
  }

  get ready(): boolean { return !this.#closed && this.#failure === undefined; }

  assertAvailable(): void {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#closed) throw new TabgradError("CLOSED_SESSION", "The WebGPU backend is closed.");
  }

  owns(allocation: ResidentAllocation): boolean { return this.#identities.has(allocation); }

  diagnostics(): WebGpuDiagnostics {
    return Object.freeze({ state: this.#failure !== undefined ? "lost" : this.#closed ? "closed" : "ready",
      adapter: this.#adapter, features: this.#features, limits: this.#limits,
      ownedBufferBytes: this.#ownedBytes, peakOwnedBufferBytes: this.#peakBytes,
      pendingSubmissions: this.#pendingSubmissions, unknownCompletionBytes: this.#unknownBytes,
      uploadBytes: this.#uploadBytes, readbackBytes: this.#readbackBytes, kernelCalls: this.#kernelCalls });
  }

  prepare(program?: ExecutableProgram): Promise<void> | undefined {
    this.assertAvailable();
    const requested = new Map<PipelineKey, { pipeline: PipelineSelection; slot: ProgramSlot | undefined }>();
    if (program === undefined) {
      const pipeline = selectPipeline(webGpuKernel("add-f32")!.direct, "linear");
      requested.set(pipeline.key, { pipeline, slot: undefined });
    } else {
      const plans = this.#planProgram(program);
      program.computations.forEach((computation, index) => {
        for (const pipeline of requestedPipelines(plans[index]!)) {
          if (!requested.has(pipeline.key)) requested.set(pipeline.key, { pipeline, slot: computation.output });
        }
      });
    }
    const pending: Promise<void>[] = [];
    for (const [key, { pipeline, slot }] of requested) {
      if (this.#pipelines.has(key)) continue;
      let preparation = this.#preparations.get(key);
      if (preparation === undefined) {
        preparation = this.#compile(pipeline);
        this.#preparations.set(key, preparation);
      }
      // Cache physical preparation, never the requesting program's provenance.
      pending.push(preparation.catch((error: unknown) => {
        if (!(error instanceof TabgradError) || error.details.phase !== "preparation") throw error;
        throw new TabgradError(error.code, error.message, { ...error.details, programValueSlot: slot }, error.cause);
      }));
    }
    return pending.length === 0 ? undefined : Promise.all(pending).then(() => undefined);
  }

  #planProgram(program: ExecutableProgram): readonly KernelDispatchPlan[] {
    assertBackendProgram(this.capabilities, program);
    for (const value of program.values) {
      const bytes = program.elementCount(value.slot) * tensorDType(value.dtype).bytesPerElement;
      if (!Number.isSafeInteger(bytes) || bytes > this.capabilities.maximumTensorBytes) {
        throw new TabgradError("RESOURCE_EXHAUSTED", "GPU program storage exceeds its admitted byte extent.", {
          backend: "webgpu", phase: "preparation", programValueSlot: value.slot,
          byteLength: bytes, maximumTensorBytes: this.capabilities.maximumTensorBytes,
        });
      }
    }
    return program.computations.map(computation => {
      try {
        const plan = planKernelDispatch(computation, program, this.#limits);
        if (plan.path === "pointwise"
          && this.#device.limits.maxStorageBuffersPerShaderStage < plan.pipeline.minimumStorageBindings) {
          throw new TabgradError("BACKEND_CAPABILITY_MISMATCH", "Unsupported WebGPU broadcast bindings.");
        }
        return plan;
      } catch (cause) {
        if (!(cause instanceof TabgradError)) throw cause;
        throw new TabgradError(cause.code, cause.message, { ...cause.details,
          backend: "webgpu", phase: "preparation", programValueSlot: computation.output,
        }, cause.cause);
      }
    });
  }

  async #compile(selection: PipelineSelection): Promise<void> {
    const pipeline = await this.#checked("preparation", () => {
      const module = this.#device.createShaderModule({ code: pipelineSource(selection) });
      return this.#device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
    });
    this.assertAvailable();
    this.#pipelines.set(selection.key, pipeline);
  }

  #allocate(byteLength: number, usage: GPUBufferUsageFlags): GpuAllocation {
    this.assertAvailable();
    const size = Math.max(4, alignedByteLength(byteLength, 4));
    const allocation = new GpuAllocation(this.#device.createBuffer({ size, usage }), byteLength);
    this.#identities.add(allocation);
    this.#owned.add(allocation);
    this.#ownedBytes += size;
    this.#peakBytes = Math.max(this.#peakBytes, this.#ownedBytes);
    return allocation;
  }

  #allocation(reference: ResidentAllocation): GpuAllocation {
    this.assertAvailable();
    if (!(reference instanceof GpuAllocation) || !this.owns(reference) || reference.released) {
      throw new TabgradError("BACKEND_STATUS_ERROR", "A stale or foreign WebGPU allocation was used.", { backend: "webgpu" });
    }
    return reference;
  }

  #residentTensor(reference: ResidentAllocation, dtype: TensorDType, elements: number): GpuAllocation {
    const allocation = this.#allocation(reference);
    assertResidentTensor(allocation.format, allocation.byteLength, dtype, elements);
    return allocation;
  }

  validateResidentBinding(reference: ResidentAllocation, dtype: TensorDType, elements: number): void {
    this.#residentTensor(reference, dtype, elements);
  }

  execute(program: ExecutableProgram, bindings: ReadonlyMap<ProgramSlot, ProgramBinding>, retainedSlots: readonly boolean[]): ExecutionTicket<ReadonlyMap<ProgramSlot, ResidentAllocation>> {
    this.assertAvailable();
    const storage: GpuInvocationStorage = { allocations: new Map(), created: new Set(), success: false, queuedWrites: false };
    const result = this.#checked("execution", () => this.#encodeExecution(program, bindings, retainedSlots, storage))
      .then(() => {
        this.assertAvailable();
        storage.success = true;
        return storage.allocations;
      });
    return new ExecutionTicket(result, this.#releaseInvocation(result, storage));
  }

  #encodeExecution(program: ExecutableProgram, bindings: ReadonlyMap<ProgramSlot, ProgramBinding>,
    retainedSlots: readonly boolean[], storage: GpuInvocationStorage): Promise<void> | undefined {
    const plans = this.#planProgram(program);
    const { allocations, created } = storage;
    const spare = new Map<number, GpuAllocation[]>();
    const uses = program.storageUseCounts.slice();
    try {
      let hostValues: ProgramValue[] | undefined;
      for (const value of program.values) {
        if (value.source !== "binding") continue;
        const resident = bindings.get(value.slot)?.resident;
        if (resident === undefined) {
          (hostValues ??= []).push(value);
          continue;
        }
        allocations.set(value.slot, this.#residentTensor(resident, value.dtype, program.elementCount(value.slot)));
      }
      const encoder = this.#device.createCommandEncoder();
      if (hostValues !== undefined) for (const value of hostValues) {
        const payload = bindings.get(value.slot)?.hostData;
        if (payload === undefined) throw new TabgradError("BACKEND_STATUS_ERROR", "Missing GPU input binding.");
        const elements = program.elementCount(value.slot);
        assertTensorPayload(payload, value.dtype, elements);
        const format = tensorDType(value.dtype);
        const allocation = this.#allocate(checkedElementBytes(elements, format.bytesPerElement),
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
        allocation.format = format;
        allocations.set(value.slot, allocation); created.add(allocation);
        if (allocation.byteLength !== 0) {
          storage.queuedWrites = true;
          // Host bindings are copied by tensor creation into owned ArrayBuffers.
          writeTensorBytes(this.#device.queue, allocation.buffer, payload.bytes);
        }
        this.#uploadBytes += allocation.byteLength;
      }
      for (const [index, computation] of program.computations.entries()) {
        const value = program.values[computation.output]!;
        const format = tensorDType(value.dtype);
        const byteLength = checkedElementBytes(program.elementCount(value.slot), format.bytesPerElement);
        const output = spare.get(byteLength)?.pop() ?? this.#allocate(byteLength,
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
        // Only retired, invocation-owned buffers enter the spare pool. A new
        // tensor may use the same physical bytes with a different format.
        output.format = format;
        created.add(output); allocations.set(computation.output, output);
        const plan = plans[index]!;
        if (plan.path === "index-selection" ? plan.dispatch.workgroups !== 0 : byteLength !== 0) {
          const inputs = computation.inputs.map((slot) => allocations.get(program.values[slot]!.storageSlot)!);
          this.#encodeComputation(encoder, computation, program, inputs, output, storage, plan, index);
        }
        for (const input of computation.inputs) {
          const slot = program.values[input]!.storageSlot;
          uses[slot]! -= 1;
          if (uses[slot] !== 0 || retainedSlots[slot] || bindings.get(slot)?.resident !== undefined) continue;
          const retired = allocations.get(slot)!;
          allocations.delete(slot);
          const pool = spare.get(retired.byteLength) ?? [];
          pool.push(retired); spare.set(retired.byteLength, pool);
        }
      }
      let indexStaging: GpuAllocation | undefined;
      if (storage.indexStatus !== undefined) {
        indexStaging = this.#allocate(4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
        created.add(indexStaging);
        encoder.copyBufferToBuffer(storage.indexStatus.buffer, 0, indexStaging.buffer, 0, 4);
      }
      this.#device.queue.submit([encoder.finish()]);
      storage.drained = this.#drain();
      if (indexStaging === undefined) return storage.drained;
      storage.indexValidation = this.#validateIndexStatus(indexStaging.buffer, program);
      return Promise.all([storage.drained, storage.indexValidation]).then(() => undefined);
    } finally {
      // Never reuse or destroy submitted buffers merely because an error scope failed.
      // writeBuffer itself enqueues work, even if encoding fails before submit.
      if (storage.drained === undefined && storage.queuedWrites) storage.drained = this.#drain();
    }
  }

  #encodeComputation(encoder: GPUCommandEncoder, computation: LoweredComputation,
    program: ExecutableProgram,
    inputs: readonly GpuAllocation[], output: GpuAllocation, storage: GpuInvocationStorage, plan: KernelDispatchPlan, ordinal: number): void {
    try {
      if (plan.path === "sum" || plan.path === "argmax") {
        this.#encodeReduction(encoder, inputs[0]!, output, storage, plan);
        return;
      }
      if (plan.path === "index-selection") {
        this.#encodeIndexSelection(encoder, inputs, output, storage, plan, ordinal);
        return;
      }
      if (plan.path === "receiving") {
        this.#encodeReceiving(encoder, inputs[0]!, output, storage, plan);
        return;
      }
      if (plan.path === "pointwise") {
        this.#encodePointwise(encoder, inputs, output, storage, plan);
        return;
      }
      const pipeline = this.#pipelines.get(plan.pipeline.key);
      if (pipeline === undefined) throw new Error("WebGPU computation was not prepared.");
      const entries = [...inputs, output].map((allocation, binding) => ({ binding, resource: { buffer: allocation.buffer } }));
      if (plan.uniform === "coefficient") {
        const coefficient = this.#allocate(WEBGPU_COEFFICIENT_UNIFORM_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
        storage.created.add(coefficient);
        // Each dispatch retains its own packet, including writes before a failed submit.
        storage.queuedWrites = true;
        this.#device.queue.writeBuffer(coefficient.buffer, 0, new Uint32Array([computation.alphaBits!, 0, 0, 0]));
        entries.push({ binding: 3, resource: { buffer: coefficient.buffer } });
      }
      if (plan.uniform === "matrix") {
        const flags = computation.matrixFlags!;
        const left = program.values[computation.inputs[0]!]!.shape;
        const right = program.values[computation.inputs[1]!]!.shape;
        const parameters = this.#allocate(WEBGPU_MATRIX_UNIFORM_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
        storage.created.add(parameters);
        storage.queuedWrites = true;
        this.#device.queue.writeBuffer(parameters.buffer, 0, new Uint32Array([
          left[flags & 1 ? 1 : 0]!, right[flags & 2 ? 0 : 1]!, left[flags & 1 ? 0 : 1]!, flags,
        ]));
        entries.push({ binding: 3, resource: { buffer: parameters.buffer } });
      }
      const bindGroup = this.#device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
        entries });
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(plan.dispatch.x, plan.dispatch.y, plan.dispatch.z); pass.end();
      this.#kernelCalls += 1;
    } catch (cause) {
      throw new TabgradError("BACKEND_STATUS_ERROR", "WebGPU computation encoding failed.", {
        backend: "webgpu", phase: "execution", programValueSlot: computation.output,
      }, cause);
    }
  }

  #encodeIndexSelection(encoder: GPUCommandEncoder, inputs: readonly GpuAllocation[], output: GpuAllocation,
    storage: GpuInvocationStorage, plan: Extract<KernelDispatchPlan, { path: "index-selection" }>, ordinal: number): void {
    const pipeline = this.#pipelines.get(plan.pipeline.key);
    if (pipeline === undefined) throw new Error("WebGPU index selection was not prepared.");
    // One word records the first invalid operation across the entire invocation.
    const status = storage.indexStatus ??= this.#uploadParameters(Uint32Array.of(INDEX_SELECTION_VALID),
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, storage);
    const { boundLow, boundHigh, count, inner, outputElements } = plan.bounds;
    const parameters = this.#uploadParameters(Uint32Array.of(boundLow, boundHigh, count, inner, outputElements, ordinal, 0, 0),
      GPUBufferUsage.UNIFORM, storage);
    const entries = [...inputs, output, status, parameters].map((allocation, binding) => ({
      binding, resource: { buffer: allocation.buffer },
    }));
    const bindGroup = this.#device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(plan.dispatch.x, plan.dispatch.y, plan.dispatch.z);
    pass.end();
    this.#kernelCalls++;
  }

  async #validateIndexStatus(staging: GPUBuffer, program: ExecutableProgram): Promise<void> {
    await staging.mapAsync(GPUMapMode.READ);
    try {
      const ordinal = new DataView(staging.getMappedRange()).getUint32(0, true);
      if (ordinal === INDEX_SELECTION_VALID) return;
      const computation = program.computations[ordinal];
      if (computation?.selectionAxis === undefined) {
        throw new TabgradError("BACKEND_STATUS_ERROR", "WebGPU returned an invalid index selection status.", {
          backend: "webgpu", phase: "execution",
        });
      }
      throw indexSelectionBoundsError(program.values[computation.inputs[0]!]!.shape, computation.selectionAxis, {
        backend: "webgpu", device: "webgpu", phase: "execution", programValueSlot: computation.output,
      });
    } finally { staging.unmap(); }
  }

  #encodeReduction(encoder: GPUCommandEncoder, input: GpuAllocation, output: GpuAllocation, storage: GpuInvocationStorage,
    plan: Extract<KernelDispatchPlan, { path: "sum" | "argmax" }>): void {
    const pass = encoder.beginComputePass();
    let current = input;
    for (const stage of plan.stages) {
      const pipeline = this.#pipelines.get(stage.pipeline.key);
      if (pipeline === undefined) throw new Error("WebGPU reduction was not prepared.");
      pass.setPipeline(pipeline);
      const target = stage.final ? output : this.#allocate(stage.bytes, GPUBufferUsage.STORAGE);
      if (!stage.final) storage.created.add(target);
      const words = plan.path === "sum" ? [stage.count, Number(stage.final), Number(stage.partial), 0]
        : [stage.count, plan.inner, stage.chunks, stage.workgroups, Number(stage.partial), Number(stage.final), 0, 0];
      const parameters = this.#uploadParameters(new Uint32Array(words), GPUBufferUsage.UNIFORM, storage);
      const bindGroup = this.#device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: current.buffer } },
        { binding: 1, resource: { buffer: target.buffer } },
        { binding: 2, resource: { buffer: parameters.buffer } },
      ] });
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(stage.dispatch.x, stage.dispatch.y, stage.dispatch.z);
      this.#kernelCalls += 1;
      current = target;
    }
    pass.end();
  }

  #uploadParameters(words: Uint32Array, usage: GPUBufferUsageFlags, storage: GpuInvocationStorage): GpuAllocation {
    const allocation = this.#allocate(words.byteLength, usage | GPUBufferUsage.COPY_DST);
    storage.created.add(allocation);
    storage.queuedWrites = true;
    this.#device.queue.writeBuffer(allocation.buffer, 0, words);
    return allocation;
  }

  #encodePointwise(encoder: GPUCommandEncoder, inputs: readonly GpuAllocation[], output: GpuAllocation,
    storage: GpuInvocationStorage, plan: Extract<KernelDispatchPlan, { path: "pointwise" }>): void {
    const pipeline = this.#pipelines.get(plan.pipeline.key);
    if (pipeline === undefined) throw new Error("Broadcast computation was not prepared.");
    const parameters = this.#uploadParameters(plan.words, GPUBufferUsage.STORAGE, storage);
    const entries = [...inputs, output, parameters].map((allocation, binding) => ({ binding, resource: { buffer: allocation.buffer } }));
    const bindGroup = this.#device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(plan.dispatch.x, plan.dispatch.y, plan.dispatch.z); pass.end();
    this.#kernelCalls++;
  }

  #encodeReceiving(encoder: GPUCommandEncoder, input: GpuAllocation, output: GpuAllocation,
    storage: GpuInvocationStorage, plan: Extract<KernelDispatchPlan, { path: "receiving" }>): void {
    const pipeline = this.#pipelines.get(plan.pipeline.key);
    if (pipeline === undefined) throw new Error("Receiving reduction was not prepared.");
    const geometry = this.#uploadParameters(plan.words, GPUBufferUsage.STORAGE, storage);
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    let current = input;
    for (const stage of plan.stages) {
      const target = stage.final ? output : this.#allocate(stage.bytes, GPUBufferUsage.STORAGE);
      if (!stage.final) storage.created.add(target);
      for (let offset = 0; offset < stage.workgroups; offset += this.#limits.maxComputeWorkgroupsPerDimension) {
        const parameters = this.#uploadParameters(new Uint32Array([stage.count, stage.chunks, plan.terms, plan.groups,
          Number(stage.partial), Number(stage.final), offset, 0]), GPUBufferUsage.UNIFORM, storage);
        const bindGroup = this.#device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: current.buffer } }, { binding: 1, resource: { buffer: target.buffer } },
          { binding: 2, resource: { buffer: geometry.buffer } }, { binding: 3, resource: { buffer: parameters.buffer } },
        ] });
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.min(this.#limits.maxComputeWorkgroupsPerDimension, stage.workgroups - offset));
        this.#kernelCalls++;
      }
      current = target;
    }
    pass.end();
  }

  async #releaseInvocation(result: Promise<unknown>, storage: GpuInvocationStorage): Promise<void> {
    // Failure is delivered by result; drain failure retires the generation and
    // preserves unknown-byte accounting. Neither is interpreted as successful work.
    await Promise.allSettled([result, storage.drained, storage.indexValidation]);
    const retained = storage.success ? new Set(storage.allocations.values()) : new Set<GpuAllocation>();
    for (const allocation of storage.created) if (!retained.has(allocation)) this.release(allocation);
  }

  read(reference: ResidentAllocation, length: number, dtype: TensorDType): HostTensorPayload | ExecutionTicket<HostTensorPayload> {
    const source = this.#residentTensor(reference, dtype, length);
    if (length === 0) return hostTensorPayload(dtype, 0, new Uint8Array());
    const readback: GpuReadback = {};
    const result = this.#checked("readback", () => {
      readback.mapping = this.#copyAndMap(source, length, dtype, readback);
      return readback.mapping;
    });
    return new ExecutionTicket(result, this.#releaseReadback(result, readback));
  }

  async #copyAndMap(source: GpuAllocation, length: number, dtype: TensorDType, readback: GpuReadback): Promise<HostTensorPayload> {
    const { byteLength } = source;
    const staging = this.#allocate(byteLength, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    readback.staging = staging;
    const encoder = this.#device.createCommandEncoder();
    encoder.copyBufferToBuffer(source.buffer, 0, staging.buffer, 0, alignedByteLength(byteLength, 4));
    this.#device.queue.submit([encoder.finish()]);
    readback.drained = this.#drain();
    await this.#awaitLive(staging.buffer.mapAsync(GPUMapMode.READ));
    this.assertAvailable();
    const bytes = new Uint8Array(staging.buffer.getMappedRange(), 0, byteLength).slice();
    staging.buffer.unmap();
    this.#readbackBytes += bytes.byteLength;
    return hostTensorPayload(dtype, length, bytes);
  }

  async #releaseReadback(result: Promise<unknown>, readback: GpuReadback): Promise<void> {
    await Promise.allSettled([result, readback.mapping, readback.drained]);
    if (readback.staging !== undefined) this.release(readback.staging);
  }

  release(reference: ResidentAllocation): void {
    if (!(reference instanceof GpuAllocation) || !this.owns(reference)) {
      throw new TabgradError("BACKEND_STATUS_ERROR", "Foreign GPU allocation release.");
    }
    if (reference.released) return;
    reference.released = true;
    reference.buffer.destroy();
    this.#owned.delete(reference);
    this.#ownedBytes -= Math.max(4, alignedByteLength(reference.byteLength, 4));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    // The semantic session joins accepted requests before closing this owner.
    if (this.#failure === undefined && this.#pendingSubmissions !== 0) await this.#drain();
    for (const allocation of this.#owned) this.release(allocation);
    this.#closed = true;
    this.#pipelines.clear();
    this.#preparations.clear();
    this.#device.destroy();
  }

  #retire(error: TabgradError): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    this.#unknownBytes = this.#ownedBytes;
    for (const fail of this.#waiters) fail(error);
    this.#waiters.clear();
  }

  #awaitLive<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#waiters.add(reject);
      void work.then((value) => { this.#waiters.delete(reject); resolve(value); },
        (error: unknown) => { this.#waiters.delete(reject); reject(error); });
      if (this.#failure !== undefined) { this.#waiters.delete(reject); reject(this.#failure); }
    });
  }

  #drain(): Promise<void> {
    this.#pendingSubmissions += 1;
    const completion = this.#device.queue.onSubmittedWorkDone().then(() => {
      this.#pendingSubmissions -= 1;
    }, (cause: unknown) => {
      this.#retire(new TabgradError("BACKEND_STATUS_ERROR", "WebGPU completion could not be established.", {
        backend: "webgpu", device: "webgpu", phase: "drain",
      }, cause));
      throw this.#failure;
    });
    return this.#awaitLive(completion);
  }

  async #checked<T>(phase: string, operation: () => T | Promise<T>): Promise<T> {
    this.assertAvailable();
    for (const filter of ["internal", "out-of-memory", "validation"] as const) this.#device.pushErrorScope(filter);
    let work: T | Promise<T>;
    try { work = operation(); }
    catch (error) { work = Promise.reject(error); }
    const errors = Promise.all([this.#device.popErrorScope(), this.#device.popErrorScope(), this.#device.popErrorScope()])
      .then((scoped) => {
        const error = scoped.find((candidate) => candidate !== null);
        if (error !== undefined) throw error;
      });
    try {
      const [value] = await this.#awaitLive(Promise.all([work, errors]));
      this.assertAvailable();
      return value;
    } catch (cause) {
      if (cause instanceof TabgradError) throw cause;
      throw new TabgradError("BACKEND_STATUS_ERROR", `WebGPU ${phase} failed.`, { backend: "webgpu", phase }, cause);
    }
  }
}
