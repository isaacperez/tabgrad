import type { ExecutableProgram, LoweredComputation, ProgramSlot } from "./executable-program.js";
import type { ExecutionTicket } from "./execution-ticket.js";

export type TensorDevice = "cpu" | "webgpu";

/** A physical identity interpreted only by its owning backend. */
export type ResidentAllocation = object;

export interface ProgramBinding {
  readonly hostData?: Float32Array;
  readonly resident?: ResidentAllocation;
}

/** One fixed operation domain; admission and preparation consult the same facts. */
export interface BackendCapabilities {
  readonly device: TensorDevice;
  readonly computations: readonly LoweredComputation["kind"][];
  readonly gradients: boolean;
  readonly maximumTensorBytes: number;
}

/** Synchronous backends need not allocate promises or use a worker transport. */
export interface ExecutionBackend {
  readonly capabilities: BackendCapabilities;
  readonly ready: boolean;
  assertAvailable(): void;
  prepare(program?: ExecutableProgram): Promise<void> | undefined;
  execute(program: ExecutableProgram, bindings: ReadonlyMap<ProgramSlot, ProgramBinding>, retainedSlots: readonly boolean[]):
    ReadonlyMap<ProgramSlot, ResidentAllocation> | ExecutionTicket<ReadonlyMap<ProgramSlot, ResidentAllocation>>;
  read(allocation: ResidentAllocation, length: number): Float32Array | ExecutionTicket<Float32Array>;
  release(allocation: ResidentAllocation): void;
  /** Joins physical work even when a result has already failed. */
  close(): Promise<void>;
}
