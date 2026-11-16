import { attachPython, servePythonWorker } from "/python.js";

addEventListener("message", async ({ data }) => {
  let binding;
  try {
    for (const name of ["Suspending", "promising", "Suspender"]) Reflect.deleteProperty(WebAssembly, name);
    const { loadPyodide } = await import("/pyodide/pyodide.mjs");
    const interpreter = await loadPyodide({ indexURL: "/pyodide/" });
    interpreter.registerJsModule("dispatch_probe", {
      // Validate the full large transport payload without constructing millions
      // of Python scalar wrappers. Ordinary tolist is checked in the script too.
      verify: async (tensor, count, expected) => {
        const values = await tensor.toArray();
        if (values.length !== count || !values.every(value => value === expected)) throw new Error("Large Python worker payload changed.");
      },
    });
    binding = await attachPython(interpreter, { webgpu: data.webgpu });
    const serving = servePythonWorker(binding, data.port);
    postMessage({ kind: "ready", pyodide: interpreter.version, worker: typeof document === "undefined",
      jspiAvailable: typeof WebAssembly.Suspending === "function" });
    await serving;
    interpreter.unregisterJsModule("dispatch_probe");
    postMessage({ kind: "finished", diagnostics: binding.diagnostics() });
  } catch (error) {
    await binding?.close().catch(() => undefined);
    postMessage({ kind: "failure", message: String(error), stack: error?.stack });
  }
}, { once: true });
