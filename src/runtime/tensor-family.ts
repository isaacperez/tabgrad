import type { RuntimeSession, Tensor } from "./runtime.js";
import type { DerivativeNode } from "./autograd/derivative-history.js";
import { TensorValue } from "./tensor-value.js";
import { equalTensorShapes } from "./tensor-shape.js";
import { captureWriterOutcomes, type WriterOutcome } from "./writer-outcome.js";

/** Numerical aliases share one current value and mutation counter. */
export class TensorFamily {
  identities = 1;
  readonly versionCounter = { value: 0 };
  get version(): number { return this.versionCounter.value; }
  set version(value: number) { this.versionCounter.value = value; }
  constructor(public current: TensorValue) {
    current.versionCounter = this.versionCounter;
  }
}

/** Semantic ownership is independent of both numerical storage and public leases. */
export class TensorIdentity {
  /** Native incoming identity occurrences, independent of numerical alias members. */
  incomingIdentity: { owners: number };
  incomingDense = true;
  acquisitionFamily: TensorFamily | undefined;
  controls: readonly WriterOutcome[] = [];
  #snapshotControls: readonly WriterOutcome[] = [];
  gradient: TensorIdentity | null = null;
  canonical: WeakRef<Tensor> | undefined;
  exposures = 0;
  references = 0;
  retired = false;
  retained = false;
  readonly shape: readonly number[];
  historyVersion: number;
  #snapshot: TensorValue;
  constructor(readonly family: TensorFamily, value: TensorValue,
    public entry: DerivativeNode<TensorValue> | null, public requiresGrad: boolean,
    readonly base: TensorIdentity | null, readonly specialView: boolean,
    readonly trueLeaf: boolean = entry?.recipe === null) {
    this.shape = value.shape;
    this.historyVersion = family.version;
    this.#snapshot = value;
    this.incomingIdentity = { owners: 0 };
  }
  get isView(): boolean { return this.base !== null; }
  get value(): TensorValue {
    if (!this.isView && this.controls.length === 0 && equalTensorShapes(this.shape, this.family.current.shape)) return this.family.current;
    if (this.#snapshot.storage !== this.family.current.storage || this.#snapshot.version !== this.family.version
      || this.#snapshotControls !== this.controls || (this.controls.length === 0 && this.#snapshot.outcomes !== this.family.current.outcomes)) {
      const current = this.family.current;
      this.#snapshot = new TensorValue({ ...current, shape: this.shape }, null, current.storage);
      this.#snapshot.references = 0;
      this.#snapshot.versionCounter = this.family.versionCounter;
      this.#snapshot.version = this.family.version;
      this.#snapshot.outcomes = this.controls.length === 0 ? current.outcomes : captureWriterOutcomes([current.outcomes, this.controls]);
      this.#snapshotControls = this.controls;
    }
    return this.#snapshot;
  }
}

/** One independently closeable exposure of an otherwise retained identity. */
export class TensorState {
  closed = false;
  constructor(readonly session: RuntimeSession, readonly identity: TensorIdentity,
    readonly resolveHistory: (state: TensorState) => DerivativeNode<TensorValue> | null) {}
  get family(): TensorFamily { return this.identity.family; }
  get shape(): readonly number[] { return this.identity.shape; }
  get isView(): boolean { return this.identity.isView; }
  get specialView(): boolean { return this.identity.specialView; }
  get viewHistory(): DerivativeNode<TensorValue> | null { return this.identity.entry; }
  set viewHistory(value: DerivativeNode<TensorValue> | null) { this.identity.entry = value; }
  get historyVersion(): number { return this.identity.historyVersion; }
  set historyVersion(value: number) { this.identity.historyVersion = value; }
  get value(): TensorValue { return this.identity.value; }
  get history(): DerivativeNode<TensorValue> | null { return this.resolveHistory(this); }
  get requiresGrad(): boolean {
    let identity: TensorIdentity | null = this.identity;
    while (identity !== null) {
      if (identity.requiresGrad) return true;
      identity = identity.base;
    }
    return false;
  }
}
