import type { BackendCapabilities } from "./backend.js";
import { TabgradError } from "./errors.js";
import { isRecord } from "./python-worker-errors.js";
import type { WebGpuDiagnostics } from "./webgpu-backend.js";
import { GPU_ACCOUNTED, GPU_CONTROL_LENGTH, GPU_METRIC_LENGTH, retireGpuConnection, type WebGpuConnection, type WebGpuConnectionData } from "./webgpu-connection.js";

export type { WebGpuConnection } from "./webgpu-connection.js";

export interface WebGpuWorkerOptions {
  /** Compatible packaged worker location under the application's CSP. */
  readonly workerUrl?: URL;
  /** Setup cancellation and, after readiness, lifetime revocation. */
  readonly signal?: AbortSignal;
}

export interface WebGpuWorkerController {
  readonly connection: WebGpuConnection;
  readonly transferables: readonly Transferable[];
  /** Revoke GPU service, then join cleanup or report accounted worker loss. */
  close(): Promise<void>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onSuccess, onFailure) => { resolve = onSuccess; reject = onFailure; });
  return { promise, resolve, reject };
}

function setupCancelled(signal: AbortSignal): TabgradError {
  return new TabgradError("BACKEND_LOAD_FAILED", "WebGPU worker setup was cancelled.", {
    backend: "webgpu", phase: "worker-setup",
  }, signal.reason);
}

/** Host-side supervision never depends on interpreter callbacks. */
class GpuWorkerController implements WebGpuWorkerController {
  readonly #worker: Worker;
  readonly #control = new Int32Array(new SharedArrayBuffer(GPU_CONTROL_LENGTH * Int32Array.BYTES_PER_ELEMENT));
  readonly #channel = new MessageChannel();
  readonly #supervision = new MessageChannel();
  readonly #metrics = new SharedArrayBuffer(GPU_METRIC_LENGTH * BigInt64Array.BYTES_PER_ELEMENT);
  readonly #setup = deferred<WebGpuWorkerController>();
  readonly #cleanup = deferred<void>();
  readonly #signal: AbortSignal | undefined;
  #connection: WebGpuConnectionData | undefined;
  #closing = false;
  #finished = false;

  constructor(options: WebGpuWorkerOptions) {
    this.#signal = options.signal;
    try {
      this.#worker = new Worker(options.workerUrl ?? new URL("./webgpu-worker.js", import.meta.url), { type: "module" });
    } catch (error) {
      this.#channel.port1.close();
      this.#channel.port2.close();
      this.#supervision.port1.close();
      this.#supervision.port2.close();
      throw error;
    }
    this.#worker.addEventListener("message", this.#onMessage);
    this.#worker.addEventListener("error", this.#onFailure);
    this.#worker.addEventListener("messageerror", this.#onFailure);
    this.#signal?.addEventListener("abort", this.#onAbort, { once: true });
    // Cleanup remains independently owned even when setup rejects before late
    // acquisition settles. The returned close Promise still reports its error.
    void this.#cleanup.promise.catch(() => undefined);
    try {
      this.#worker.postMessage({ kind: "initialize", port: this.#channel.port1, control: this.#control.buffer, metrics: this.#metrics }, [this.#channel.port1]);
      if (this.#signal?.aborted) this.#onAbort();
    } catch (error) {
      this.#lost(error);
    }
  }

  ready(): Promise<WebGpuWorkerController> { return this.#setup.promise; }

  get connection(): WebGpuConnection {
    if (this.#connection === undefined) throw new Error("The WebGPU worker is not ready.");
    return this.#connection;
  }

  get transferables(): readonly Transferable[] { return Object.freeze([this.#channel.port2, this.#supervision.port2]); }

  close(): Promise<void> {
    if (!this.#closing && !this.#finished) {
      this.#closing = true;
      retireGpuConnection(this.#control);
      this.#supervision.port1.postMessage({ kind: "progress" });
      try { this.#worker.postMessage({ kind: "close" }); }
      catch (error) { this.#lost(error); }
    }
    return this.#cleanup.promise;
  }

  readonly #onAbort = (): void => {
    if (this.#connection === undefined && this.#signal !== undefined) this.#setup.reject(setupCancelled(this.#signal));
    void this.close();
  };

  readonly #onFailure = (): void => {
    this.#lost(new TabgradError("BACKEND_STATUS_ERROR", "The WebGPU worker failed without a drain acknowledgment.", {
      backend: "webgpu", phase: "worker-loss", physicalCompletion: "unknown",
    }));
  };

  readonly #onMessage = (event: MessageEvent<unknown>): void => {
    if (this.#finished || !isRecord(event.data)) return;
    const message = event.data;
    if (message.kind === "ready") {
      if (this.#closing || this.#connection !== undefined) return;
      if (!isRecord(message.capabilities) || !isRecord(message.diagnostics)
        || message.capabilities.device !== "webgpu" || !Array.isArray(message.capabilities.computations)
        || !message.capabilities.computations.every((computation: unknown) => typeof computation === "string")
        || typeof message.capabilities.gradients !== "boolean"
        || typeof message.capabilities.maximumTensorBytes !== "number"
        || !Number.isSafeInteger(message.capabilities.maximumTensorBytes) || message.capabilities.maximumTensorBytes < 0) {
        this.#setup.reject(new TabgradError("BACKEND_LOAD_FAILED", "The GPU worker returned invalid readiness data."));
        void this.close();
        return;
      }
      this.#connection = Object.freeze({ connectionType: "tabgrad-webgpu", protocolVersion: 1,
        port: this.#channel.port2, control: this.#control.buffer as SharedArrayBuffer,
        supervision: this.#supervision.port2, metrics: this.#metrics,
        capabilities: message.capabilities as unknown as BackendCapabilities,
        diagnostics: message.diagnostics as unknown as WebGpuDiagnostics });
      this.#setup.resolve(this);
    } else if (message.kind === "closed") {
      if (this.#connection === undefined) {
        this.#setup.reject(new TabgradError("BACKEND_LOAD_FAILED", "The GPU worker closed before readiness."));
      }
      this.#finish();
      this.#cleanup.resolve();
    } else if (message.kind === "lost") {
      this.#onFailure();
    } else if (message.kind === "failure") {
      this.#setup.reject(new TabgradError("BACKEND_LOAD_FAILED", "GPU worker acquisition or execution failed.", {
        backend: "webgpu", phase: "worker-setup",
      }));
      void this.close();
    }
  };

  #lost(error: unknown): void {
    this.#setup.reject(error);
    this.#finish(2);
    this.#cleanup.reject(error);
  }

  #finish(accounted = 1): void {
    if (this.#finished) return;
    this.#finished = true;
    Atomics.store(this.#control, GPU_ACCOUNTED, accounted);
    retireGpuConnection(this.#control);
    this.#supervision.port1.postMessage({ kind: "progress" });
    this.#signal?.removeEventListener("abort", this.#onAbort);
    this.#worker.removeEventListener("message", this.#onMessage);
    this.#worker.removeEventListener("error", this.#onFailure);
    this.#worker.removeEventListener("messageerror", this.#onFailure);
    this.#channel.port1.close();
    this.#channel.port2.close();
    this.#supervision.port1.close();
    this.#supervision.port2.close();
    this.#worker.terminate();
  }
}

/** Acquire one independently supervised physical GPU worker for managed Python. */
export async function createWebGpuWorker(options: WebGpuWorkerOptions = {}): Promise<WebGpuWorkerController> {
  if (globalThis.isSecureContext !== true || globalThis.crossOriginIsolated !== true
    || typeof SharedArrayBuffer === "undefined" || typeof Worker === "undefined") {
    throw new TabgradError("UNSUPPORTED_DEVICE", "Managed WebGPU requires secure, cross-origin-isolated worker hosting.", {
      device: "webgpu", backend: "webgpu", phase: "worker-setup",
    });
  }
  if (options.signal?.aborted) throw setupCancelled(options.signal);
  return new GpuWorkerController(options).ready();
}
