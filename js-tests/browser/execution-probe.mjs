// Diagnostic-only synchronous call boundaries; never imported by the distribution.
// Durations are inclusive and nested, not additive phases or uninstrumented costs.
export class ExecutionProbe {
  #clock;
  #records = new Map();
  #restorations = [];

  constructor(clock = () => performance.now()) { this.#clock = clock; }

  call(name, original, receiver, arguments_) {
    const record = this.#records.get(name) ?? { calls: 0, failures: 0, milliseconds: 0 };
    this.#records.set(name, record);
    record.calls += 1;
    const start = this.#clock();
    try { return Reflect.apply(original, receiver, arguments_); }
    catch (error) { record.failures += 1; throw error; }
    finally { record.milliseconds += this.#clock() - start; }
  }

  wrap(name, original) {
    const probe = this;
    return function (...arguments_) { return probe.call(name, original, this, arguments_); };
  }

  method(owner, key, name) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (!descriptor?.configurable || typeof descriptor.value !== "function") {
      throw new Error(`Cannot instrument method ${key}`);
    }
    this.#replace(owner, key, descriptor, { ...descriptor, value: this.wrap(name, descriptor.value) });
  }

  // Observe the real native export without changing module bytes or numerical work.
  // A facade is necessary because native export properties are non-configurable.
  kernelExports(instancePrototype) {
    const descriptor = Object.getOwnPropertyDescriptor(instancePrototype, "exports");
    if (!descriptor?.configurable || typeof descriptor.get !== "function") {
      throw new Error("Cannot instrument WebAssembly exports");
    }
    const cache = new WeakMap();
    const probe = this;
    this.#replace(instancePrototype, "exports", descriptor, {
      ...descriptor,
      get() { return probe.#exports(descriptor.get.call(this), cache); },
    });
  }

  #exports(exports, cache) {
    if (typeof exports.tabgrad_add_f32 !== "function") return exports;
    let facade = cache.get(exports);
    if (facade === undefined) {
      facade = Object.freeze({ ...exports, tabgrad_add_f32: this.wrap("kernel", exports.tabgrad_add_f32) });
      cache.set(exports, facade);
    }
    return facade;
  }

  #replace(owner, key, previous, replacement) {
    Object.defineProperty(owner, key, replacement);
    this.#restorations.push({ owner, key, previous });
  }

  reset() { this.#records.clear(); }

  snapshot() {
    return Object.fromEntries([...this.#records].map(([name, record]) => [name, { ...record }]));
  }

  restore() {
    for (const { owner, key, previous } of this.#restorations.reverse()) {
      Object.defineProperty(owner, key, previous);
    }
    this.#restorations.length = 0;
  }
}

/** Install only in a disposable diagnostic worker, after Pyodide has loaded. */
export async function installExecutionProbe() {
  const [{ Tensor }, { WebAssemblyCpuBackend }, { PythonRuntimeBridge }] = await Promise.all([
    import("/runtime.js"), import("/cpu-backend.js"), import("/python-runtime-bridge.js"),
  ]);
  const probe = new ExecutionProbe();
  try {
    probe.method(Tensor.prototype, "add", "tensorAdd");
    probe.method(Tensor.prototype, "close", "tensorClose");
    probe.method(PythonRuntimeBridge.prototype, "tensorFromBuffer", "pythonBufferImport");
    probe.method(PythonRuntimeBridge.prototype, "observe", "pythonObservation");
    probe.method(WebAssemblyCpuBackend.prototype, "execute", "backendExecution");
    probe.method(WebAssemblyCpuBackend.prototype, "read", "backendReadback");
    probe.kernelExports(WebAssembly.Instance.prototype);
    return probe;
  } catch (error) { probe.restore(); throw error; }
}
