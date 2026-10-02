import { connectPythonWorker, createWebGpuWorker } from "/python.js";

const token = new URLSearchParams(location.search).get("token");
const NativeWorker = Worker;
const lifetime = new AbortController();
let controller;
let interpreterWorker;
let gpuWorker;
let submitted;
const physicalSubmission = new Promise((resolve) => { submitted = resolve; });
const events = new Map();

function next(kind) {
  return new Promise((resolve, reject) => { events.set(kind, { resolve, reject }); });
}

async function report(endpoint, value) {
  const response = await fetch(`${endpoint}?token=${encodeURIComponent(token)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error(`Reporting failed: ${response.status}`);
}

try {
  await report("/__phase", { phase: "application-started" });
  globalThis.Worker = class ObservedWorker extends NativeWorker {
    constructor(...arguments_) {
      super(...arguments_);
      gpuWorker = this;
      this.addEventListener("message", ({ data }) => {
        if (data.kind === "test-submission-completed") submitted();
      });
    }
  };
  controller = await createWebGpuWorker({ workerUrl: new URL("/python-webgpu/python-webgpu-delayed.mjs", location.href) });
  globalThis.Worker = NativeWorker;
  interpreterWorker = new NativeWorker("/python-webgpu/python-webgpu.mjs", { type: "module" });
  const channel = new MessageChannel();
  const client = connectPythonWorker(channel.port1, lifetime.signal);
  const ready = next("ready");
  const finished = next("finished");
  void finished.catch(() => undefined);
  interpreterWorker.addEventListener("message", ({ data }) => {
    if (data.kind === "failure") {
      for (const event of events.values()) event.reject(new Error(data.message));
      return;
    }
    const event = events.get(data.kind);
    events.delete(data.kind);
    event?.resolve(data);
  });
  interpreterWorker.postMessage({ port: channel.port2, webgpu: controller.connection }, [channel.port2, ...controller.transferables]);
  const environment = await ready;
  await report("/__phase", { phase: "assets-loaded" });
  await report("/__phase", { phase: "runtime-started" });
  const running = client.runPythonAsync(`
import torch, gc
session = torch._runtime_session
def caught_revocation():
    x = torch.tensor([float(index % 32) for index in range(65536)], dtype=torch.float32, device='webgpu')
    y = x + x
    try:
        y.tolist()
    except Exception as error:
        assert error.js_error.code == 'BACKEND_STATUS_ERROR'
    else:
        raise AssertionError('Retired GPU work published success')
    assert session.diagnostics().liveRequestLeases == 1
    assert session.diagnostics().webgpu.pendingSubmissions > 0
    cpu = torch.tensor([2., 3.], dtype=torch.float32)
    assert (cpu + cpu).tolist() == [4., 6.]
caught_revocation()
gc.collect()
assert session.diagnostics().liveRequestLeases == 1
`);
  await physicalSubmission;
  let cleanupSettled = false;
  const cleanup = controller.close();
  void cleanup.then(() => { cleanupSettled = true; });
  // This resolves while the real producer acknowledgement remains gated.
  // It establishes independent wakeup, not an assumed timeout-based ordering.
  await running;
  if (cleanupSettled) throw new Error("Revocation claimed physical drain before acknowledgement.");
  gpuWorker.postMessage({ kind: "test-release-drain" });
  await cleanup;
  await client.runPythonAsync(`
gc.collect()
assert session.diagnostics().liveRequestLeases == 0
assert session.diagnostics().webgpu.ownedBufferBytes == 0
assert session.diagnostics().webgpu.pendingSubmissions == 0
`);
  await client.close();
  const result = await finished;
  await report("/__phase", { phase: "runtime-finished" });
  await report("/__result", { ok: true, ...environment, diagnostics: result.diagnostics });
} catch (error) {
  lifetime.abort(error);
  gpuWorker?.postMessage({ kind: "test-release-drain" });
  await controller?.close().catch(() => undefined);
  await report("/__result", { ok: false, error: { message: String(error), stack: error?.stack } });
} finally {
  globalThis.Worker = NativeWorker;
  interpreterWorker?.terminate();
}
