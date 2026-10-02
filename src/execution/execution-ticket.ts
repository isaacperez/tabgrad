/**
 * Logical publication and accounted physical completion of one asynchronous step.
 * `drained` fulfills after cleanup or accounted terminal loss; errors belong to
 * `result`. It must not reject or imply confirmed hardware reclamation after loss.
 */
export interface SynchronousCompletion<T> {
  /** Wait for and consume the authoritative result without local callbacks. */
  read(): T;
  /** Accounted physical completion, independent of Promise delivery. */
  isDrained(): boolean;
  /** Deliver accounted drain once from authoritative shared-state advancement. */
  onDrained?(callback: () => void): void;
}

export class ExecutionTicket<T> {
  readonly #result: Promise<T> | (() => Promise<T>);
  readonly #drained: Promise<void> | (() => Promise<void>);
  #resultObserver: Promise<T> | undefined;
  #drainObserver: Promise<void> | undefined;
  constructor(
    result: Promise<T> | (() => Promise<T>),
    drained: Promise<void> | (() => Promise<void>),
    readonly synchronous?: SynchronousCompletion<T>,
  ) { this.#result = result; this.#drained = drained; }

  get result(): Promise<T> {
    this.#resultObserver ??= typeof this.#result === "function" ? this.#result() : this.#result;
    return this.#resultObserver;
  }

  get drained(): Promise<void> {
    this.#drainObserver ??= typeof this.#drained === "function" ? this.#drained() : this.#drained;
    return this.#drainObserver;
  }
}

export type ExecutionStep = Promise<unknown> | ExecutionTicket<unknown>;
