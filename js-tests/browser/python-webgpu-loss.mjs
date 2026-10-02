import { connectPythonWorker, createWebGpuWorker } from "/python.js";
import { readGpuMetrics } from "/webgpu-connection.js";

const parameters = new URLSearchParams(location.search);
const token = parameters.get("token");
const mode = parameters.get("mode");
const NativeWorker = Worker;
const lifetime = new AbortController();
const events = new Map();
let physicalWorker;
let interpreterWorker;
let controller;
let outcome;
let submitted;
const submission = new Promise((resolve) => { submitted = resolve; });

function next(kind) { return new Promise((resolve, reject) => { events.set(kind, { resolve, reject }); }); }
function assert(value, message) { if (!value) throw new Error(message); }
async function report(endpoint, value) {
  const response = await fetch(`${endpoint}?token=${encodeURIComponent(token)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error(`Reporting failed: ${response.status}`);
}

try {
  await report("/__phase", { phase: "application-started" });
  globalThis.Worker = class ObservedPhysicalWorker extends NativeWorker {
    constructor(...arguments_) {
      super(...arguments_);
      physicalWorker = this;
      this.addEventListener("error", (event) => event.preventDefault());
      this.addEventListener("message", ({ data }) => {
        if (data.kind === "test-submission-completed") submitted();
      });
    }
  };
  controller = await createWebGpuWorker({ signal: lifetime.signal,
    workerUrl: new URL("/python-webgpu-delayed.mjs", location.href) });
  globalThis.Worker = NativeWorker;
  const connection = controller.connection;
  interpreterWorker = new NativeWorker("/python-webgpu.mjs", { type: "module" });
  const channel = new MessageChannel();
  const client = connectPythonWorker(channel.port1, lifetime.signal);
  const ready = next("ready");
  const finished = next("finished");
  void finished.catch(() => undefined);
  interpreterWorker.addEventListener("error", (event) => {
    lifetime.abort(new Error(event.message));
    for (const pending of events.values()) pending.reject(new Error(event.message));
  });
  interpreterWorker.addEventListener("message", ({ data }) => {
    if (data.kind === "failure") {
      for (const pending of events.values()) pending.reject(new Error(data.message));
      return;
    }
    const pending = events.get(data.kind);
    events.delete(data.kind);
    pending?.resolve(data);
  });
  interpreterWorker.postMessage({ port: channel.port2, webgpu: connection,
    expectedCloseFailure: mode === "worker-loss" }, [channel.port2, ...controller.transferables]);
  const environment = await ready;
  await report("/__phase", { phase: "assets-loaded" });
  await report("/__phase", { phase: "runtime-started" });
  const running = client.runPythonAsync(`
import torch, gc
session = torch._runtime_session
def observe_lost_gpu():
    x = torch.tensor([float(index % 32) for index in range(65536)], dtype=torch.float32, device='webgpu')
    alias = x.view(256, 256)
    y = alias + alias
    try:
        y.tolist()
    except Exception as error:
        assert error.js_error.code == 'BACKEND_STATUS_ERROR'
    else:
        raise AssertionError('A retired generation published success')
    assert (torch.tensor([2., 3.], dtype=torch.float32) + torch.tensor([2., 3.], dtype=torch.float32)).tolist() == [4., 6.]
    try:
        y.tolist()
    except Exception as error:
        assert error.js_error.code == 'BACKEND_STATUS_ERROR'
    else:
        raise AssertionError('Future GPU observation succeeded after loss')
observe_lost_gpu()
gc.collect()
`);
  void running.catch(() => undefined);
  await submission;
  const before = readGpuMetrics(connection.metrics, connection.diagnostics, new Int32Array(connection.control));
  assert(before.pendingSubmissions > 0 && before.ownedBufferBytes > 0, "No real owned producer obligation at loss boundary.");
  if (mode === "interpreter-loss") {
    interpreterWorker.terminate();
    // This is explicit host reporting, not automatic silent-hang detection.
    lifetime.abort(new Error("The application terminated its interpreter worker."));
    let rejected = false;
    try { await running; } catch (error) { rejected = error.code === "PYTHON_CONNECTION_LOST"; }
    assert(rejected, "Terminated Python must not acknowledge script completion.");
    let settled = false;
    const cleanup = controller.close();
    void cleanup.then(() => { settled = true; });
    assert(controller.close() === cleanup && !settled, "Close did not preserve the pending cleanup boundary.");
    physicalWorker.postMessage({ kind: "test-release-drain" });
    await cleanup;
    const after = readGpuMetrics(connection.metrics, connection.diagnostics, new Int32Array(connection.control));
    assert(after.ownedBufferBytes === 0 && after.pendingSubmissions === 0 && after.unknownCompletionBytes === 0,
      "The independently owned producer did not clean up after interpreter termination.");
    outcome = { ok: true, ...environment, mode, before, after, pythonCleanupAcknowledged: false };
  } else {
    assert(mode === "device-loss" || mode === "worker-loss", "Unknown controlled loss mode.");
    physicalWorker.postMessage({ kind: mode === "device-loss" ? "test-device-loss" : "test-worker-loss" });
    await running;
    let cleanupFailed = false;
    try { await controller.close(); }
    catch (error) { cleanupFailed = error.details?.physicalCompletion === "unknown"; }
    assert(cleanupFailed === (mode === "worker-loss"), "Incorrect physical cleanup acknowledgment.");
    await client.runPythonAsync(`
assert session.diagnostics().liveRequestLeases == 0
assert session.diagnostics().webgpu.state == 'lost'
assert session.diagnostics().webgpu.unknownCompletionBytes > 0
`);
    let bindingCloseFailed = false;
    try { await client.close(); }
    catch (error) { bindingCloseFailed = error.code === "BACKEND_STATUS_ERROR"; }
    const result = await finished;
    assert(bindingCloseFailed === (mode === "worker-loss") && result.closeFailed === bindingCloseFailed,
      "Binding close disguised unacknowledged worker loss.");
    assert(result.diagnostics.liveRequestLeases === 0, "Accounted loss retained semantic request pins.");
    outcome = { ok: true, ...environment, mode, before, diagnostics: result.diagnostics, cleanupFailed, bindingCloseFailed };
  }
} catch (error) {
  outcome = { ok: false, error: { message: String(error), stack: error?.stack } };
} finally {
  globalThis.Worker = NativeWorker;
  lifetime.abort();
  physicalWorker?.postMessage({ kind: "test-release-drain" });
  await controller?.close().catch(() => undefined);
  interpreterWorker?.terminate();
}
await report("/__phase", { phase: "runtime-finished" });
await report("/__result", outcome);
