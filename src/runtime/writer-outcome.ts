import { TabgradError } from "../shared/errors.js";

/** One causal error responsibility; snapshots may report it again after delivery. */
export interface EffectFailure {
  readonly error: unknown;
  delivered: boolean;
}

type WriterState =
  | { readonly kind: "pending" }
  | { readonly kind: "success" }
  | { readonly kind: "failure"; readonly failure: EffectFailure };

/** Payload-free captured publication state, with no producer or predecessor edge. */
export class WriterOutcome {
  references = 0;
  state: WriterState = { kind: "pending" };
  constructor(readonly ledger: WriterOutcomeLedger) {}
}

/** Session-local accounting of actual live control captures, never completed history. */
export class WriterOutcomeLedger {
  readonly live = new Set<WriterOutcome>();
  references = 0;
  create(): WriterOutcome { return new WriterOutcome(this); }
  retain(outcome: WriterOutcome): void {
    if (outcome.references++ === 0) this.live.add(outcome);
    this.references += 1;
  }
  release(outcome: WriterOutcome): void {
    outcome.references -= 1;
    this.references -= 1;
    if (outcome.references < 0 || this.references < 0) {
      throw new TabgradError("BACKEND_STATUS_ERROR", "A writer outcome was released twice.");
    }
    if (outcome.references === 0) this.live.delete(outcome);
  }
}

/** New consumers capture pending/failed outcomes once, rather than their graphs. */
const NO_WRITER_OUTCOMES: readonly WriterOutcome[] = Object.freeze([]);

export function captureWriterOutcomes(groups: readonly (readonly WriterOutcome[])[]): readonly WriterOutcome[] {
  // Pure arithmetic is the common case: do not allocate a control container
  // when no unresolved/failed writer crosses this boundary.
  if (!groups.some(group => group.some(outcome => outcome.state.kind !== "success"))) {
    return NO_WRITER_OUTCOMES;
  }
  const captured = new Set<WriterOutcome>();
  for (const group of groups) for (const outcome of group) {
    if (outcome.state.kind !== "success") captured.add(outcome);
  }
  return Object.freeze([...captured]);
}

export function retainWriterOutcomes(outcomes: readonly WriterOutcome[]): void {
  for (const outcome of outcomes) outcome.ledger.retain(outcome);
}

export function releaseWriterOutcomes(outcomes: readonly WriterOutcome[]): void {
  for (const outcome of outcomes) outcome.ledger.release(outcome);
}

/** Called on the ordered request path, after all admitted writers have published. */
export function failedWriterOutcome(outcomes: readonly WriterOutcome[]): EffectFailure | undefined {
  for (const outcome of outcomes) {
    if (outcome.state.kind === "pending") {
      throw new TabgradError("BACKEND_STATUS_ERROR", "A captured writer has not published its result.");
    }
    if (outcome.state.kind === "failure") return outcome.state.failure;
  }
  return undefined;
}
