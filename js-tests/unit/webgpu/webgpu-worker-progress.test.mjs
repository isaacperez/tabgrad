import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { test } from "node:test";
import { ConnectedWebGpuBackend } from "../../../dist/backends/webgpu/webgpu-connected-backend.js";
import { GpuProgressNotifications } from "../../../dist/backends/webgpu/webgpu-progress-notification.js";
import { SharedGpuCompletion } from "../../../dist/backends/webgpu/webgpu-shared-completion.js";
import { GPU_CONTROL_LENGTH, GPU_METRIC_LENGTH, GPU_PULSE } from "../../../dist/backends/webgpu/webgpu-connection.js";
import { createConnectedRuntimeSession, observeTensorSynchronously } from "../../../dist/runtime/runtime.js";
import { getTestRuntimeOwnership, getTestRuntimeSemanticOwnership } from "../../../dist/testing.js";

function waitFor(control, predicate) {
  const deadline = Date.now() + 5000; // Finite test-failure guard, not a timing claim.
  while (!predicate()) {
    assert(Date.now() < deadline, "independent physical worker must make progress");
    const pulse = Atomics.load(control, GPU_PULSE);
    if (!predicate()) Atomics.wait(control, GPU_PULSE, pulse, 20);
  }
}

for (const [pending, payload] of [[8, 1], [32, 1], [128, 1], [8, 1024], [32, 1024]]) {
  test(`packaged worker/runtime failure ownership: pending=${pending}, payload=${payload}`, async () => {
    const gate = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(new URL("./helpers/physical-worker.mjs", import.meta.url), { workerData: { gate: gate.buffer, mode: "failure" } });
    const physical = new MessageChannel(), supervision = new MessageChannel();
    const control = new Int32Array(new SharedArrayBuffer(GPU_CONTROL_LENGTH * 4)), metrics = new SharedArrayBuffer(GPU_METRIC_LENGTH * 8);
    const ready = Promise.withResolvers(), closed = Promise.withResolvers(), inspection = Promise.withResolvers();
    worker.on("message", (message) => {
      if (message.kind === "ready") ready.resolve(message);
      if (message.kind === "failure") ready.reject(Error("physical setup failed"));
      if (message.kind === "closed") closed.resolve();
      if (message.kind === "inspection") inspection.resolve(message);
    });
    worker.on("error", (error) => { ready.reject(error); closed.reject(error); });
    const post = physical.port1.postMessage.bind(physical.port1), subscriptions = [], packets = [];
    physical.port1.postMessage = (packet, transferables) => {
      if (packet.kind === "watch-drain") subscriptions.push(packet);
      else if (packet.completion) packets.push(packet);
      return post(packet, transferables);
    };
    let session, input;
    try {
      worker.postMessage({ kind: "initialize", port: physical.port2, control: control.buffer, metrics }, [physical.port2]);
      const advertised = await ready.promise;
      const backend = new ConnectedWebGpuBackend({ connectionType: "tabgrad-webgpu", protocolVersion: 1,
        port: physical.port1, supervision: supervision.port1, control: control.buffer, metrics,
        capabilities: advertised.capabilities, diagnostics: advertised.diagnostics });
      session = createConnectedRuntimeSession(backend);
      input = session.tensor(new Float32Array(payload).fill(2), { device: "webgpu" });
      assert.deepEqual([...observeTensorSynchronously(session, input)], Array(payload).fill(2));
      for (let index = 0; index < pending; index += 1) {
        assert.throws(() => observeTensorSynchronously(session, input), { code: "BACKEND_STATUS_ERROR" });
        const subscription = subscriptions.at(-1);
        waitFor(control, () => (Atomics.load(new Int32Array(subscription.completion, 0, 4), 3) & 1) !== 0);
      }
      backend.prepare();
      assert.equal(session.diagnostics().liveRequestLeases, pending);
      assert.equal(backend.diagnostics().pendingSubmissions, pending);
      const original = SharedGpuCompletion.prototype.refresh;
      let visits = 0;
      SharedGpuCompletion.prototype.refresh = function () { visits += 1; return original.call(this); };
      try { for (let repetition = 0; repetition < 16; repetition += 1) backend.prepare(); }
      finally { SharedGpuCompletion.prototype.refresh = original; }
      assert.equal(visits, 0, "real endpoint acknowledgment removes unchanged prefix work");
      Atomics.store(gate, 0, pending); Atomics.notify(gate, 0);
      for (const packet of subscriptions) waitFor(control, () => Atomics.load(new Int32Array(packet.completion, 0, 4), 1) !== 0);
      backend.prepare();
      assert.equal(session.diagnostics().liveRequestLeases, 0);
      assert.equal(backend.diagnostics().pendingSubmissions, 0);
      // A subscription arriving after producer retirement needs no stored history.
      const old = subscriptions.at(-1), lateDirectory = new GpuProgressNotifications();
      const progress = lateDirectory.add(old.completion, old.requestId);
      Atomics.and(new Int32Array(old.completion, 0, 4), 3, ~1);
      physical.port1.postMessage({ ...old, progress });
      waitFor(control, () => (Atomics.load(new Int32Array(old.completion, 0, 4), 3) & 1) !== 0);
      assert.notEqual(Atomics.load(new Int32Array(progress[0].buffer), 0), 0);
      lateDirectory.delete(old.completion);
      input.close(); input = undefined; await session.close();
      assert(Object.values(getTestRuntimeOwnership(session)).every((value) => value === 0));
      assert(Object.entries(getTestRuntimeSemanticOwnership(session)).filter(([key]) => !key.startsWith("collector")).every(([, value]) => value === 0));
      worker.postMessage({ kind: "inspect" }); const final = await inspection.promise;
      assert.equal(final.observedRequestMaps, 1); assert.equal(final.liveRequests, 0);
      assert.equal(final.buffersDestroyed, true); assert.equal(final.deviceDestroyed, 1);
    } finally {
      Atomics.store(gate, 0, pending); Atomics.notify(gate, 0);
      input?.close();
      if (session) await session.close(); else worker.postMessage({ kind: "close" });
      await closed.promise; await worker.terminate();
      physical.port1.close(); supervision.port1.close(); supervision.port2.close();
    }
  });
}
