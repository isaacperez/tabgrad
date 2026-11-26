import type { ExecutableProgram, LoweredComputation, ProgramSlot } from "./executable-program.js";
import type { ExecutionTicket } from "./execution-ticket.js";
import type { HostTensorPayload } from "./tensor-payload.js";
import { TENSOR_STORAGE_ENCODINGS, tensorDType, type TensorDType, type TensorEncoding } from "../shared/tensor-dtype.js";
import { computationSignature, type ComputationKind } from "./operation-contracts.js";
import { resolveTensorType } from "./operation-types.js";
import { TabgradError } from "../shared/errors.js";

export type TensorDevice = "cpu" | "webgpu";

/** A physical identity interpreted only by its owning backend. */
export type ResidentAllocation = object;

export interface ProgramBinding {
  readonly hostData?: HostTensorPayload;
  readonly resident?: ResidentAllocation;
}

/** Independent storage and computation domains for the selected backend. */
export interface BackendCapabilities {
  readonly device: TensorDevice;
  readonly storageEncodings: readonly TensorEncoding[];
  readonly computations: readonly LoweredComputation["kind"][];
  /** Tracking, functional derivatives and persistent gradient state. */
  readonly gradients: boolean;
  readonly maximumTensorBytes: number;
}

const storageIndexes = new WeakMap<readonly TensorEncoding[], ReadonlySet<TensorEncoding>>();
const computationIndexes = new WeakMap<readonly ComputationKind[], ReadonlySet<ComputationKind>>();

function backendComputations(capabilities: BackendCapabilities): ReadonlySet<ComputationKind> {
  const kinds = capabilities.computations;
  const cached = computationIndexes.get(kinds);
  if (cached !== undefined) return cached;
  const indexed = new Set(kinds);
  // Only runtime-owned immutable advertisements can reuse their index across calls.
  if (Object.isFrozen(kinds)) computationIndexes.set(kinds, indexed);
  return indexed;
}

export function supportsBackendComputation(capabilities: BackendCapabilities, kind: ComputationKind): boolean {
  return backendComputations(capabilities).has(kind);
}

function backendStorage(capabilities: BackendCapabilities): ReadonlySet<TensorEncoding> {
  const encodings = capabilities.storageEncodings;
  const cached = storageIndexes.get(encodings);
  if (cached !== undefined) return cached;
  const indexed = new Set(encodings);
  if (Object.isFrozen(encodings)) storageIndexes.set(encodings, indexed);
  return indexed;
}

function unsupportedStorage(capabilities: BackendCapabilities, encoding: TensorEncoding,
  context: { operation: string } | { phase: string; programValueSlot: ProgramSlot }): TabgradError {
  return new TabgradError("BACKEND_CAPABILITY_MISMATCH", "The selected backend does not support this tensor storage encoding.", {
    ...context, device: capabilities.device, encoding,
  });
}

export function assertBackendStorage(capabilities: BackendCapabilities, dtype: TensorDType, operation: string): void {
  const { encoding } = tensorDType(dtype);
  if (capabilities.storageEncodings !== TENSOR_STORAGE_ENCODINGS && !backendStorage(capabilities).has(encoding)) {
    throw unsupportedStorage(capabilities, encoding, { operation });
  }
}

/** Physical consumers also admit before compilation, upload or allocation. */
export function assertBackendProgram(capabilities: BackendCapabilities, program: ExecutableProgram): void {
  // The byte-oriented owners share the full format list. Only a narrower
  // advertisement needs a membership check for each already known dtype.
  const storage = capabilities.storageEncodings === TENSOR_STORAGE_ENCODINGS ? undefined : backendStorage(capabilities);
  for (const value of program.values) {
    const { encoding } = tensorDType(value.dtype);
    if (value.device !== capabilities.device) {
      throw new TabgradError("BACKEND_CAPABILITY_MISMATCH", "Program values require the selected backend's device.", {
        device: capabilities.device, phase: "preparation", programValueSlot: value.slot,
      });
    }
    if (storage !== undefined && !storage.has(encoding)) {
      throw unsupportedStorage(capabilities, encoding, { phase: "preparation", programValueSlot: value.slot });
    }
  }
  let supported: ReadonlySet<ComputationKind> | undefined;
  for (const computation of program.computations) {
    const contract = computationSignature(computation.kind);
    const dtype = contract === undefined ? undefined : resolveTensorType(contract.types, program.values, computation.inputs);
    if (contract === undefined || !(supported ??= backendComputations(capabilities)).has(computation.kind)
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
