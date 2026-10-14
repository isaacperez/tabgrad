import { RuntimeSession } from "/vendor/tabgrad/index.js";
import { attachPython, servePythonWorker } from "/vendor/tabgrad/python.js";

addEventListener("message", async ({ data }) => {
  try {
    for (const name of ["Suspending", "promising", "Suspender"]) {
      if (!Reflect.deleteProperty(WebAssembly, name) || name in WebAssembly) throw new Error("Cannot disable JSPI.");
    }
    const { loadPyodide } = await import("/vendor/pyodide/pyodide.mjs");
    const interpreter = await loadPyodide({ indexURL: "/vendor/pyodide/" });
    interpreter.runPython("host_value = 42");
    const binding = await attachPython(interpreter, data.webgpu === undefined ? {} : { webgpu: data.webgpu });
    // Supplemental installed-session diagnostics, not a public Python API or
    // a private JavaScript import. Application computation uses ordinary torch.
    const session = interpreter.runPython("__import__('torch')._runtime_session");
    const serving = servePythonWorker(binding, data.port);
    postMessage({ kind: "ready", pyodide: interpreter.version, sharedIdentity: session instanceof RuntimeSession,
      jspiAvailable: typeof WebAssembly.Suspending === "function", worker: typeof document === "undefined",
      isolated: globalThis.crossOriginIsolated });
    await serving;
    interpreter.runPython("assert host_value == 42; assert answer == 11; assert 'torch' not in __import__('sys').modules");
    postMessage({ kind: "finished", diagnostics: session.diagnostics(), preservedHost: true });
  } catch (error) {
    postMessage({ kind: "failure", message: String(error) });
  }
}, { once: true });
