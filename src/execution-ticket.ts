/**
 * Logical publication and accounted physical completion of one asynchronous step.
 * `drained` fulfills after cleanup or accounted terminal loss; errors belong to
 * `result`. It must not reject or imply confirmed hardware reclamation after loss.
 */
export class ExecutionTicket<T> {
  constructor(readonly result: Promise<T>, readonly drained: Promise<void>) {}
}

export type ExecutionStep = Promise<void> | ExecutionTicket<void>;
