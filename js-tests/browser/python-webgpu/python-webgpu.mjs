import { attachPython, servePythonWorker } from "/python.js";
import { ExecutionTicket } from "/execution/execution-ticket.js";
import { numericalPairs, exactAddition } from "/helpers/float32-addition-oracle.mjs";

import { exactTotal, exactCases } from "/helpers/float32-sum-oracle.mjs";
import { exactMultiplication, multiplicationPairs } from "/helpers/float32-multiplication-oracle.mjs";
import { pythonFunctionalGradientChecks } from "/helpers/functional-gradient-cases.mjs";
import { pythonCopyFixtureChecks } from "/helpers/python-copy-cases.mjs";
import { pythonGradientProgressChecks } from "/helpers/gradient-progress-cases.mjs";
import { pythonBackwardChecks, pythonBackwardDeviceSource } from "/helpers/backward-cases.mjs";
import { pythonBackwardLifetimeChecks } from "/helpers/backward-lifetime.mjs";
import { pythonSGDChecks } from "/helpers/sgd-cases.mjs";
import { pythonMatrixChecks, pythonMatrixNumericalChecks } from "/helpers/python-matrix-cases.mjs";
import { pythonViewMetadataChecks, pythonViewBoundaryChecks } from "/helpers/python-view-cases.mjs";
import { pythonSGDHostChecks } from "/helpers/sgd-lifetime.mjs";
import { pythonTensorDeviceSource } from "/helpers/python-tensor-device.mjs";
import { getTestTensorVersion } from "/testing.js";
import { gpuSGDCheckpoint } from "/helpers/gpu-sgd-cases.mjs";

function expectedMultiplication(pairs, depth) {
  let bits = pairs.left;
  for (let step = 0; step < depth; step++) bits = bits.map((left, index) => exactMultiplication(left, pairs.right[index]));
  return Array.from(bits);
}

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
    interpreter.registerJsModule("_test_gpu_observers", { count: () => asynchronousGpuObservers,
      revocationProgress: () => postMessage({ kind: "test-revoked-script-progress" }) });
    if (data.numericalCorpus) {
      const response = await fetch("/helpers/functional-gradient-oracle.json");
      if (!response.ok) throw new Error("Native functional oracle unavailable");
      const oracle = await response.json();
      interpreter.globals.set("inspect_sgd_version", getTestTensorVersion);
      interpreter.registerJsModule("_test_sgd", {
        source: pythonSGDChecks(oracle, "webgpu") + pythonTensorDeviceSource(pythonSGDHostChecks, "webgpu"),
      });
      interpreter.registerJsModule("_test_sgd_resource", {
        report: session => postMessage({ kind: "sgd-checkpoint", snapshot: gpuSGDCheckpoint(session) }),
      });
      interpreter.registerJsModule("_test_grad", { source: pythonFunctionalGradientChecks(oracle, "webgpu") });
      interpreter.registerJsModule("_test_matrix", { source: pythonMatrixChecks(oracle, "webgpu") + pythonMatrixNumericalChecks("webgpu") });
      interpreter.registerJsModule("_test_view", { source: pythonViewMetadataChecks(oracle, "webgpu") + pythonViewBoundaryChecks("webgpu") });
      interpreter.registerJsModule("_test_copy", { source: pythonCopyFixtureChecks(oracle, "webgpu") + pythonGradientProgressChecks(oracle, "webgpu") });
      interpreter.registerJsModule("_test_backward", {
        source: pythonBackwardDeviceSource(pythonBackwardChecks(oracle) + pythonBackwardLifetimeChecks, "webgpu"),
      });
      const products = multiplicationPairs();
      interpreter.registerJsModule("_test_mul", { left: Array.from(products.left), right: Array.from(products.right),
        expected: (depth) => expectedMultiplication(products, depth) });
      const sums = exactCases();
      interpreter.registerJsModule("_test_sum", { cases: sums.map((bits) => Array.from(bits)),
        expected: sums.map((bits) => exactTotal(bits).bits) });
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
    if (data.numericalCorpus) {
      interpreter.unregisterJsModule("_test_grad");
      interpreter.unregisterJsModule("_test_matrix");
      interpreter.unregisterJsModule("_test_view");
      interpreter.unregisterJsModule("_test_copy");
      interpreter.unregisterJsModule("_test_backward");
      interpreter.unregisterJsModule("_test_sgd");
      interpreter.unregisterJsModule("_test_sgd_resource");
      interpreter.globals.delete("inspect_sgd_version");
      interpreter.unregisterJsModule("_test_mul");
      interpreter.unregisterJsModule("_test_f32");
      interpreter.unregisterJsModule("_test_sum");
    }
    interpreter.runPython("assert host_value == 40; assert 'torch' not in __import__('sys').modules");
    postMessage({ kind: "finished", diagnostics: session.diagnostics(), closeFailed });
  } catch (error) {
    postMessage({ kind: "failure", message: String(error), stack: error?.stack });
  }
}, { once: true });
