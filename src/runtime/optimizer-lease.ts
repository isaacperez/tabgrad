import type { Tensor } from "./runtime.js";

/** Internal semantic owner. It retains occurrences, never frontend wrappers. */
export interface OptimizerLease {
  assertOpen(): void;
  beginStep(): boolean;
  setRecording(recording: boolean): void;
  hasGradients(index: number): boolean;
  stepGroup(index: number, alphaBits: number): void;
  zeroGrad(setToNone: boolean): void;
  close(): void;
  finalize(): void;
}

export type OptimizerLeaseFactory = (groups: readonly (readonly Tensor[])[]) => OptimizerLease;
