import { restrictGpuDispatch } from "/float16/restrict-gpu.mjs";
import { startWebGpuWorker } from "/backends/webgpu/worker.js";

restrictGpuDispatch();
startWebGpuWorker();
