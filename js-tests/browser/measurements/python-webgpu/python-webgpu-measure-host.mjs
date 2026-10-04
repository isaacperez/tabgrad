import { createWebGpuWorker } from "/python.js";

const parameters = new URLSearchParams(location.search);
const token = parameters.get("token");
let controller;
let worker;
let outcome;
const physicalPhases = [];
const NativeWorker = Worker;
async function report(endpoint, value) {
  const response = await fetch(`${endpoint}?token=${encodeURIComponent(token)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error(`Reporting failed: ${response.status}`);
}

try {
  await report("/__phase", { phase: "application-started" });
  if (parameters.get("mode") === "diagnose") {
    globalThis.Worker = class InstrumentedPhysicalWorker extends NativeWorker {
      constructor(...arguments_) {
        super(...arguments_);
        this.addEventListener("message", ({ data }) => {
          if (data.kind === "test-physical-phase") physicalPhases.push(data);
        });
      }
    };
  }
  const start = performance.now();
  controller = await createWebGpuWorker(parameters.get("mode") === "diagnose"
    ? { workerUrl: new URL("/measurements/python-webgpu/python-webgpu-measure-physical.mjs", location.href) } : undefined);
  globalThis.Worker = NativeWorker;
  const workerAcquisitionMilliseconds = performance.now() - start;
  worker = new Worker("/measurements/python-webgpu/python-webgpu-measure-worker.mjs", { type: "module" });
  const result = new Promise((resolve, reject) => {
    worker.addEventListener("message", ({ data }) => resolve(data), { once: true });
    worker.addEventListener("error", (event) => reject(new Error(event.message)), { once: true });
  });
  await report("/__phase", { phase: "assets-loaded" });
  await report("/__phase", { phase: "runtime-started" });
  worker.postMessage({ webgpu: controller.connection, mode: parameters.get("mode"), operation: parameters.get("operation") ?? "add" }, [...controller.transferables]);
  outcome = { ...await result, workerAcquisitionMilliseconds };
} catch (error) {
  outcome = { ok: false, error: { message: String(error), stack: error?.stack } };
} finally {
  globalThis.Worker = NativeWorker;
  try { await controller?.close(); }
  catch (error) {
    outcome = { ...outcome, ok: false, cleanupError: { message: String(error), stack: error?.stack } };
  }
  worker?.terminate();
}
// Reporting can cause the harness to terminate the browser immediately. Every
// fixture-owned worker must therefore be retired before sending the result.
if (parameters.get("mode") === "diagnose") outcome.physicalPhases = physicalPhases;
await report("/__phase", { phase: "runtime-finished" });
await report("/__result", { ...outcome, interpreterWorkerTerminated: worker !== undefined });
