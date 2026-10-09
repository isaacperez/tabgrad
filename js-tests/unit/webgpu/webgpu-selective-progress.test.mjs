import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectedWebGpuBackend } from "../../../dist/backends/webgpu/webgpu-connected-backend.js";
import { SharedGpuCompletion, publishSharedGpuFailure, publishSharedGpuDrain } from "../../../dist/backends/webgpu/webgpu-shared-completion.js";
import { GPU_ACCOUNTED, GPU_CONTROL_LENGTH, GPU_METRIC_LENGTH } from "../../../dist/backends/webgpu/webgpu-connection.js";
import { TabgradError } from "../../../dist/shared/errors.js";

function mark(path) {
  for (const { buffer, mask } of path.toReversed()) Atomics.or(new Int32Array(buffer), 0, mask);
}

function fixture({ delayAcknowledgment = false, rejectSubscription = false } = {}) {
  const physical = new MessageChannel(), supervision = new MessageChannel();
  const control = new Int32Array(new SharedArrayBuffer(GPU_CONTROL_LENGTH * 4));
  const packets = [], subscriptions = [];
  physical.port1.postMessage = (packet) => {
    if (packet.kind === "watch-drain") {
      if (rejectSubscription) throw new Error("subscription transport failed");
      subscriptions.push(packet);
      if (!delayAcknowledgment) acknowledge(packet);
    } else if (packet.completion) {
      packets.push(packet);
      publishSharedGpuFailure(packet.completion, control, new TabgradError("BACKEND_STATUS_ERROR", "held failure"));
    }
  };
  const backend = new ConnectedWebGpuBackend({
    connectionType: "tabgrad-webgpu", protocolVersion: 1,
    port: physical.port1, supervision: supervision.port1, control: control.buffer,
    metrics: new SharedArrayBuffer(GPU_METRIC_LENGTH * 8),
    capabilities: { device: "webgpu", computations: ["add-f32"], gradients: false, maximumTensorBytes: 1048576 },
    diagnostics: { state: "ready" },
  });
  function acknowledge(packet) {
    mark(packet.progress);
    Atomics.or(new Int32Array(packet.completion, 0, 4), 3, 1);
  }
  function fail() {
    const ticket = backend.execute({ values: [] }, new Map(), []);
    let error;
    assert.throws(() => ticket.synchronous.read(), (caught) => {
      error = caught;
      return caught.code === "BACKEND_STATUS_ERROR" && caught.message === "held failure";
    });
    assert.throws(() => ticket.synchronous.read(), (caught) => caught === error);
    return { ticket, packet: packets.at(-1), error };
  }
  async function close() {
    Atomics.store(control, GPU_ACCOUNTED, 1);
    await backend.close();
    physical.port2.close(); supervision.port2.close();
  }
  return { backend, control, packets, subscriptions, fail, acknowledge, close };
}

function countRefresh(action) {
  const original = SharedGpuCompletion.prototype.refresh;
  let visits = 0;
  SharedGpuCompletion.prototype.refresh = function () { visits += 1; return original.call(this); };
  try { action(); return visits; }
  finally { SharedGpuCompletion.prototype.refresh = original; }
}

for (const pending of [8, 32, 128]) {
  for (const checkpoints of [1, 4, 16]) {
    test(`acknowledged unchanged failures: pending=${pending}, checkpoints=${checkpoints}`, async () => {
      const f = fixture();
      try {
        const failures = Array.from({ length: pending }, () => f.fail());
        const retired = [];
        failures.forEach(({ ticket }, index) => ticket.synchronous.onDrained(() => retired.push(index)));
        f.backend.prepare(); // Consume subscription hints before measuring unchanged checkpoints.
        assert.equal(retired.length, 0, "logical errors do not release physical ownership");
        assert.equal(countRefresh(() => {
          for (let index = 0; index < checkpoints; index += 1) f.backend.prepare();
        }), 0, "acknowledged unchanged records require no semantic inspection");
        for (const { packet } of failures) {
          const subscription = f.subscriptions.find((entry) => entry.completion === packet.completion);
          publishSharedGpuDrain(packet.completion, f.control, subscription?.progress);
        }
        f.backend.prepare();
        assert.deepEqual(retired, failures.map((_, index) => index));
        f.backend.prepare();
        assert.equal(retired.length, pending, "retirement occurs once");
      } finally { await f.close(); }
    });
  }
}

for (const option of [{ delayAcknowledgment: true }, { rejectSubscription: true }]) {
  test(`direct inspection survives unconfirmed subscription: ${JSON.stringify(option)}`, async () => {
    const f = fixture(option);
    try {
      const { ticket, packet } = f.fail();
      let retired = 0;
      ticket.synchronous.onDrained(() => retired += 1);
      assert.equal(countRefresh(() => f.backend.prepare()), 1);
      publishSharedGpuDrain(packet.completion, f.control);
      f.backend.prepare();
      assert.equal(retired, 1);
    } finally { await f.close(); }
  });
}

for (const accounted of [1, 2]) {
  test(`terminal accounting visits enrolled owners in admission order: ${accounted}`, async () => {
    const f = fixture();
    try {
      const retired = [];
      Array.from({ length: 32 }, () => f.fail()).forEach(({ ticket }, index) => ticket.synchronous.onDrained(() => retired.push(index)));
      f.backend.prepare();
      Atomics.store(f.control, GPU_ACCOUNTED, accounted);
      f.backend.prepare();
      assert.deepEqual(retired, Array.from({ length: 32 }, (_, i) => i));
      f.backend.prepare();
      assert.equal(retired.length, 32);
    } finally {
      Atomics.store(f.control, GPU_ACCOUNTED, 1); await f.close();
    }
  });
}

for (const failAt of Array.from({ length: 11 }, (_, index) => index + 1)) {
  test(`notification allocation failure ${failAt} preserves error and direct drain`, async () => {
    const f = fixture();
    const NativeBuffer = SharedArrayBuffer;
    let allocations = 0;
    globalThis.SharedArrayBuffer = class extends NativeBuffer {
      constructor(bytes) {
        if (bytes === 4 && ++allocations === failAt) throw new Error("notification allocation denied");
        super(bytes);
      }
    };
    let failure;
    try { failure = f.fail(); }
    finally { globalThis.SharedArrayBuffer = NativeBuffer; }
    try {
      assert.equal(allocations, failAt);
      assert.equal(countRefresh(() => f.backend.prepare()), 1);
      let retired = 0;
      failure.ticket.synchronous.onDrained(() => retired += 1);
      publishSharedGpuDrain(failure.packet.completion, f.control);
      f.backend.prepare();
      assert.equal(retired, 1);
    } finally { await f.close(); }
  });
}
