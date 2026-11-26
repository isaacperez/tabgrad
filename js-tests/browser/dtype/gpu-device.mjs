import { restrictGpuDispatch } from "/dtype/restrict-gpu.mjs";
import { startWebGpuWorker } from "/backends/webgpu/worker.js";

restrictGpuDispatch();
startWebGpuWorker();
