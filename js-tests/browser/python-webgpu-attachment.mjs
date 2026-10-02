import { attachPython, createWebGpuWorker } from "/python.js";
import { loadPyodide } from "/pyodide/pyodide.mjs";

const token = new URLSearchParams(location.search).get("token");
let controller;
async function report(endpoint, value) {
  const response = await fetch(`${endpoint}?token=${encodeURIComponent(token)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error(`Reporting failed: ${response.status}`);
}

async function rejectsCode(operation, code) {
  try { await operation(); }
  catch (error) {
    if (error.code !== code) throw error;
    return;
  }
  throw new Error(`Expected ${code} before installation or numerical admission.`);
}

try {
  await report("/__phase", { phase: "application-started" });
  for (const name of ["Suspending", "promising", "Suspender"]) Reflect.deleteProperty(WebAssembly, name);
  const interpreter = await loadPyodide({ indexURL: "/pyodide/" });
  interpreter.runPython("host_value = 40");
  await report("/__phase", { phase: "assets-loaded" });
  await report("/__phase", { phase: "runtime-started" });
  controller = await createWebGpuWorker();
  await rejectsCode(() => attachPython(interpreter, { webgpu: controller.connection }), "SYNCHRONOUS_OBSERVATION_UNAVAILABLE");
  await rejectsCode(() => attachPython(interpreter, { webgpu: controller.connection }), "PYTHON_CONNECTION_IN_USE");
  interpreter.runPython("assert host_value == 40; assert 'torch' not in __import__('sys').modules");
  await controller.close();
  controller = await createWebGpuWorker();
  await controller.close();
  await rejectsCode(() => attachPython(interpreter, { webgpu: controller.connection }), "BACKEND_STATUS_ERROR");
  interpreter.runPython("assert host_value == 40; assert 'torch' not in __import__('sys').modules");
  await report("/__phase", { phase: "runtime-finished" });
  await report("/__result", { ok: true, worker: false, pyodide: interpreter.version,
    jspiAvailable: typeof WebAssembly.Suspending === "function", attachmentBoundaries: true });
} catch (error) {
  await controller?.close().catch(() => undefined);
  await report("/__result", { ok: false, error: { message: String(error), stack: error?.stack } });
}
