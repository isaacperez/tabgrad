import type { ExecutableProgram, LoweredComputation, ProgramSlot } from "./executable-program.js";
import type { ExecutionTicket } from "./execution-ticket.js";
import type { HostTensorPayload } from "./tensor-payload.js";
import { tensorDType, type TensorDType } from "../shared/tensor-dtype.js";
import { operationTypeContract, resolveTensorType } from "./operation-types.js";
import { TabgradError } from "../shared/errors.js";

export type TensorDevice = "cpu" | "webgpu";

/** A physical identity interpreted only by its owning backend. */
export type ResidentAllocation = object;

export interface ProgramBinding {
  readonly hostData?: HostTensorPayload;
  readonly resident?: ResidentAllocation;
}

/** One fixed operation domain; admission and preparation consult the same facts. */
export interface BackendCapabilities {
  readonly device: TensorDevice;
  readonly computations: readonly LoweredComputation["kind"][];
  /** Tracking, functional derivatives and persistent gradient state. */
  readonly gradients: boolean;
  readonly maximumTensorBytes: number;
}

/** Physical consumers also admit before compilation, upload or allocation. */
export function assertBackendProgram(capabilities: BackendCapabilities, program: ExecutableProgram): void {
  for (const value of program.values) {
    tensorDType(value.dtype);
    if (value.device !== capabilities.device) {
      throw new TabgradError("BACKEND_CAPABILITY_MISMATCH", "Program values require the selected backend's device.", {
        device: capabilities.device, phase: "preparation", programValueSlot: value.slot,
      });
    }
  }
  for (const computation of program.computations) {
    const contract = operationTypeContract(computation.kind);
    const dtype = contract === undefined ? undefined : resolveTensorType(contract.types, program.values, computation.inputs);
    if (contract === undefined || !capabilities.computations.includes(computation.kind)
      || dtype === undefined || !Number.isSafeInteger(computation.output) || computation.output < 0
      || dtype !== program.values[computation.output]?.dtype) {
      throw new TabgradError("BACKEND_CAPABILITY_MISMATCH", "The selected backend does not support this computation signature.", {
        device: capabilities.device, phase: "preparation", programValueSlot: computation.output,
      });
    }
  }
}

/** Synchronous backends need not allocate promises or use a worker transport. */
export interface ExecutionBackend {
  readonly capabilities: BackendCapabilities;
  readonly ready: boolean;
  readonly synchronousObservation: boolean;
  assertAvailable(): void;
  prepare(program?: ExecutableProgram): Promise<void> | ExecutionTicket<void> | undefined;
  execute(program: ExecutableProgram, bindings: ReadonlyMap<ProgramSlot, ProgramBinding>, retainedSlots: readonly boolean[]):
    ReadonlyMap<ProgramSlot, ResidentAllocation> | ExecutionTicket<ReadonlyMap<ProgramSlot, ResidentAllocation>>;
  read(allocation: ResidentAllocation, length: number, dtype: TensorDType): HostTensorPayload | ExecutionTicket<HostTensorPayload>;
  release(allocation: ResidentAllocation): void;
  /** Joins physical work even when a result has already failed. */
  close(): Promise<void>;
}
