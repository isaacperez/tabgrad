import { ExecutionTicket, type ExecutionStep } from "./execution-ticket.js";

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

interface PendingStep {
  readonly step: ExecutionStep;
  observed: boolean;
}

/**
 * Advance ordinary local steps immediately; yield only actual asynchronous work.
 * The session owns ordering and drain. No Promise is allocated for a completed
 * synchronous consumer, and a failure without an async observer cannot create
 * an unhandled rejection. Logical publication advances the queue; physical
 * retirement releases the invocation's pins only after all yielded tickets drain.
 */
export class ExecutionRequest<T> implements QueuedExecutionRequest {
  next: QueuedExecutionRequest | undefined;
  #steps: Generator<ExecutionStep, T, unknown> | undefined;
  #drains: ExecutionTicket<unknown>[] | undefined;
  #waiting: PendingStep | undefined;
  #input: Exclude<Outcome<unknown>, { kind: "pending" }> | undefined;
  #outcome: Outcome<T> = { kind: "pending" };
  #completion: Completion<T> | undefined;
  readonly #advanceQueue: () => void;
  readonly #retire: () => void;
  readonly #publish: () => void;

  constructor(
    steps: Generator<ExecutionStep, T, unknown>,
    advanceQueue: () => void,
    publish: () => void,
    retire: () => void,
  ) {
    this.#steps = steps;
    this.#advanceQueue = advanceQueue;
    this.#publish = publish;
    this.#retire = retire;
  }

  advance(): void {
    if (this.#waiting !== undefined || this.#steps === undefined) return;
    try {
      const input = this.#input;
      this.#input = undefined;
      const step = input?.kind === "failure"
        ? this.#steps.throw(input.error)
        : this.#steps.next(input?.value);
      if (step.done) {
        this.#settle({ kind: "success", value: step.value });
      } else {
        const pending = { step: step.value, observed: false };
        this.#waiting = pending;
        if (pending.step instanceof ExecutionTicket) {
          this.#drains ??= [];
          this.#drains.push(pending.step);
        }
        if (!(pending.step instanceof ExecutionTicket) || pending.step.synchronous === undefined || this.#completion !== undefined) {
          this.#observePending(pending);
        }
      }
    } catch (error) {
      this.#settle({ kind: "failure", error });
    }
  }

  #observePending(pending: PendingStep): void {
    if (pending.observed) return;
    pending.observed = true;
    const result = pending.step instanceof ExecutionTicket ? pending.step.result : pending.step;
    result.then(
      (value) => this.#resume(pending, { kind: "success", value }),
      (error: unknown) => this.#resume(pending, { kind: "failure", error }),
    );
  }

  #resume(pending: PendingStep, input: Exclude<Outcome<unknown>, { kind: "pending" }>): void {
    // A synchronous consumer may already have advanced this step. Its delayed
    // Promise notification must not resume a subsequent step or retired request.
    if (this.#waiting !== pending) return;
    this.#waiting = undefined;
    this.#input = input;
    this.#advanceQueue();
  }

  #settle(outcome: Exclude<Outcome<T>, { kind: "pending" }>): void {
    this.#outcome = outcome;
    this.#steps = undefined;
    this.#publish();
    const drains = this.#drains?.filter((ticket) => ticket.synchronous?.isDrained() !== true);
    if (drains === undefined || drains.length === 0) this.#retire();
    else retireAfterDrain(drains, this.#retire);
    this.#drains = undefined;
    if (outcome.kind === "success") this.#completion?.resolve(outcome.value);
    else this.#completion?.reject(outcome.error);
    this.#completion = undefined;
  }

  read(): T {
    while (this.#waiting !== undefined) {
      const pending = this.#waiting;
      if (!(pending.step instanceof ExecutionTicket) || pending.step.synchronous === undefined) break;
      const synchronous = pending.step.synchronous;
      let input: Exclude<Outcome<unknown>, { kind: "pending" }>;
      try {
        input = { kind: "success", value: synchronous.read() };
      } catch (error) {
        input = { kind: "failure", error };
      }
      this.#resume(pending, input);
    }
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
    if (this.#waiting !== undefined) this.#observePending(this.#waiting);
    return this.#completion.promise;
  }
}

/** Shared accounting need not enqueue interpreter-local Promise reactions. */
function retireAfterDrain(tickets: readonly ExecutionTicket<unknown>[], retire: () => void): void {
  let remaining = tickets.length;
  const drained = (): void => { if (--remaining === 0) retire(); };
  for (const ticket of tickets) {
    if (ticket.synchronous?.onDrained !== undefined) ticket.synchronous.onDrained(drained);
    else void ticket.drained.then(drained);
  }
}
