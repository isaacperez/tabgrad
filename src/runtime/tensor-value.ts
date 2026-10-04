import type { TensorDevice } from "../execution/backend.js";
import type { ProgramProvenance } from "../execution/executable-program.js";
import type { WriterOutcome } from "./writer-outcome.js";

/** Mutable version only: captured descriptors never retain a family current. */
export interface TensorVersionCounter { value: number; }

export interface TensorMetadata {
  readonly shape: readonly number[];
  readonly dtype: "float32";
  readonly device: TensorDevice;
  readonly layout: "contiguous";
}

export interface NumericalOperationDefinition {
  readonly name: "add" | "mul" | "sum" | "expand";
  readonly provenanceSource: "Tensor.add" | "Tensor.mul" | "Tensor.sum" | "DerivativeHistory.sum";
  readonly loweredKind: "add-f32" | "mul-f32" | "sum-f32" | "expand-f32";
  readonly pure: true;
}

export class TensorValue {
  readonly shape: readonly number[];
  readonly dtype: "float32";
  readonly device: TensorDevice;
  readonly layout: "contiguous";
  // Shape and provenance belong to this value; payload and producer ownership
  // are shared by every whole-storage alias.
  readonly storage: StorageState;
  readonly provenance: ProgramProvenance;
  references = 1;
  versionCounter: TensorVersionCounter | null = null;
  version = 0;
  outcomes: readonly WriterOutcome[] = [];

  constructor(metadata: TensorMetadata, producer: OperationRecord | null, storage?: StorageState) {
    this.shape = Object.freeze([...metadata.shape]);
    this.dtype = metadata.dtype;
    this.device = metadata.device;
    this.layout = metadata.layout;
    this.storage = storage ?? new StorageState(this, producer);
    this.provenance = storage !== undefined ? Object.freeze({ operation: "view", source: "Tensor.view" }) : producer?.provenance ?? Object.freeze({
      operation: "tensor",
      source: "RuntimeSession.tensor",
    });
  }

  get storageValue(): TensorValue { return this.storage.value; }
  get producer(): OperationRecord | null { return this.storage.producer; }
}

/** Shared whole-storage lifetime; the origin descriptor preserves producer metadata. */
export class StorageState {
  references = 1;
  constructor(readonly value: TensorValue, public producer: OperationRecord | null) {}
}

export class OperationRecord {
  readonly definition: NumericalOperationDefinition;
  readonly inputs: readonly TensorValue[];
  readonly provenance: ProgramProvenance;

  constructor(
    definition: NumericalOperationDefinition,
    inputs: readonly TensorValue[],
  ) {
    this.definition = definition;
    this.inputs = Object.freeze([...inputs]);
    this.provenance = Object.freeze({
      operation: definition.name,
      source: definition.provenanceSource,
    });
    Object.freeze(this);
  }
}
