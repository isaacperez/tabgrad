import { TabgradError } from "./errors.js";
import type { PythonInterpreter, PythonNamespace } from "./python.js";
import type { PythonSources } from "./python-assets.js";
import type { PythonRuntimeBridge } from "./python-runtime-bridge.js";

/** @internal Own the bootstrap namespace and the installation it records. */
export class PythonInstallation {
  readonly #interpreter: PythonInterpreter;
  readonly #namespace: PythonNamespace;
  #closed = false;

  constructor(interpreter: PythonInterpreter, sources: PythonSources, bridge: PythonRuntimeBridge) {
    this.#interpreter = interpreter;
    // A literal creates owned state without resolving a host-shadowed builtin.
    this.#namespace = interpreter.runPython("{}") as PythonNamespace;
    try {
      interpreter.runPython(sources.bootstrap, { globals: this.#namespace });
      this.#namespace.set("_package_source", sources.package);
      this.#namespace.set("_runtime_bridge", bridge);
      interpreter.runPython(
        "_installation = Installation(); _installation.install(_package_source, _runtime_bridge)",
        { globals: this.#namespace },
      );
      // Imported modules retain their own references. Source text and the
      // temporary bridge reference need not survive for the binding's lifetime.
      interpreter.runPython("del _package_source, _runtime_bridge", { globals: this.#namespace });
    } catch (cause) {
      let failure = cause;
      try {
        this.#releaseNamespace();
      } catch (cleanup) {
        failure = new AggregateError([cause, cleanup], "Python bootstrap cleanup failed.");
      }
      throw new TabgradError("PYTHON_INSTALL_FAILED", "Python package installation failed.", {}, failure);
    }
  }

  #releaseNamespace(): void {
    try {
      // Bootstrap functions refer back to their globals. Break that cycle
      // explicitly instead of retaining a retired installation until Python GC.
      this.#interpreter.runPython("globals().clear()", { globals: this.#namespace });
    } finally {
      this.#namespace.destroy();
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const failures: unknown[] = [];
    try {
      this.#interpreter.runPython("_installation.close()", { globals: this.#namespace });
    } catch (error) {
      failures.push(error);
    }
    try {
      this.#releaseNamespace();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Python installation cleanup failed.");
  }
}
