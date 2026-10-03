import type { BackendCapabilities, ExecutionBackend, ProgramBinding, ResidentAllocation } from "../../execution/backend.js";
import { TabgradError } from "../../shared/errors.js";
import type { ExecutableProgram, LoweredComputation, ProgramSlot } from "../../execution/executable-program.js";
import { tensorElementCount } from "../../runtime/tensor-shape.js";
import { WEBGPU_ADDITION_SOURCE, WEBGPU_ADDITION_WORKGROUP_SIZE } from "./kernels/addition.js";
import { WEBGPU_SUM_SOURCE, WEBGPU_SUM_GROUP_ELEMENTS, WEBGPU_SUM_PARTIAL_BYTES, WEBGPU_SUM_WORKGROUP_BYTES, WEBGPU_SUM_WORKGROUP_SIZE } from "./kernels/sum.js";
import { ExecutionTicket } from "../../execution/execution-ticket.js";

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
  constructor(readonly buffer: GPUBuffer, readonly byteLength: number) {}
}

interface GpuInvocationStorage {
  readonly allocations: Map<ProgramSlot, GpuAllocation>;
  readonly created: Set<GpuAllocation>;
  drained?: Promise<void>;
  success: boolean;
  queuedWrites: boolean;
}

interface GpuReadback {
  staging?: GpuAllocation;
  drained?: Promise<void>;
  mapping?: Promise<Float32Array>;
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
  readonly #pipelines = new Map<"add-f32" | "sum-f32", GPUComputePipeline>();
  readonly #preparations = new Map<"add-f32" | "sum-f32", Promise<void>>();
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
    const sumSupported = device.limits.maxBufferSize >= 16
      && device.limits.maxComputeWorkgroupStorageSize >= WEBGPU_SUM_WORKGROUP_BYTES
      && device.limits.maxComputeWorkgroupSizeX >= WEBGPU_SUM_WORKGROUP_SIZE
      && device.limits.maxComputeInvocationsPerWorkgroup >= WEBGPU_SUM_WORKGROUP_SIZE;
    this.capabilities = Object.freeze({ device: "webgpu", computations: Object.freeze(sumSupported ? ["add-f32", "sum-f32"] as const : ["add-f32"] as const),
      gradients: false, maximumTensorBytes: Math.min(this.#limits.maxBufferSize,
        this.#limits.maxStorageBufferBindingSize, 0xffffffff * 4, this.#limits.maxComputeWorkgroupsPerDimension * WEBGPU_ADDITION_WORKGROUP_SIZE * 4) });
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
    const requested = program?.computations.map((computation) => computation.kind) ?? ["add-f32"];
    const pending: Promise<void>[] = [];
    for (const kind of new Set(requested)) {
      if ((kind !== "add-f32" && kind !== "sum-f32") || !this.capabilities.computations.includes(kind)) {
        throw new TabgradError("BACKEND_CAPABILITY_MISMATCH", "Unsupported WebGPU computation.", {
          backend: "webgpu", phase: "preparation",
          programValueSlot: program?.computations.find((computation) => computation.kind === kind)?.output,
        });
      }
      if (this.#pipelines.has(kind)) continue;
      let preparation = this.#preparations.get(kind);
      if (preparation === undefined) {
        preparation = this.#compile(kind);
        this.#preparations.set(kind, preparation);
      }
      pending.push(preparation);
    }
    return pending.length === 0 ? undefined : Promise.all(pending).then(() => undefined);
  }

  async #compile(kind: "add-f32" | "sum-f32"): Promise<void> {
    const pipeline = await this.#checked("preparation", () => {
      const code = kind === "add-f32" ? WEBGPU_ADDITION_SOURCE : WEBGPU_SUM_SOURCE;
      const module = this.#device.createShaderModule({ code });
      return this.#device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
    });
    this.assertAvailable();
    this.#pipelines.set(kind, pipeline);
  }

  #allocate(byteLength: number, usage: GPUBufferUsageFlags): GpuAllocation {
    this.assertAvailable();
    const size = Math.max(4, byteLength);
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
    const { allocations, created } = storage;
    const spare = new Map<number, GpuAllocation[]>();
    const uses = program.storageUseCounts.slice();
    try {
      const encoder = this.#device.createCommandEncoder();
      for (const value of program.values) {
        if (value.source !== "binding") continue;
        const binding = bindings.get(value.slot);
        if (binding?.resident !== undefined) {
          allocations.set(value.slot, this.#allocation(binding.resident));
        } else {
          const allocation = this.#allocate(tensorElementCount(value.shape) * 4,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
          allocations.set(value.slot, allocation); created.add(allocation);
          if (binding?.hostData === undefined) throw new TabgradError("BACKEND_STATUS_ERROR", "Missing GPU input binding.");
          if (allocation.byteLength !== 0) {
            storage.queuedWrites = true;
            // Host bindings are copied by tensor creation into owned ArrayBuffers.
            this.#device.queue.writeBuffer(allocation.buffer, 0, binding.hostData as Float32Array<ArrayBuffer>);
          }
          this.#uploadBytes += allocation.byteLength;
        }
      }
      for (const computation of program.computations) {
        const byteLength = tensorElementCount(program.values[computation.output]!.shape) * 4;
        const output = spare.get(byteLength)?.pop() ?? this.#allocate(byteLength,
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
        created.add(output); allocations.set(computation.output, output);
        if (byteLength !== 0) {
          const inputs = computation.inputs.map((slot) => allocations.get(program.values[slot]!.storageSlot)!);
          this.#encodeComputation(encoder, computation, inputs, output, storage);
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
      this.#device.queue.submit([encoder.finish()]);
      storage.drained = this.#drain();
      return storage.drained;
    } finally {
      // Never reuse or destroy submitted buffers merely because an error scope failed.
      // writeBuffer itself enqueues work, even if encoding fails before submit.
      if (storage.drained === undefined && storage.queuedWrites) storage.drained = this.#drain();
    }
  }

  #encodeComputation(encoder: GPUCommandEncoder, computation: LoweredComputation,
    inputs: readonly GpuAllocation[], output: GpuAllocation, storage: GpuInvocationStorage): void {
    try {
      if (computation.kind === "sum-f32") {
        this.#encodeSum(encoder, inputs[0]!, output, storage);
        return;
      }
      const pipeline = this.#pipelines.get("add-f32");
      if (computation.kind !== "add-f32" || pipeline === undefined) throw new Error("WebGPU computation was not prepared.");
      const bindGroup = this.#device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
        entries: [...inputs, output].map((allocation, binding) => ({ binding, resource: { buffer: allocation.buffer } })) });
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(output.byteLength / 4 / WEBGPU_ADDITION_WORKGROUP_SIZE)); pass.end();
      this.#kernelCalls += 1;
    } catch (cause) {
      throw new TabgradError("BACKEND_STATUS_ERROR", "WebGPU computation encoding failed.", {
        backend: "webgpu", phase: "execution", programValueSlot: computation.output,
      }, cause);
    }
  }

  #encodeSum(encoder: GPUCommandEncoder, input: GpuAllocation, output: GpuAllocation, storage: GpuInvocationStorage): void {
    const pipeline = this.#pipelines.get("sum-f32");
    if (pipeline === undefined) throw new Error("WebGPU sum was not prepared.");
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    let current = input;
    let count = input.byteLength / 4;
    let partialInput = false;
    do {
      const groups = Math.max(1, Math.ceil(count / WEBGPU_SUM_GROUP_ELEMENTS));
      const final = groups === 1;
      const target = final ? output : this.#allocate(groups * WEBGPU_SUM_PARTIAL_BYTES, GPUBufferUsage.STORAGE);
      if (!final) storage.created.add(target);
      const parameters = this.#allocate(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      storage.created.add(parameters);
      // Immutable per-stage parameters enqueue work even with resident/empty input.
      storage.queuedWrites = true;
      this.#device.queue.writeBuffer(parameters.buffer, 0, new Uint32Array([count, Number(final), Number(partialInput), 0]));
      const bindGroup = this.#device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: current.buffer } },
        { binding: 1, resource: { buffer: target.buffer } },
        { binding: 2, resource: { buffer: parameters.buffer } },
      ] });
      pass.setBindGroup(0, bindGroup); pass.dispatchWorkgroups(groups);
      this.#kernelCalls += 1;
      if (final) break;
      current = target; count = groups; partialInput = true;
    } while (true);
    pass.end();
  }

  async #releaseInvocation(result: Promise<unknown>, storage: GpuInvocationStorage): Promise<void> {
    // Failure is delivered by result; drain failure retires the generation and
    // preserves unknown-byte accounting. Neither is interpreted as successful work.
    await Promise.allSettled([result, storage.drained]);
    const retained = storage.success ? new Set(storage.allocations.values()) : new Set<GpuAllocation>();
    for (const allocation of storage.created) if (!retained.has(allocation)) this.release(allocation);
  }

  read(reference: ResidentAllocation, length: number): Float32Array | ExecutionTicket<Float32Array> {
    const source = this.#allocation(reference);
    if (length === 0) return new Float32Array();
    const readback: GpuReadback = {};
    const result = this.#checked("readback", () => {
      readback.mapping = this.#copyAndMap(source, length, readback);
      return readback.mapping;
    });
    return new ExecutionTicket(result, this.#releaseReadback(result, readback));
  }

  async #copyAndMap(source: GpuAllocation, length: number, readback: GpuReadback): Promise<Float32Array> {
    const staging = this.#allocate(length * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    readback.staging = staging;
    const encoder = this.#device.createCommandEncoder();
    encoder.copyBufferToBuffer(source.buffer, 0, staging.buffer, 0, length * 4);
    this.#device.queue.submit([encoder.finish()]);
    readback.drained = this.#drain();
    await this.#awaitLive(staging.buffer.mapAsync(GPUMapMode.READ));
    this.assertAvailable();
    const result = new Float32Array(staging.buffer.getMappedRange()).slice();
    staging.buffer.unmap();
    this.#readbackBytes += result.byteLength;
    return result;
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
    this.#ownedBytes -= Math.max(4, reference.byteLength);
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
