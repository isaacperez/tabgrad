import assert from "node:assert/strict";
import { test } from "node:test";
import { WebGpuBackend } from "../../../dist/backends/webgpu/webgpu-backend.js";
import { createConnectedRuntimeSession } from "../../../dist/runtime/runtime.js";
import { getTestRuntimeOwnership, getTestTensorVersion } from "../../../dist/testing.js";
import { executionDevice, deferred } from "./helpers/webgpu-device.mjs";

test("SGD zero fill publishes a new shared scalar and drains its GPU effect", async () => {
  const acquired = executionDevice(), session = createConnectedRuntimeSession(new WebGpuBackend(acquired));
  const owned = [];
  try {
    const seed = session.tensor([3], { shape: [], device: "webgpu" });
    const parameter = session.tensor([2, 3], { requiresGrad: true, device: "webgpu" });
    const loss = parameter.sum(), [gradient] = session.grad(loss, [parameter], seed);
    owned.push(seed, parameter, loss, gradient);
    parameter.grad = gradient;
    const optimizer = session.sgd([parameter], { lr: .1 });
    try { optimizer.zeroGrad(false); assert.equal(getTestTensorVersion(seed), 1); }
    finally { optimizer.close(); }
    // The device double qualifies publication/drain, not numerical words.
    assert.equal((await gradient.toArray()).length, 2);
  } finally {
    for (const value of owned.reverse()) value.close();
    await session.close();
  }
  assert.ok(acquired.buffers.every(buffer => buffer.destroyed));
  assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
  for (const value of Object.values(getTestRuntimeOwnership(session))) assert.equal(value, 0);
});

for (const length of [0, 2, 65]) {
  test(`a live sum alias permits a later capture while GPU execution is pending (${length})`, async () => {
    const gate = deferred(), started = deferred();
    let first = true;
    const acquired = executionDevice({ completion() {
      if (first) { first = false; started.resolve(); return gate.promise; }
      return Promise.resolve();
    } });
    const session = createConnectedRuntimeSession(new WebGpuBackend(acquired));
    const own = [];
    try {
      const seed = session.tensor([3], { shape: [], device: "webgpu" });
      const x = session.tensor(new Float32Array(length), { requiresGrad: true, device: "webgpu" });
      const loss = x.sum(), [gradient] = session.grad(loss, [x], seed);
      const parameter = session.tensor(new Float32Array(length), { device: "webgpu" });
      const early = gradient.mul(parameter); own.push(seed, x, loss, gradient, parameter, early);
      const pending = early.toArray();
      await started.promise;
      const late = gradient.mul(parameter); own.push(late);
      gate.resolve();
      await pending;
      assert.equal((await late.toArray()).length, length);
      const update = session.tensor([4], { shape: [], device: "webgpu" }); own.push(update);
      seed.copy_(update);
      assert.equal(getTestTensorVersion(gradient), 1);
      assert.equal((await gradient.toArray()).length, length);
    } finally {
      gate.resolve();
      for (const value of own.reverse()) value.close();
      await session.close();
    }
    assert.ok(acquired.buffers.every(buffer => buffer.destroyed));
    assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
    for (const value of Object.values(getTestRuntimeOwnership(session))) assert.equal(value, 0);
  });
}

test("one-element sum gradients use ordinary aliases without an expansion shader", async () => {
  const acquired = executionDevice(), session = createConnectedRuntimeSession(new WebGpuBackend(acquired));
  try {
    for (const shape of [[], [1], [1, 1, 1]]) {
      const input = session.tensor([2], { shape, requiresGrad: true, device: "webgpu" });
      const seed = session.tensor([3], { shape: [], device: "webgpu" }), loss = input.sum();
      const [gradient] = session.grad(loss, [input], seed);
      assert.equal((await gradient.toArray()).length, 1);
      assert.equal(acquired.shaderSources.length, 0);
      assert.equal(session.diagnostics().webgpu.kernelCalls, 0);
      const next = session.tensor([4], { shape: [], device: "webgpu" });
      seed.copy_(next);
      assert.equal(getTestTensorVersion(gradient), 1);
      for (const value of [gradient, loss, input, seed, next]) value.close();
    }
  } finally { await session.close(); }
  assert.ok(acquired.buffers.every(buffer => buffer.destroyed));
});
