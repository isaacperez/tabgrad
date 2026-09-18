/** One finite invocation's progression, distinct from its optional Promise observer. */
export interface QueuedExecutionRequest {
  next: QueuedExecutionRequest | undefined;
  advance(): void;
}

type Outcome<T> =
  | { readonly kind: "pending" }
  | { readonly kind: "success"; readonly value: T }
  | { readonly kind: "failure"; readonly error: unknown };

interface Completion<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Advance ordinary local steps immediately; yield only actual asynchronous work.
 * The session owns ordering and drain. No Promise is allocated for a completed
 * synchronous consumer, and a failure without an async observer cannot create
 * an unhandled rejection. Generator finalizers release the invocation's pins.
 */
export class ExecutionRequest<T> implements QueuedExecutionRequest {
  next: QueuedExecutionRequest | undefined;
  #steps: Generator<Promise<void>, T, void> | undefined;
  #waiting = false;
  #resumeFailure: { readonly error: unknown } | undefined;
  #outcome: Outcome<T> = { kind: "pending" };
  #completion: Completion<T> | undefined;
  readonly #advanceQueue: () => void;
  readonly #retire: () => void;

  constructor(
    steps: Generator<Promise<void>, T, void>,
    advanceQueue: () => void,
    retire: () => void,
  ) {
    this.#steps = steps;
    this.#advanceQueue = advanceQueue;
    this.#retire = retire;
  }

  advance(): void {
    if (this.#waiting || this.#steps === undefined) return;
    try {
      const failure = this.#resumeFailure;
      this.#resumeFailure = undefined;
      const step = failure === undefined
        ? this.#steps.next()
        : this.#steps.throw(failure.error);
      if (step.done) {
        this.#settle({ kind: "success", value: step.value });
      } else {
        this.#waiting = true;
        step.value.then(
          () => this.#resume(),
          (error: unknown) => this.#resume({ error }),
        );
      }
    } catch (error) {
      this.#settle({ kind: "failure", error });
    }
  }

  #resume(failure?: { readonly error: unknown }): void {
    this.#waiting = false;
    this.#resumeFailure = failure;
    this.#advanceQueue();
  }

  #settle(outcome: Exclude<Outcome<T>, { kind: "pending" }>): void {
    this.#outcome = outcome;
    this.#steps = undefined;
    this.#retire();
    if (outcome.kind === "success") this.#completion?.resolve(outcome.value);
    else this.#completion?.reject(outcome.error);
    this.#completion = undefined;
  }

  read(): T {
    if (this.#outcome.kind === "success") return this.#outcome.value;
    if (this.#outcome.kind === "failure") throw this.#outcome.error;
    throw new Error("The execution request has not reached a terminal result.");
  }

  asPromise(): Promise<T> {
    if (this.#outcome.kind === "success") return Promise.resolve(this.#outcome.value);
    if (this.#outcome.kind === "failure") return Promise.reject(this.#outcome.error);
    if (this.#completion === undefined) {
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((onSuccess, onFailure) => {
        resolve = onSuccess;
        reject = onFailure;
      });
      this.#completion = { promise, resolve, reject };
    }
    return this.#completion.promise;
  }
}
