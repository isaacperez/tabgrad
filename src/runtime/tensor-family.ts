import type { RuntimeSession } from "./runtime.js";
import type { DerivativeNode } from "./autograd/derivative-history.js";
import { TensorValue } from "./tensor-value.js";

/** One current numerical pin per alias family, independent of public handles. */
export class TensorFamily {
  handles = 1;
  readonly versionCounter = { value: 0 };
  get version(): number { return this.versionCounter.value; }
  set version(value: number) { this.versionCounter.value = value; }
  constructor(public current: TensorValue, public history: DerivativeNode<TensorValue> | null,
    public requiresGrad: boolean) {
    current.versionCounter = this.versionCounter;
  }
}

export class TensorState {
  closed = false;
  readonly family: TensorFamily;
  readonly shape: readonly number[];
  readonly isView: boolean;
  viewHistory: DerivativeNode<TensorValue> | null;
  historyVersion: number;
  #snapshot: TensorValue;

  constructor(readonly session: RuntimeSession, value: TensorValue,
    history: DerivativeNode<TensorValue> | null, requiresGrad: boolean = history !== null,
    family: TensorFamily | undefined, readonly specialView: boolean,
    readonly resolveHistory: (state: TensorState) => DerivativeNode<TensorValue> | null) {
    this.family = family ?? new TensorFamily(value, history, requiresGrad);
    this.shape = value.shape;
    this.isView = family !== undefined;
    this.viewHistory = this.isView ? history : null;
    this.historyVersion = this.family.version;
    this.#snapshot = value;
  }

  get value(): TensorValue {
    if (!this.isView) return this.family.current;
    if (this.#snapshot.storage !== this.family.current.storage || this.#snapshot.version !== this.family.version
      || this.#snapshot.outcomes !== this.family.current.outcomes) {
      const current = this.family.current;
      this.#snapshot = new TensorValue({ ...current, shape: this.shape }, null, current.storage);
      this.#snapshot.references = 0;
      this.#snapshot.versionCounter = this.family.versionCounter;
      this.#snapshot.version = this.family.version;
      this.#snapshot.outcomes = current.outcomes;
    }
    return this.#snapshot;
  }

  get history(): DerivativeNode<TensorValue> | null { return this.resolveHistory(this); }
  get requiresGrad(): boolean { return this.family.requiresGrad; }
}
