import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectedWebGpuBackend } from "../../dist/webgpu-connected-backend.js";
import { ExecutionRequest } from "../../dist/runtime/execution-request.js";
import { TabgradError } from "../../dist/shared/errors.js";
import { GPU_ACCOUNTED, GPU_CONTROL_LENGTH, GPU_METRIC_LENGTH, readGpuMetrics, retireGpuConnection, writeGpuMetrics } from "../../dist/webgpu-connection.js";
import { publishSharedGpuFailure, publishSharedGpuDrain } from "../../dist/webgpu-shared-completion.js";

test("new synchronous backend activity retires previously drained caught failures without yielding", async () => {
  const physical = new MessageChannel();
  const supervision = new MessageChannel();
  const control = new Int32Array(new SharedArrayBuffer(GPU_CONTROL_LENGTH * 4));
  const connection = {
    connectionType: "tabgrad-webgpu", protocolVersion: 1,
    port: physical.port1, supervision: supervision.port1, control: control.buffer,
    metrics: new SharedArrayBuffer(GPU_METRIC_LENGTH * 8),
    capabilities: { device: "webgpu", computations: ["add-f32"], gradients: false, maximumTensorBytes: 1048576 },
    diagnostics: { state: "ready" },
  };
  let completion;
  physical.port1.postMessage = (packet) => {
    completion = packet.completion;
    publishSharedGpuFailure(completion, control, new TabgradError("BACKEND_STATUS_ERROR", "preparation failed"));
  };
  const backend = new ConnectedWebGpuBackend(connection);
  let retired = 0;
  try {
    for (let index = 0; index < 32; index += 1) {
      const request = new ExecutionRequest((function* () {
        return yield backend.execute({ values: [] }, new Map(), []);
      })(), () => request.advance(), () => undefined, () => { retired += 1; });
      request.advance();
      assert.throws(() => request.read(), { code: "BACKEND_STATUS_ERROR" });
      assert.equal(retired, index, "a not-yet-drained invocation still owns its pins");
      publishSharedGpuDrain(completion, control);
      backend.prepare();
      assert.equal(retired, index + 1, "the next synchronous checkpoint must account earlier physical drain");
    }
  } finally {
    Atomics.store(control, GPU_ACCOUNTED, 1);
    await backend.close();
    physical.port2.close();
    supervision.port2.close();
  }
});

test("unacknowledged worker loss preserves last owned counters as unknown completion", () => {
  const control = new Int32Array(new SharedArrayBuffer(GPU_CONTROL_LENGTH * 4));
  const metrics = new SharedArrayBuffer(GPU_METRIC_LENGTH * 8);
  const last = { state: "ready", ownedBufferBytes: 786432, peakOwnedBufferBytes: 786432,
    pendingSubmissions: 1, unknownCompletionBytes: 0, uploadBytes: 262144, readbackBytes: 0, kernelCalls: 1 };
  writeGpuMetrics(metrics, last);
  retireGpuConnection(control);
  const revoked = readGpuMetrics(metrics, last, control);
  assert.equal(revoked.unknownCompletionBytes, 0, "revocation alone is not physical loss accounting");
  Atomics.store(control, GPU_ACCOUNTED, 2);
  const lost = readGpuMetrics(metrics, last, control);
  assert.equal(lost.state, "lost");
  assert.equal(lost.ownedBufferBytes, 786432, "worker termination cannot manufacture zero ownership");
  assert.equal(lost.pendingSubmissions, 1);
  assert.equal(lost.unknownCompletionBytes, 786432);
});
