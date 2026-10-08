import { TabgradError } from "../../shared/errors.js";
import type { PythonInterpreter, PythonNamespace } from "./python-binding.js";
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
    let installed = false;
    try {
      interpreter.runPython(sources.bootstrap, { globals: this.#namespace });
      this.#transferSources(sources.packageSources);
      this.#namespace.set("_runtime_bridge", bridge);
      interpreter.runPython(
        "_installation = Installation(); _installation.install(_package_sources, _runtime_bridge)",
        { globals: this.#namespace },
      );
      installed = true;
      // Imported modules retain their own references. Source text and the
      // temporary bridge reference need not survive for the binding's lifetime.
      interpreter.runPython("del _package_sources, _runtime_bridge", { globals: this.#namespace });
    } catch (cause) {
      let failure = cause;
      try {
        // A failed import rolls itself back. Once it returns, this constructor
        // owns retirement until the completed installation reaches the binding.
        if (installed) this.close();
        else this.#releaseNamespace();
      } catch (cleanup) {
        failure = new AggregateError([cause, cleanup], "Python bootstrap cleanup failed.");
      }
      throw new TabgradError("PYTHON_INSTALL_FAILED", "Python package installation failed.", {}, failure);
    }
  }

  #transferSources(sources: ReadonlyMap<string, string>): void {
    const dictionary = this.#interpreter.runPython("{}") as PythonNamespace;
    const failures: unknown[] = [];
    try {
      for (const [path, source] of sources) dictionary.set(path, source);
      this.#namespace.set("_package_sources", dictionary);
    } catch (error) {
      failures.push(error);
    }
    try {
      // The private namespace now owns the native dictionary, not its proxy.
      dictionary.destroy();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Python source transfer and cleanup failed.");
  }

  #releaseNamespace(): void {
    const failures: unknown[] = [];
    try {
      // Bootstrap functions refer back to their globals. Break that cycle
      // explicitly instead of retaining a retired installation until Python GC.
      this.#interpreter.runPython("globals().clear()", { globals: this.#namespace });
    } catch (error) {
      failures.push(error);
    }
    try {
      this.#namespace.destroy();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Python namespace cleanup failed.");
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
