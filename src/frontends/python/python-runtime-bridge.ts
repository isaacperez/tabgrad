import { TabgradError, throwCleanupFailures } from "../../shared/errors.js";
import { getTensorIncomingIdentity, isTensorExposureOpen, acquireGradientExposure, gradientExposureNeedsCompletion, completeGradientExposure, getRecordingMode, enterNoGradScope, restoreRecordingMode, observeTensorSynchronously, completeRuntimeSession, shouldWarnUnretainedGradient, finalizeTensorExposure, registerOptimizerLease, isOptimizableParameter, type RuntimeSession, type Tensor } from "../../runtime/runtime.js";
import type { OptimizerLease } from "../../runtime/optimizer-lease.js";
import type { TensorDevice } from "../../execution/backend.js";

/** Structural subset of Pyodide's borrowed buffer protocol; no interpreter owner. */
interface PythonBuffer {
  getBuffer(type: "f32"): PythonBufferView;
}

interface PythonBufferView {
  readonly data: unknown;
  readonly offset: number;
  readonly format: string;
  readonly itemsize: number;
  readonly ndim: number;
  readonly shape: readonly number[];
  readonly c_contiguous: boolean;
  release(): void;
}

function boundedFloat32View(view: PythonBufferView): Float32Array {
  const length = view.shape[0];
  if (!(view.data instanceof Float32Array) || view.format !== "f" || view.itemsize !== 4
    || view.ndim !== 1 || view.shape.length !== 1 || !view.c_contiguous
    || length === undefined || !Number.isSafeInteger(length) || length < 0
    || !Number.isSafeInteger(view.offset) || view.offset < 0
    || view.offset > view.data.length || length > view.data.length - view.offset) {
    throw new TabgradError("INVALID_DATA", "Python input must expose a contiguous rank-one float32 buffer.");
  }
  return view.data.subarray(view.offset, view.offset + length);
}

/** @internal Translate buffer borrowing into an owned runtime tensor import. */
export class PythonRuntimeBridge {
  #managedEntry = false;
  readonly #exposureKeys = new WeakMap<object, number>();
  #nextExposureKey = 0;
  constructor(readonly session: RuntimeSession) {}

  registerSGD(groups: readonly (readonly Tensor[])[]): OptimizerLease {
    return registerOptimizerLease(this.session, groups);
  }

  isOptimizableParameter(handle: Tensor): boolean {
    return isOptimizableParameter(handle);
  }

  getRecordingMode(): boolean {
    return getRecordingMode(this.session);
  }

  enterNoGrad(): boolean {
    return enterNoGradScope(this.session);
  }

  exitNoGrad(previous: boolean): void {
    restoreRecordingMode(this.session, previous);
  }

  releaseExposure(handle: Tensor): void {
    finalizeTensorExposure(handle);
  }

  async runManaged(execute: () => Promise<unknown>): Promise<unknown> {
    this.#managedEntry = true;
    let result: unknown;
    let failures: unknown[] | undefined;
    try {
      try { result = await execute(); }
      catch (error) { (failures ??= []).push(error); }
      try { await completeRuntimeSession(this.session); }
      catch (error) { (failures ??= []).push(error); }
      throwCleanupFailures(failures, "Managed execution and mandatory effects failed.");
      return result;
    } finally {
      this.#managedEntry = false;
    }
  }

  observe(handle: unknown): Float32Array {
    if (!this.#managedEntry) {
      throw new TabgradError(
        "PYTHON_SYNC_CONTEXT_REQUIRED",
        "Ordinary Python observation requires an active managed script entry.",
      );
    }
    return observeTensorSynchronously(this.session, handle);
  }

  grad(output: Tensor, inputs: readonly Tensor[], gradient: Tensor | null): Tensor[] {
    return this.session.grad(output, inputs, gradient === null ? undefined : gradient);
  }

  resultNeedsCompletion(result: Tensor, canonical: Tensor): boolean {
    return gradientExposureNeedsCompletion(result, canonical);
  }

  completeGradient(handle: Tensor): void {
    if (!this.#managedEntry) {
      throw new TabgradError("PYTHON_SYNC_CONTEXT_REQUIRED", "Gradient completion requires an active managed script entry.");
    }
    completeGradientExposure(this.session, handle);
  }

  gradientExposure(handle: Tensor): Tensor | null { return acquireGradientExposure(handle); }

  exposureOpen(handle: Tensor): boolean { return isTensorExposureOpen(handle); }

  sameExposure(left: Tensor, right: Tensor): boolean { return left === right; }

  exposureKey(handle: Tensor): number {
    const identity = getTensorIncomingIdentity(handle);
    let key = this.#exposureKeys.get(identity);
    if (key === undefined) { key = this.#nextExposureKey++; this.#exposureKeys.set(identity, key); }
    return key;
  }

  shouldWarnGradient(handle: Tensor): boolean { return shouldWarnUnretainedGradient(handle); }

  backward(output: Tensor, inputs: readonly Tensor[] | null, gradient: Tensor | null): void {
    output.backward(gradient === null ? undefined : gradient,
      inputs === null ? undefined : { inputs });
  }

  view(handle: Tensor, shape: readonly (number | bigint)[]): Tensor {
    // Pyodide may transport built-in Python integers as bigint even inside
    // the safe-number domain. Normalize representation, not shape admission:
    // the shared runtime still owns lifecycle, integer-range and count checks.
    const dimensions = shape.map(dimension => typeof dimension === "bigint" ? Number(dimension) : dimension);
    return handle.view(dimensions);
  }

  tensorFromBuffer(buffer: PythonBuffer, shape?: readonly number[], requiresGrad = false, device: TensorDevice = "cpu"): Tensor {
    const view = buffer.getBuffer("f32");
    try {
      // Runtime import performs the owned copy synchronously. Neither this view
      // nor the argument proxy may escape into deferred numerical execution.
      return this.session.tensor(boundedFloat32View(view), { ...(shape === undefined ? {} : { shape }), requiresGrad, device });
    } finally {
      view.release();
    }
  }
}
