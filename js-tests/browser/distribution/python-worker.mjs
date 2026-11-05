import { RuntimeSession } from "/vendor/tabgrad/index.js";
import { attachPython, servePythonWorker } from "/vendor/tabgrad/python.js";

function checkLocalObservation(observed, gpu) {
  if (!observed || !Object.isFrozen(observed) || !Object.isFrozen(observed.timings)) throw new Error("Local diagnostics are not frozen observations.");
  if (gpu) {
    if (!observed.webgpu || !Object.isFrozen(observed.webgpu.adapter)
      || !Object.isFrozen(observed.webgpu.features) || !Object.isFrozen(observed.webgpu.limits)
      || observed.webgpu.kernelCalls === 0) throw new Error("Local GPU diagnostics are missing or aliased.");
  } else if (observed.kernelCalls === 0 || observed.highWaterAllocationBytes === 0
    || observed.wasmMemoryBytes === 0) throw new Error("Local CPU diagnostics did not observe the program.");
}

addEventListener("message", async ({ data }) => {
  try {
    for (const name of ["Suspending", "promising", "Suspender"]) {
      if (!Reflect.deleteProperty(WebAssembly, name) || name in WebAssembly) throw new Error("Cannot disable JSPI.");
    }
    const { loadPyodide } = await import("/vendor/pyodide/pyodide.mjs");
    const interpreter = await loadPyodide({ indexURL: "/vendor/pyodide/" });
    interpreter.runPython("host_value = 42");
    const binding = await attachPython(interpreter, data.webgpu === undefined ? {} : { webgpu: data.webgpu });
    // This test-only identity oracle does not supply application observations.
    const session = interpreter.runPython("__import__('torch')._runtime_session");
    let observed;
    const serving = servePythonWorker({
      async runPythonAsync(source) {
        await binding.runPythonAsync(source);
        observed = binding.diagnostics();
      },
      close: () => binding.close(),
    }, data.port);
    postMessage({ kind: "ready", pyodide: interpreter.version, sharedIdentity: session instanceof RuntimeSession,
      jspiAvailable: typeof WebAssembly.Suspending === "function", worker: typeof document === "undefined",
      isolated: globalThis.crossOriginIsolated });
    await serving;
    checkLocalObservation(observed, data.webgpu !== undefined);
    interpreter.runPython("assert host_value == 42; assert answer == 11; assert 'torch' not in __import__('sys').modules");
    postMessage({ kind: "finished", diagnostics: binding.diagnostics(), observed, preservedHost: true });
  } catch (error) {
    postMessage({ kind: "failure", message: String(error) });
  }
}, { once: true });
