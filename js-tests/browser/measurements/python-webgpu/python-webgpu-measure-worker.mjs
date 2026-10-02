import { attachPython } from "/python.js";
import { createWebGpuRuntimeSession } from "/index.js";
import { runManagedGpuMeasurement } from "./python-webgpu-measure-controller.mjs";

addEventListener("message", async ({ data }) => {
  const report = await runManagedGpuMeasurement(data, {
    attachPython, createWebGpuRuntimeSession,
    loadModule: (specifier) => import(specifier),
    clock: performance, crossOriginIsolated, webAssembly: WebAssembly,
  });
  postMessage(report);
}, { once: true });
