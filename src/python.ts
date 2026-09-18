import { TabgradError } from "./errors.js";
import { loadPythonSources, type PythonSources } from "./python-assets.js";
import { PythonInstallation } from "./python-installation.js";
import { PythonRuntimeBridge } from "./python-runtime-bridge.js";
import { createRuntimeSession, prepareRuntimeSession, type RuntimeSession } from "./runtime.js";

export { connectPythonWorker, servePythonWorker } from "./python-worker.js";
export { PythonWorkerError } from "./python-worker-errors.js";

/** The dictionary-proxy methods consumed when running bootstrap code in isolation. */
export interface PythonNamespace {
  set(key: string, value: unknown): void;
  destroy(): void;
}

/**
 * The browser-facing subset consumed from a prepared Pyodide interpreter.
 * Structural typing avoids importing Pyodide's Node-specific declarations.
 */
export interface PythonInterpreter {
  readonly version: string;
  runPython(source: string, options?: { globals?: PythonNamespace }): unknown;
  runPythonAsync(source: string): Promise<unknown>;
  readonly ffi: {
    readonly PyProxy: abstract new (...args: never[]) => { destroy(): void };
  };
}

/** A host-owned interpreter's connection to one Tabgrad runtime session. */
export interface PythonBinding {
  /**
   * Prepare CPU once, then execute in host globals, releasing any returned proxy.
   * Rejects overlap and closed bindings. The host must not drive the interpreter
   * concurrently, and scripts must join their tasks before returning.
   */
  runPythonAsync(source: string): Promise<void>;
  /**
   * Reject new entries, await accepted preparation and script, then drain the session.
   * Repeated calls share completion; the interpreter and host globals survive.
   * Cooperative close cannot interrupt a script that never settles.
   */
  close(): Promise<void>;
}

const ATTACHED_INTERPRETERS = new WeakSet<PythonInterpreter>();

/** Host-controlled location for the matching static Python artifact set. */
export interface PythonBindingOptions {
  readonly manifestUrl?: URL;
}

class InterpreterBinding implements PythonBinding {
  readonly #interpreter: PythonInterpreter;
  readonly #session: RuntimeSession;
  readonly #bridge: PythonRuntimeBridge;
  #installation: PythonInstallation | undefined;
  #closing: Promise<void> | undefined;
  #running: Promise<void> | undefined;

  constructor(interpreter: PythonInterpreter) {
    this.#interpreter = interpreter;
    this.#session = createRuntimeSession();
    this.#bridge = new PythonRuntimeBridge(this.#session);
    Object.freeze(this.#bridge);
  }

  install(sources: PythonSources): void {
    this.#installation = new PythonInstallation(this.#interpreter, sources, this.#bridge);
  }

  runPythonAsync(source: string): Promise<void> {
    if (this.#closing !== undefined) {
      return Promise.reject(new TabgradError(
        "CLOSED_PYTHON_BINDING", "The Python binding is closed.",
      ));
    }
    if (this.#running !== undefined) {
      return Promise.reject(new TabgradError(
        "PYTHON_ENTRY_BUSY", "A managed Python script is already running.",
      ));
    }
    const running = Promise.resolve().then(() => this.#execute(source)).finally(() => {
      if (this.#running === running) {
        this.#running = undefined;
      }
    });
    this.#running = running;
    return running;
  }

  async #execute(source: string): Promise<void> {
    await prepareRuntimeSession(this.#session);
    await this.#bridge.runManaged(() => this.#executeScript(source));
  }

  async #executeScript(source: string): Promise<void> {
    const result = await this.#interpreter.runPythonAsync(source);
    if (result instanceof this.#interpreter.ffi.PyProxy) {
      result.destroy();
    }
  }

  close(): Promise<void> {
    this.#closing ??= this.#drain();
    return this.#closing;
  }

  async #drain(): Promise<void> {
    // The entry promise reports preparation or script failure to its caller.
    // Failure must not bypass drain or be reported again as a close failure.
    await this.#running?.catch(() => undefined);
    const failures: unknown[] = [];
    try {
      await this.#session.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      this.#installation?.close();
    } catch (error) {
      failures.push(error);
    } finally {
      ATTACHED_INTERPRETERS.delete(this.#interpreter);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Python binding cleanup failed.");
  }
}

/**
 * Associate a prepared Pyodide 314.0.6 interpreter with one owned session.
 * Rejects unsupported interpreters and overlapping attachments. The caller
 * must close the returned binding; attachment never owns interpreter shutdown.
 */
export async function attachPython(
  interpreter: PythonInterpreter,
  options: PythonBindingOptions = {},
): Promise<PythonBinding> {
  if (
    typeof interpreter !== "object" || interpreter === null
    || interpreter.version !== "314.0.6"
    || typeof interpreter.runPythonAsync !== "function"
    || typeof interpreter.runPython !== "function"
    || typeof interpreter.ffi?.PyProxy !== "function"
  ) {
    throw new TabgradError(
      "UNSUPPORTED_PYODIDE", "Attachment requires a prepared Pyodide 314.0.6 interpreter.",
    );
  }
  if (ATTACHED_INTERPRETERS.has(interpreter)) {
    throw new TabgradError(
      "PYTHON_ALREADY_ATTACHED", "This interpreter already has a Python binding.",
    );
  }
  ATTACHED_INTERPRETERS.add(interpreter);
  let binding: InterpreterBinding | undefined;
  try {
    const sources = await loadPythonSources(
      options.manifestUrl ?? new URL("./python/manifest.json", import.meta.url),
    );
    binding = new InterpreterBinding(interpreter);
    binding.install(sources);
    return binding;
  } catch (error) {
    try {
      await binding?.close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Python attachment and cleanup failed.");
    } finally {
      ATTACHED_INTERPRETERS.delete(interpreter);
    }
    throw error;
  }
}
