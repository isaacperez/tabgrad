import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
import { executionDevice } from "./webgpu-device.mjs";
import { startWebGpuWorker } from "../../../../dist/backends/webgpu/worker.js";

const gate = new Int32Array(workerData.gate);
let mappings = 0;
async function waitForDrain(identity) {
  while (Atomics.load(gate, 0) < identity) {
    const value = Atomics.load(gate, 0);
    if (value >= identity) return;
    const wait = Atomics.waitAsync(gate, 0, value);
    if (wait.async) await wait.value;
  }
}
const acquired = executionDevice({
  mapping: () => ++mappings > 1 && workerData.mode === "failure"
    ? Promise.reject(new DOMException("controlled map rejection", "OperationError")) : Promise.resolve(),
  completion: (submitted) => {
    if (submitted <= 2 || workerData.mode === "success") return Promise.resolve();
    return waitForDrain(submitted - 2);
  },
});
// Structural instrumentation observes the actual worker's live request map,
// without adding a production inspection API or counting completion history.
const NativeMap = Map, requestMaps = new Set();
globalThis.Map = class extends NativeMap {
  set(key, value) {
    if (value !== null && typeof value === "object" && Object.hasOwn(value, "progress")) requestMaps.add(this);
    return super.set(key, value);
  }
};
Object.defineProperty(globalThis, "navigator", { configurable: true,
  value: { gpu: { requestAdapter: async () => ({ requestDevice: async () => acquired }) } } });
globalThis.addEventListener = (type, listener) => {
  assert.equal(type, "message");
  parentPort.on("message", (data) => listener(new MessageEvent("message", { data })));
};
globalThis.postMessage = (message) => parentPort.postMessage(message);
parentPort.on("message", (message) => {
  if (message.kind === "inspect") parentPort.postMessage({ kind: "inspection",
    buffersDestroyed: acquired.buffers.every((buffer) => buffer.destroyed), deviceDestroyed: acquired.destroyed,
    liveRequests: [...requestMaps].reduce((total, map) => total + map.size, 0), observedRequestMaps: requestMaps.size });
});
startWebGpuWorker();
