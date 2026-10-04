import { TabgradError } from "../../shared/errors.js";
import { getRecordingMode, enterNoGradScope, restoreRecordingMode, observeTensorSynchronously, type RuntimeSession, type Tensor } from "../../runtime/runtime.js";
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
  constructor(readonly session: RuntimeSession) {}

  getRecordingMode(): boolean {
    return getRecordingMode(this.session);
  }

  enterNoGrad(): boolean {
    return enterNoGradScope(this.session);
  }

  exitNoGrad(previous: boolean): void {
    restoreRecordingMode(this.session, previous);
  }

  async runManaged(execute: () => Promise<unknown>): Promise<unknown> {
    this.#managedEntry = true;
    try {
      return await execute();
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
