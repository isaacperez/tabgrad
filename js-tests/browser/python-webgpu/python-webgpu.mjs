import { attachPython, servePythonWorker } from "/python.js";
import { ExecutionTicket } from "/execution/execution-ticket.js";
import { numericalPairs, exactAddition } from "/helpers/float32-addition-oracle.mjs";

function expectedAddition(pairs, depth) {
  let bits = pairs.left;
  for (let step = 0; step < depth; step += 1) bits = bits.map((left, index) => exactAddition(left, pairs.right[index]));
  return Array.from(bits);
}

addEventListener("message", async ({ data }) => {
  try {
    for (const name of ["Suspending", "promising", "Suspender"]) {
      if (!Reflect.deleteProperty(WebAssembly, name) || name in WebAssembly) throw new Error(`Cannot disable JSPI: ${name}`);
    }
    const { loadPyodide } = await import("/pyodide/pyodide.mjs");
    const interpreter = await loadPyodide({ indexURL: "/pyodide/" });
    interpreter.runPython("host_value = 40");
    const attachment = attachPython(interpreter, { webgpu: data.webgpu });
    let competingAttachmentRejected = false;
    try { await attachPython(interpreter, { webgpu: data.webgpu }); }
    catch (error) {
      if (error.code !== "PYTHON_CONNECTION_IN_USE") throw error;
      competingAttachmentRejected = true;
    }
    if (!competingAttachmentRejected) throw new Error("Competing attachment consumed the winning connection.");
    const binding = await attachment;
    const descriptor = Object.getOwnPropertyDescriptor(ExecutionTicket.prototype, "result");
    let asynchronousGpuObservers = 0;
    Object.defineProperty(ExecutionTicket.prototype, "result", {
      ...descriptor,
      get() {
        if (this.synchronous !== undefined) asynchronousGpuObservers += 1;
        return descriptor.get.call(this);
      },
    });
    interpreter.registerJsModule("_test_gpu_observers", { count: () => asynchronousGpuObservers });
    if (data.numericalCorpus) {
      const pairs = numericalPairs();
      interpreter.registerJsModule("_test_f32", { left: Array.from(pairs.left), right: Array.from(pairs.right),
        expected: (depth) => expectedAddition(pairs, depth) });
    }
    const session = interpreter.runPython("__import__('torch')._runtime_session");
    const serving = servePythonWorker(binding, data.port);
    postMessage({ kind: "ready", pyodide: interpreter.version,
      jspiAvailable: typeof WebAssembly.Suspending === "function", worker: typeof document === "undefined" });
    let closeFailed = false;
    try { await serving; }
    catch (error) {
      if (!data.expectedCloseFailure || error.code !== "BACKEND_STATUS_ERROR") throw error;
      closeFailed = true;
    }
    Object.defineProperty(ExecutionTicket.prototype, "result", descriptor);
    interpreter.unregisterJsModule("_test_gpu_observers");
    if (data.numericalCorpus) interpreter.unregisterJsModule("_test_f32");
    interpreter.runPython("assert host_value == 40; assert 'torch' not in __import__('sys').modules");
    postMessage({ kind: "finished", diagnostics: session.diagnostics(), closeFailed });
  } catch (error) {
    postMessage({ kind: "failure", message: String(error), stack: error?.stack });
  }
}, { once: true });
