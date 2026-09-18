// Application-owned worker bootstrap used by the real-artifact integration check.
import { attachPython, servePythonWorker } from "/python.js";
import { selectCpuProfile } from "/cpu-profile.mjs";

async function start(event) {
  const { port, disableJspi, gate, variant } = event.data;
  const lifetime = new AbortController();
  try {
    if (disableJspi) {
      for (const name of ["Suspending", "promising", "Suspender"]) {
        if (!Reflect.deleteProperty(WebAssembly, name) || name in WebAssembly) {
          throw new Error(`Cannot disable worker JSPI: ${name}`);
        }
      }
    }
    const jspiAvailable = typeof WebAssembly.Suspending === "function"
      && typeof WebAssembly.promising === "function";
    const { loadPyodide } = await import("/pyodide/pyodide.mjs");
    const interpreter = await loadPyodide({
      indexURL: "/pyodide/",
      stdout(text) { postMessage({ kind: "stdout", text }); },
    });
    selectCpuProfile(variant);
    interpreter.runPython("host_value = 40");
    if (gate !== undefined) {
      interpreter.registerJsModule("_test_worker_gate", {
        park() {
          postMessage({ kind: "parked" });
          const status = Atomics.wait(new Int32Array(gate), 0, 0, 5000);
          if (status === "timed-out") throw new Error("Host did not release the test gate.");
        },
      });
    }
    const binding = await attachPython(interpreter);
    const session = interpreter.runPython("__import__('torch')._runtime_session");
    if (session.diagnostics().backendLoads !== 0) throw new Error("Attachment prepared CPU.");
    const serving = servePythonWorker(binding, port, lifetime.signal);
    postMessage({ kind: "ready", jspiAvailable, pyodide: interpreter.version,
      worker: typeof document === "undefined", isolated: crossOriginIsolated });
    await serving;
    const answer = interpreter.runPython("answer");
    interpreter.runPython(`
import sys
assert host_value == 40
assert 'torch' not in sys.modules
assert '_tabgrad_runtime_bridge' not in sys.modules
assert 'rejected_script' not in globals()
`);
    const diagnostics = session.diagnostics();
    if (diagnostics.liveRequestLeases !== 0 || diagnostics.liveTensorHandles !== 0
      || diagnostics.liveAllocationBytes !== 0) {
      throw new Error("Worker close left live runtime resources.");
    }
    const replacement = await attachPython(interpreter);
    try {
      await replacement.runPythonAsync(`
from pyodide.ffi import JsException
try:
    result.shape
except JsException as error:
    assert error.js_error.code == 'CLOSED_TENSOR'
else:
    raise AssertionError('A stale tensor was rebound')
try:
    result.tolist()
except JsException as error:
    assert error.js_error.code == 'PYTHON_SYNC_CONTEXT_REQUIRED'
else:
    raise AssertionError('A stale wrapper acquired the new managed context')
`);
    } finally { await replacement.close(); }
    if (gate !== undefined) interpreter.unregisterJsModule("_test_worker_gate");
    postMessage({ kind: "finished", answer, diagnostics,
      selectedVariant: interpreter.runPython("selected_variant") });
  } catch (error) {
    lifetime.abort(error);
    postMessage({ kind: "failure", message: String(error), stack: error?.stack });
  }
}

addEventListener("message", start, { once: true });
