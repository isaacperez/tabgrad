import { TabgradError } from "../../shared/errors.js";
import type { BackendCapabilities, ExecutionBackend, ProgramBinding, ResidentAllocation } from "../../execution/backend.js";
import type { ExecutableProgram, ProgramSlot } from "../../execution/executable-program.js";
import { tensorElementCount } from "../../runtime/tensor-shape.js";
import { CpuArtifactLoader, type KernelExports } from "./artifact-loader.js";
import type { BackendDiagnostics, WasmVariant } from "./cpu-types.js";
import { InvocationStorage } from "./invocation-storage.js";
import { CpuAllocation, LinearMemoryAllocator, MAXIMUM_ADDRESS } from "./linear-memory.js";

export type { BackendDiagnostics, WasmVariant } from "./cpu-types.js";

interface BackendContext {
  readonly generation: number;
  readonly memory: WebAssembly.Memory;
  readonly exports: KernelExports;
  readonly allocator: LinearMemoryAllocator;
  readonly variant: WasmVariant;
  poisoned: boolean;
}

export class WebAssemblyCpuBackend implements ExecutionBackend {
  readonly synchronousObservation = true;
  readonly capabilities: BackendCapabilities = Object.freeze({
    device: "cpu", computations: Object.freeze(["add-f32", "add-alpha-f32", "mul-f32", "sum-f32", "expand-f32"] as const),
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

  constructor(manifestUrl: URL, forceVariant?: WasmVariant) {
    this.#artifactLoader = new CpuArtifactLoader(manifestUrl, forceVariant, this.#timings);
  }

  diagnostics(): BackendDiagnostics {
    return Object.freeze({
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

  prepare(): Promise<void> | undefined {
    this.#assertOpen();
    if (this.#context !== undefined) return undefined;
    return this.#getContext().then(() => undefined);
  }

  execute(
    program: ExecutableProgram,
    bindings: ReadonlyMap<ProgramSlot, ProgramBinding>,
    retainedSlots: readonly boolean[],
  ): ReadonlyMap<ProgramSlot, ResidentAllocation> {
    const context = this.#requiredContext();
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
      for (const value of program.values) {
        if (value.source !== "binding") continue;
        const binding = bindings.get(value.slot);
        if (binding?.resident !== undefined) {
          this.#validateAllocation(context, binding.resident);
          allocations.set(value.slot, binding.resident);
          continue;
        }
        const length = tensorElementCount(value.shape);
        const byteLength = length * Float32Array.BYTES_PER_ELEMENT;
        const allocation = context.allocator.allocate(byteLength);
        allocations.set(value.slot, allocation);
        if (binding?.hostData !== undefined) {
          this.#floatView(context.memory, allocation, length).set(binding.hostData);
          this.#hostToWasmBytes += byteLength;
          this.#hostToWasmCopies += 1;
        } else if (value.source === "binding") {
          throw new TabgradError(
            "BACKEND_STATUS_ERROR",
            "An executable input has no host or resident binding.",
            { backend: "webassembly-cpu", phase: "execution", slot: value.slot },
          );
        }
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
        const length = tensorElementCount(value.shape);
        // Reserve the output before retiring inputs: kernels require disjoint
        // output storage, including at the final use of an input.
        const output = context.allocator.allocate(length * Float32Array.BYTES_PER_ELEMENT);
        allocations.set(computation.output, output);
        let status: number;
        try {
          this.#kernelCalls += 1;
          switch (computation.kind) {
            case "add-alpha-f32":
              status = context.exports.tabgrad_add_alpha_f32(
                inputs[0]!.offset, inputs[1]!.offset, output.offset, length, computation.alphaBits!,
              );
              break;
            case "expand-f32":
              status = context.exports.tabgrad_expand_f32(inputs[0]!.offset, output.offset, length);
              break;
            case "add-f32":
              status = context.exports.tabgrad_add_f32(
                inputs[0]!.offset, inputs[1]!.offset, output.offset, length,
              );
              break;
            case "sum-f32":
              status = context.exports.tabgrad_sum_f32(
                inputs[0]!.offset, output.offset,
                tensorElementCount(program.values[computation.inputs[0]!]!.shape),
              );
              break;
            case "mul-f32":
              status = context.exports.tabgrad_mul_f32(
                inputs[0]!.offset, inputs[1]!.offset, output.offset, length,
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

  read(allocation: ResidentAllocation, length: number): Float32Array {
    const context = this.#requiredContext();
    this.#validateAllocation(context, allocation);
    const result = this.#floatView(context.memory, allocation, length).slice();
    this.#wasmToHostBytes += result.byteLength;
    this.#wasmToHostCopies += 1;
    return result;
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
          artifact.maximumPages,
          artifact.alignment,
          this.#generation,
        ),
        variant: artifact.variant,
        poisoned: false,
      };
      this.#context = context;
      this.#selectedVariant = artifact.variant;
      return context;
    } catch (error) {
      throw this.#artifactLoader.asLoadError(error, "abi-validation");
    }
  }

  #floatView(
    memory: WebAssembly.Memory,
    allocation: CpuAllocation,
    length: number,
  ): Float32Array {
    return new Float32Array(memory.buffer, allocation.offset, length);
  }

  #validateAllocation(context: BackendContext, allocation: ResidentAllocation): asserts allocation is CpuAllocation {
    if (!(allocation instanceof CpuAllocation) || allocation.released || allocation.generation !== context.generation) {
      throw new TabgradError(
        "BACKEND_STATUS_ERROR",
        "A stale or released WebAssembly allocation was used.",
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
