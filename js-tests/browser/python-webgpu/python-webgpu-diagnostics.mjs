import { attachPython, servePythonWorker } from "/python.js";

addEventListener("message", async ({ data }) => {
  if (data.failureMode === "error") {
    setTimeout(() => { throw new Error("controlled GPU diagnostic bootstrap failure"); }, 0);
    return;
  }
  try {
    if (data.failureMode === "message") {
      postMessage({ kind: "failure", message: "controlled GPU diagnostic bootstrap failure" });
      return;
    }
    for (const name of ["Suspending", "promising", "Suspender"]) {
      if (!Reflect.deleteProperty(WebAssembly, name) || name in WebAssembly) throw new Error(`Cannot disable JSPI: ${name}`);
    }
    const { loadPyodide } = await import("/pyodide/pyodide.mjs");
    const interpreter = await loadPyodide({ indexURL: "/pyodide/" });
    interpreter.setStdout({ batched: (text) => postMessage({ kind: "output", text }) });
    const gate = new Int32Array(data.gate);
    interpreter.registerJsModule("metric_probe", {
      park: () => {
        postMessage({ kind: "parked" });
        Atomics.wait(gate, 0, 0);
      },
    });
    const binding = await attachPython(interpreter, { webgpu: data.webgpu });
    const serving = servePythonWorker(binding, data.port);
    postMessage({ kind: "ready", pyodide: interpreter.version, worker: typeof document === "undefined",
      jspiAvailable: typeof WebAssembly.Suspending === "function" });
    await serving;
    interpreter.unregisterJsModule("metric_probe");
    postMessage({ kind: "finished" });
  } catch (error) {
    postMessage({ kind: "failure", message: String(error) });
  }
}, { once: true });
