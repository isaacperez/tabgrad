// A test-only acknowledgement gate around the real GPU completion Promise.
// Actual acquisition, submission and arithmetic remain the packaged backend's.
let releaseDrain;
let acquiredDevice;
const initialization = [];
function holdInitialization(event) {
  if (event.data.kind === "initialize") {
    initialization.push(event.data);
    event.stopImmediatePropagation();
  }
}
addEventListener("message", holdInitialization);
const drainGate = new Promise((resolve) => { releaseDrain = resolve; });
addEventListener("message", ({ data }) => {
  if (data.kind === "test-release-drain") releaseDrain();
  if (data.kind === "test-device-loss") { acquiredDevice.destroy(); releaseDrain(); }
  if (data.kind === "test-worker-loss") throw new Error("Controlled physical-worker failure after real submission.");
});
const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
navigator.gpu.requestAdapter = async (...arguments_) => {
  const adapter = await requestAdapter(...arguments_);
  if (adapter === null) return adapter;
  const requestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (...deviceArguments) => {
    const device = await requestDevice(...deviceArguments);
    acquiredDevice = device;
    const completed = device.queue.onSubmittedWorkDone.bind(device.queue);
    let gated = false;
    device.queue.onSubmittedWorkDone = async () => {
      await completed();
      if (!gated) {
        gated = true;
        postMessage({ kind: "test-submission-completed" });
        await drainGate;
      }
    };
    return device;
  };
  return adapter;
};
await import("/webgpu-worker.js");
removeEventListener("message", holdInitialization);
for (const data of initialization) dispatchEvent(new MessageEvent("message", { data }));
