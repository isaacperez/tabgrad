import type { Tensor } from "./runtime.js";

/** Invocation-local identity selection; every method expires with the callback. */
export interface OptimizerCapture {
  hasGradient(occurrence: number): boolean;
  capture(occurrence: number): boolean;
  apply(alphaBits: number): void;
}

/** Internal semantic owner. It retains occurrences, never frontend wrappers. */
export interface OptimizerLease {
  assertOpen(): void;
  beginStep(): boolean;
  setRecording(recording: boolean): void;
  hasGradients(index: number): boolean;
  stepGroup(index: number, alphaBits: number): void;
  withGroup<Result>(index: number, callback: (capture: OptimizerCapture) => Result): Result;
  zeroGrad(setToNone: boolean): void;
  zeroGradGroup(index: number, setToNone: boolean): void;
  close(): void;
  finalize(): void;
}

export type OptimizerLeaseFactory = (groups: readonly (readonly Tensor[])[]) => OptimizerLease;
