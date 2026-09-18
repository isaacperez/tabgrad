import { TabgradError } from "./errors.js";
import type { PythonBinding } from "./python.js";
import { describePythonFailure, isPythonFailure, isRecord, PythonWorkerError } from "./python-worker-errors.js";

interface Completion {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

function completion(): Completion {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}

function connectionLost(cause: unknown): TabgradError {
  return new TabgradError("PYTHON_CONNECTION_LOST", "The Python worker connection failed; cleanup is not acknowledged.", {}, cause);
}

// A consumed port must never acquire another protocol receiver, including after close.
const OWNED_PORTS = new WeakSet<MessagePort>();
const SERVED_BINDINGS = new WeakSet<PythonBinding>();

function reservePort(port: MessagePort): void {
  if (OWNED_PORTS.has(port)) {
    throw new TabgradError("PYTHON_CONNECTION_IN_USE", "The message port already belongs to a Python connection.");
  }
  OWNED_PORTS.add(port);
}

/** Own one dedicated port, its listeners and optional host-reported loss signal. */
abstract class PythonConnection {
  protected readonly port: MessagePort;
  readonly #signal: AbortSignal | undefined;
  readonly #message = (event: MessageEvent<unknown>): void => {
    try { this.receive(event.data); } catch (error) { this.lost(error); }
  };
  readonly #messageError = (): void => this.lost(new Error("Python connection message could not be decoded."));
  readonly #abort = (): void => this.lost(this.#signal?.reason);

  constructor(port: MessagePort, signal: AbortSignal | undefined) {
    reservePort(port);
    this.port = port;
    this.#signal = signal;
  }

  protected start(): void {
    this.port.addEventListener("message", this.#message);
    this.port.addEventListener("messageerror", this.#messageError);
    this.#signal?.addEventListener("abort", this.#abort, { once: true });
    this.port.start();
    if (this.#signal?.aborted) this.#abort();
  }

  protected release(): void {
    this.port.removeEventListener("message", this.#message);
    this.port.removeEventListener("messageerror", this.#messageError);
    this.#signal?.removeEventListener("abort", this.#abort);
    this.port.close();
  }

  protected abstract receive(value: unknown): void;
  protected abstract lost(cause: unknown): void;
}

class PythonWorkerClient extends PythonConnection implements PythonBinding {
  #sequence = 0;
  #pending: Completion | undefined;
  #running: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #failure: TabgradError | undefined;

  constructor(port: MessagePort, signal: AbortSignal | undefined) {
    super(port, signal);
    this.start();
  }

  runPythonAsync(source: string): Promise<void> {
    if (this.#closing !== undefined || this.#failure !== undefined) {
      return Promise.reject(new TabgradError("CLOSED_PYTHON_BINDING", "The Python worker binding is closed."));
    }
    if (this.#running !== undefined) {
      return Promise.reject(new TabgradError("PYTHON_ENTRY_BUSY", "A managed Python script is already running."));
    }
    if (typeof source !== "string") return Promise.reject(new TypeError("Python source must be a string."));
    const running = this.#request({ kind: "run", source }).finally(() => {
      if (this.#running === running) this.#running = undefined;
    });
    this.#running = running;
    return running;
  }

  close(): Promise<void> {
    this.#closing ??= this.#drain();
    return this.#closing;
  }

  async #drain(): Promise<void> {
    await this.#running?.catch(() => undefined);
    if (this.#failure !== undefined) throw this.#failure;
    try { await this.#request({ kind: "close" }); } finally { this.release(); }
  }

  #request(command: { kind: "run"; source: string } | { kind: "close" }): Promise<void> {
    const pending = completion();
    this.#pending = pending;
    try {
      if (this.#sequence === Number.MAX_SAFE_INTEGER) throw new Error("Python connection sequence exhausted.");
      this.port.postMessage({ ...command, id: ++this.#sequence });
    } catch (error) { this.lost(error); }
    return pending.promise;
  }

  protected receive(value: unknown): void {
    if (!isRecord(value) || value.id !== this.#sequence || this.#pending === undefined
      || (value.ok !== true && (value.ok !== false || !isPythonFailure(value.error)))) {
      throw new Error("Unexpected Python worker reply.");
    }
    const pending = this.#pending;
    // Decode before releasing ownership so malformed diagnostic data cannot strand it.
    const error = value.ok === false && isPythonFailure(value.error)
      ? PythonWorkerError.fromFailure(value.error) : undefined;
    this.#pending = undefined;
    if (error === undefined) pending.resolve();
    else pending.reject(error);
  }

  protected lost(cause: unknown): void {
    this.#failure ??= connectionLost(cause);
    this.#pending?.reject(this.#failure);
    this.#pending = undefined;
    this.release();
  }
}

class PythonWorkerService extends PythonConnection {
  readonly #binding: PythonBinding;
  readonly #finished = completion();
  #sequence = 0;
  #running: Promise<void> | undefined;
  #closing = false;
  #loss: TabgradError | undefined;

  constructor(binding: PythonBinding, port: MessagePort, signal: AbortSignal | undefined) {
    super(port, signal);
    this.#binding = binding;
    this.start();
  }

  get finished(): Promise<void> { return this.#finished.promise; }

  protected receive(value: unknown): void {
    if (!isRecord(value) || !Number.isSafeInteger(value.id) || value.id !== this.#sequence + 1
      || this.#closing || this.#running !== undefined
      || (value.kind !== "close" && (value.kind !== "run" || typeof value.source !== "string"))) {
      throw new Error("Unexpected Python host command.");
    }
    const id = ++this.#sequence;
    if (value.kind === "close") {
      this.#closing = true;
      void this.#close(id);
    } else {
      // The validated source belongs to one invocation; no tensor crosses this port.
      const source = value.source;
      if (typeof source !== "string") throw new TypeError("Python source must be a string.");
      this.#running = Promise.resolve().then(() => this.#run(id, source));
    }
  }

  async #run(id: number, source: string): Promise<void> {
    let failure: unknown;
    let ok = false;
    try { await this.#binding.runPythonAsync(source); ok = true; } catch (error) { failure = error; }
    this.#running = undefined;
    if (!this.#closing) {
      try { this.#reply(id, ok, failure); } catch (error) { this.lost(error); }
    }
  }

  #reply(id: number, ok: boolean, error: unknown): void {
    this.port.postMessage(ok ? { id, ok: true } : { id, ok: false, error: describePythonFailure(error) });
  }

  async #close(id?: number): Promise<void> {
    let failure: unknown;
    let ok = false;
    try {
      await this.#running;
      await this.#binding.close();
      ok = true;
    } catch (error) { failure = error; }
    if (id !== undefined && this.#loss === undefined) {
      try { this.#reply(id, ok, failure); } catch (error) { this.#loss = connectionLost(error); }
    }
    this.release();
    SERVED_BINDINGS.delete(this.#binding);
    if (this.#loss !== undefined) {
      this.#finished.reject(ok ? this.#loss : new AggregateError([this.#loss, failure], "Python connection and cleanup failed."));
    }
    else if (!ok) this.#finished.reject(failure);
    else this.#finished.resolve();
  }

  protected lost(cause: unknown): void {
    this.#loss ??= connectionLost(cause);
    this.release();
    if (this.#closing) return;
    this.#closing = true;
    void this.#close();
  }
}

/**
 * Own a dedicated host-side port and admit scripts before worker dispatch.
 * The host owns the worker and must report known connection loss through signal.
 * No interpreter is loaded, moved or terminated. Close requires a remote acknowledgment.
 */
export function connectPythonWorker(port: MessagePort, signal?: AbortSignal): PythonBinding {
  return Object.freeze(new PythonWorkerClient(port, signal));
}

/**
 * In the interpreter worker, expose one local binding on a dedicated port.
 * Takes responsibility for binding.close(), not for interpreter/worker shutdown.
 * The returned Promise settles after local drain and port release; observe rejections.
 */
export function servePythonWorker(binding: PythonBinding, port: MessagePort, signal?: AbortSignal): Promise<void> {
  if (SERVED_BINDINGS.has(binding)) {
    throw new TabgradError("PYTHON_CONNECTION_IN_USE", "The binding already has a worker connection.");
  }
  SERVED_BINDINGS.add(binding);
  try { return new PythonWorkerService(binding, port, signal).finished; }
  catch (error) { SERVED_BINDINGS.delete(binding); throw error; }
}
