import { TabgradError } from "../../shared/errors.js";
import type { BackendCapabilities, ExecutionBackend, ProgramBinding, ResidentAllocation } from "../../execution/backend.js";
import { assertBackendProgram } from "../../execution/backend.js";
import { assertResidentTensor, assertTensorPayload, hostTensorPayload, type HostTensorPayload } from "../../execution/tensor-payload.js";
import { TENSOR_STORAGE_ENCODINGS, checkedElementBytes, tensorDType, type TensorDType } from "../../shared/tensor-dtype.js";
import type { ExecutableProgram, ProgramSlot, ProgramValue } from "../../execution/executable-program.js";
import { CpuArtifactLoader } from "./artifact-loader.js";
import { CPU_COMPUTATIONS, cpuKernel, type KernelExports } from "./kernel-catalogue.js";
import type { BackendDiagnostics, WasmVariant } from "./cpu-types.js";
import { InvocationStorage } from "./invocation-storage.js";
import { CpuAllocation, LinearMemoryAllocator, MAXIMUM_ADDRESS } from "./linear-memory.js";
import { pointwiseGeometry, receivingGeometry } from "../../execution/broadcast-geometry.js";
import { pointwiseFamily } from "../../execution/operation-contracts.js";
import { cpuPointwiseNeedsPacket, pointwisePacket, receivingPacket } from "./broadcast-packet.js";
import { indexSelectionBoundsError, indexSelectionGeometry } from "../../execution/index-selection.js";
import { axisReductionGeometry } from "../../execution/axis-geometry.js";
import { DEFAULT_CPU_LINEAR_MEMORY_BYTES, WEBASSEMBLY_PAGE_BYTES, type CpuMemoryCapacity } from "./memory-capacity.js";

export type { BackendDiagnostics, WasmVariant } from "./cpu-types.js";

interface BackendContext {
  readonly generation: number;
  readonly memory: WebAssembly.Memory;
  readonly exports: KernelExports;
  readonly allocator: LinearMemoryAllocator;
  readonly variant: WasmVariant;
  readonly maximumBytes: number;
  readonly capacity: CpuMemoryCapacity;
  poisoned: boolean;
}

export class WebAssemblyCpuBackend implements ExecutionBackend {
  readonly synchronousObservation = true;
  readonly capabilities: BackendCapabilities = Object.freeze({
    device: "cpu", storageEncodings: TENSOR_STORAGE_ENCODINGS, computations: CPU_COMPUTATIONS,
    gradients: true, maximumTensorBytes: MAXIMUM_ADDRESS,
  });
  readonly #artifactLoader: CpuArtifactLoader;
  #contextPromise: Promise<BackendContext> | undefined;
  #context: BackendContext | undefined;
  #generation = 0;
  #closed = false;
  #backendLoads = 0;
  #hostToWasmBytes = 0;
  #hostToWasmCopies = 0;
  #wasmToHostBytes = 0;
  #wasmToHostCopies = 0;
  #kernelCalls = 0;
  #selectedVariant: WasmVariant | null = null;
  readonly #timings = {
    manifestFetchMilliseconds: 0,
    moduleFetchMilliseconds: 0,
    integrityCheckMilliseconds: 0,
    compilationMilliseconds: 0,
    instantiationMilliseconds: 0,
  };

  constructor(manifestUrl: URL, forceVariant?: WasmVariant, linearMemoryBytes = DEFAULT_CPU_LINEAR_MEMORY_BYTES) {
    canonicalCpuCapabilities.set(this, this.capabilities);
    this.#artifactLoader = new CpuArtifactLoader(manifestUrl, forceVariant, this.#timings, linearMemoryBytes);
  }

  diagnostics(): BackendDiagnostics {
    return Object.freeze({
      cpuMemoryCapacity: this.#context?.capacity ?? null,
      backendLoads: this.#backendLoads,
      hostToWasmBytes: this.#hostToWasmBytes,
      hostToWasmCopies: this.#hostToWasmCopies,
      wasmToHostBytes: this.#wasmToHostBytes,
      wasmToHostCopies: this.#wasmToHostCopies,
      kernelCalls: this.#kernelCalls,
      liveAllocationBytes: this.#context?.allocator.livePayloadBytes ?? 0,
      highWaterAllocationBytes: this.#context?.allocator.highWaterPayloadBytes ?? 0,
      reservedAllocationBytes: this.#context?.allocator.liveReservedBytes ?? 0,
      highWaterReservedAllocationBytes:
        this.#context?.allocator.highWaterReservedBytes ?? 0,
      wasmMemoryBytes: this.#context?.memory.buffer.byteLength ?? 0,
      selectedVariant: this.#selectedVariant,
      timings: Object.freeze({ ...this.#timings }),
    });
  }

  /** Validate and retain the CPU context without allocating tensor payloads. */
  get ready(): boolean {
    return this.#context !== undefined && !this.#closed;
  }

  prepare(program?: ExecutableProgram): Promise<void> | undefined {
    this.#assertOpen();
    if (program !== undefined) assertBackendProgram(this.capabilities, program);
    if (this.#context !== undefined) return undefined;
    return this.#getContext().then(() => undefined);
  }

  execute(
    program: ExecutableProgram,
    bindings: ReadonlyMap<ProgramSlot, ProgramBinding>,
    retainedSlots: readonly boolean[],
  ): ReadonlyMap<ProgramSlot, ResidentAllocation> {
    const context = this.#requiredContext();
    assertBackendProgram(this.capabilities, program);
    if (context.poisoned) {
      throw new TabgradError(
        "BACKEND_TRAP",
        "The WebAssembly backend context is quarantined after a trap.",
        { backend: "webassembly-cpu", phase: "execution" },
      );
    }

    const storage = new InvocationStorage(context.allocator, program, bindings, retainedSlots);
    const { allocations } = storage;
    try {
      let hostValues: ProgramValue[] | undefined;
      for (const value of program.values) {
        if (value.source !== "binding") continue;
        const resident = bindings.get(value.slot)?.resident;
        if (resident === undefined) {
          (hostValues ??= []).push(value);
          continue;
        }
        this.#validateAllocation(context, resident);
        assertResidentTensor(resident.format, resident.byteLength, value.dtype, program.elementCount(value.slot));
        allocations.set(value.slot, resident);
      }
      if (hostValues !== undefined) for (const value of hostValues) {
        const payload = bindings.get(value.slot)?.hostData;
        if (payload === undefined) {
          throw new TabgradError(
            "BACKEND_STATUS_ERROR",
            "An executable input has no host or resident binding.",
            { backend: "webassembly-cpu", phase: "execution", slot: value.slot },
          );
        }
        const length = program.elementCount(value.slot);
        assertTensorPayload(payload, value.dtype, length);
        const format = tensorDType(value.dtype);
        const byteLength = checkedElementBytes(length, format.bytesPerElement);
        const allocation = context.allocator.allocate(byteLength, format);
        allocations.set(value.slot, allocation);
        new Uint8Array(context.memory.buffer, allocation.offset, byteLength).set(payload.bytes);
        this.#hostToWasmBytes += byteLength;
        this.#hostToWasmCopies += 1;
      }

      for (const computation of program.computations) {
        const inputs = computation.inputs.map((slot) => this.#requiredAllocation(
          allocations, program.values[slot]!.storageSlot,
        ));
        const value = program.values[computation.output];
        if (value === undefined) {
          throw new TabgradError(
            "BACKEND_STATUS_ERROR",
            "An executable computation references a missing output value.",
            {
              backend: "webassembly-cpu",
              phase: "execution",
              programValueSlot: computation.output,
              slot: computation.output,
            },
          );
        }
        const length = program.elementCount(value.slot);
        // Reserve the output before retiring inputs: kernels require disjoint
        // output storage, including at the final use of an input.
        const format = tensorDType(value.dtype);
        const output = context.allocator.allocate(checkedElementBytes(length, format.bytesPerElement), format);
        allocations.set(computation.output, output);
        const kernel = cpuKernel(computation.kind)!;
        const selection = kernel.layout === "indexSelection" ? indexSelectionGeometry(
          program.values[computation.inputs[0]!]!.shape, program.values[computation.inputs[1]!]!.shape, computation.selectionAxis!,
        ) : undefined;
        let parameters: Uint32Array | undefined;
        if (kernel.layout === "receiving") {
          parameters = receivingPacket(receivingGeometry(pointwiseGeometry([
            program.values[computation.inputs[0]!]!.shape, value.shape,
          ]), 1), context.maximumBytes);
        } else if ("dense" in kernel && cpuPointwiseNeedsPacket(program.values, computation.inputs, length)) {
          const family = pointwiseFamily(computation.kind)!;
          parameters = pointwisePacket(family.plan(computation.inputs.map(slot => program.values[slot]!.shape)), context.maximumBytes);
        }
        // Parameter construction/allocation is not a kernel trap. Create views
        // only after the last allocation that can grow and detach Wasm memory.
        let packet: CpuAllocation | undefined;
        if (parameters !== undefined) {
          packet = context.allocator.allocate(parameters.byteLength);
          try { new Uint32Array(context.memory.buffer, packet.offset, parameters.length).set(parameters); }
          catch (error) { context.allocator.release(packet); throw error; }
        }
        let status: number;
        try {
          if (selection === undefined ? length !== 0 || (kernel.layout !== "matrix" && kernel.layout !== "axisReduction")
            : selection.count !== 0) this.#kernelCalls += 1;
          switch (kernel.layout) {
            case "pointwise":
              status = packet === undefined
                ? context.exports[kernel.dense.name](inputs[0]!.offset, inputs[1]!.offset, output.offset, length)
                : context.exports[kernel.broadcast.name](inputs[0]!.offset, inputs[1]!.offset, output.offset, packet.offset, parameters!.length);
              break;
            case "ternaryPointwise":
              status = packet === undefined
                ? context.exports[kernel.dense.name](inputs[0]!.offset, inputs[1]!.offset, inputs[2]!.offset, output.offset, length)
                : context.exports[kernel.broadcast.name](inputs[0]!.offset, inputs[1]!.offset, inputs[2]!.offset, output.offset,
                  packet.offset, parameters!.length);
              break;
            case "receiving":
              status = context.exports[kernel.symbol.name](inputs[0]!.offset, output.offset, packet!.offset, parameters!.length);
              break;
            case "axisReduction": {
              if (length === 0) {
                status = 0;
                break;
              }
              const { groups, terms, inner } = axisReductionGeometry(program.values[computation.inputs[0]!]!.shape, computation.reduction!);
              status = context.exports[kernel.symbol.name](inputs[0]!.offset, output.offset, groups, terms, inner);
              break;
            }
            case "indexSelection": {
              const { boundLow, boundHigh, count, inner } = selection!;
              status = count === 0 ? 0 : context.exports[kernel.symbol.name](
                inputs[0]!.offset, inputs[1]!.offset, output.offset, boundLow, boundHigh, count, inner, length,
              );
              break;
            }
            case "matrix": {
              const left = program.values[computation.inputs[0]!]!.shape;
              const right = program.values[computation.inputs[1]!]!.shape;
              const flags = computation.matrixFlags!;
              // Empty output has no physical indices; preserve large unused axes.
              status = length === 0 ? 0 : context.exports[kernel.symbol.name](
                inputs[0]!.offset, inputs[1]!.offset, output.offset,
                left[flags & 1 ? 1 : 0]!, left[flags & 1 ? 0 : 1]!, right[flags & 2 ? 0 : 1]!, flags,
              );
              break;
            }
            case "coefficient":
              status = context.exports[kernel.symbol.name](
                inputs[0]!.offset, inputs[1]!.offset, output.offset, length, computation.alphaBits!,
              );
              break;
            case "outputLength":
              status = context.exports[kernel.symbol.name](inputs[0]!.offset, output.offset, length);
              break;
            case "inputLength":
              status = context.exports[kernel.symbol.name](
                inputs[0]!.offset, output.offset,
                program.elementCount(computation.inputs[0]!),
              );
              break;
          }
        } catch (error) {
          context.poisoned = true;
          throw new TabgradError(
            "BACKEND_TRAP",
            "The WebAssembly kernel trapped.",
            {
              backend: "webassembly-cpu",
              phase: "execution",
              operation: computation.kind,
              programValueSlot: computation.output,
            },
            error,
          );
        } finally { if (packet !== undefined) context.allocator.release(packet); }
        if (selection !== undefined && (status >>> 31) !== 0) {
          throw indexSelectionBoundsError(program.values[computation.inputs[0]!]!.shape, computation.selectionAxis!, {
            backend: "webassembly-cpu", phase: "execution", programValueSlot: computation.output,
          }, status & 0x7fff_ffff);
        }
        if (status !== 0) {
          throw new TabgradError(
            "BACKEND_STATUS_ERROR",
            "The WebAssembly kernel rejected its call.",
            {
              backend: "webassembly-cpu",
              phase: "execution",
              operation: computation.kind,
              programValueSlot: computation.output,
              status,
            },
          );
        }
        for (const input of computation.inputs) {
          storage.completeInputUse(program.values[input]!.storageSlot);
        }
      }
      return allocations;
    } catch (error) {
      storage.rollback();
      throw error;
    }
  }

  read(allocation: ResidentAllocation, length: number, dtype: TensorDType): HostTensorPayload {
    const context = this.#requiredContext();
    this.#validateAllocation(context, allocation);
    assertResidentTensor(allocation.format, allocation.byteLength, dtype, length);
    const bytes = new Uint8Array(context.memory.buffer, allocation.offset, allocation.byteLength).slice();
    this.#wasmToHostBytes += bytes.byteLength;
    this.#wasmToHostCopies += 1;
    return hostTensorPayload(dtype, length, bytes);
  }

  release(allocation: ResidentAllocation): void {
    const context = this.#context;
    if (context === undefined || (allocation instanceof CpuAllocation && allocation.released)) {
      return;
    }
    this.#validateAllocation(context, allocation);
    context.allocator.release(allocation);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#context = undefined;
    this.#contextPromise = undefined;
  }

  assertAvailable(): void { this.#assertOpen(); }

  #assertOpen(): void {
    if (this.#closed) {
      throw new TabgradError("CLOSED_SESSION", "The runtime session is closed.");
    }
  }

  async #getContext(): Promise<BackendContext> {
    this.#contextPromise ??= this.#loadContext();
    return this.#contextPromise;
  }

  #requiredContext(): BackendContext {
    this.#assertOpen();
    if (this.#context === undefined) {
      throw new TabgradError(
        "BACKEND_STATUS_ERROR",
        "The WebAssembly backend has not been initialized.",
      );
    }
    return this.#context;
  }

  async #loadContext(): Promise<BackendContext> {
    this.#backendLoads += 1;
    const artifact = await this.#artifactLoader.load();
    try {
      const context: BackendContext = {
        generation: ++this.#generation,
        memory: artifact.memory,
        exports: artifact.exports,
        allocator: new LinearMemoryAllocator(
          artifact.memory,
          artifact.arenaBase,
          artifact.capacity.linearMemoryLimitBytes / WEBASSEMBLY_PAGE_BYTES,
          artifact.alignment,
          this.#generation,
        ),
        variant: artifact.variant,
        maximumBytes: artifact.capacity.linearMemoryLimitBytes,
        capacity: artifact.capacity,
        poisoned: false,
      };
      this.#context = context;
      this.#selectedVariant = artifact.variant;
      return context;
    } catch (error) {
      throw this.#artifactLoader.asLoadError(error, "abi-validation");
    }
  }

  #validateAllocation(context: BackendContext, allocation: ResidentAllocation): asserts allocation is CpuAllocation {
    if (!context.allocator.owns(allocation) || allocation.released || allocation.generation !== context.generation) {
      throw new TabgradError(
        "BACKEND_STATUS_ERROR",
        "A foreign, stale or released WebAssembly allocation was used.",
      );
    }
  }

  #requiredAllocation(
    allocations: ReadonlyMap<ProgramSlot, CpuAllocation>,
    slot: ProgramSlot,
  ): CpuAllocation {
    const allocation = allocations.get(slot);
    if (allocation === undefined) {
      throw new TabgradError(
        "BACKEND_STATUS_ERROR",
        "An executable computation references an unbound value.",
        { slot },
      );
    }
    return allocation;
  }
}

// Capture in the defining module: an override before importing the runtime is
// still an override. The weak key does not extend a backend's lifetime.
const canonicalCpuCapabilities = new WeakMap<WebAssemblyCpuBackend, object>();
const canonicalCpuMethods = ["ready", "prepare", "execute", "release", "assertAvailable"].map(
  name => [name, Object.getOwnPropertyDescriptor(WebAssemblyCpuBackend.prototype, name)!] as const);
const canonicalCpuReady = Object.getOwnPropertyDescriptor(WebAssemblyCpuBackend.prototype, "ready")!.get!;

export function hasCanonicalCpuDispatch(backend: WebAssemblyCpuBackend): boolean {
  if (Object.getPrototypeOf(backend) !== WebAssemblyCpuBackend.prototype
    || Object.getPrototypeOf(WebAssemblyCpuBackend.prototype) !== Object.prototype
    || Object.getOwnPropertyDescriptor(backend, "capabilities")?.value !== canonicalCpuCapabilities.get(backend)
    || Object.getOwnPropertyDescriptor(backend, "synchronousObservation")?.value !== true) return false;
  for (const [name, expected] of canonicalCpuMethods) {
    const actual = Object.getOwnPropertyDescriptor(WebAssemblyCpuBackend.prototype, name);
    if (Object.hasOwn(backend, name) || actual === undefined
      || actual.value !== expected.value || actual.get !== expected.get || actual.set !== expected.set) return false;
  }
  return true;
}

/** Read private preparation state only after hasCanonicalCpuDispatch succeeds. */
export function isPreparedCanonicalCpuBackend(backend: WebAssemblyCpuBackend): boolean {
  return Reflect.apply(canonicalCpuReady, backend, []) === true;
}
