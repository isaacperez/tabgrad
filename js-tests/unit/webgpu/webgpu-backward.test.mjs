import assert from "node:assert/strict";
import { test } from "node:test";
import { createConnectedRuntimeSession, completeRuntimeSession } from "../../../dist/runtime/runtime.js";
import { getTestRuntimeOwnership, getTestTensorVersion } from "../../../dist/testing.js";
import { WebGpuBackend } from "../../../dist/backends/webgpu/webgpu-backend.js";
import { executionDevice, deferred } from "./helpers/webgpu-device.mjs";
import { createWebGpuRuntimeSession, prepareRuntimeSession } from "../../../dist/runtime/runtime.js";
import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";
import { fileURLToPath } from "node:url";

const gpu = (session, data, options = {}) => session.tensor(data, { device: "webgpu", ...options });

// The device double copies stored bytes and controls completion; it executes no shaders.
test("GPU leaf acquisition preserves stored seed bits and an independent canonical slot", async () => {
  const session = createConnectedRuntimeSession(new WebGpuBackend(executionDevice()));
  try {
    const words = new Uint32Array([0x80000000, 1, 0x7f7fffff, 0x7f800000]);
    const p = gpu(session, [0, 0, 0, 0], { requiresGrad: true });
    const seed = gpu(session, new Float32Array(words.buffer));
    assert.equal(p.backward(seed), undefined);
    const gradient = p.grad;
    assert.equal(gradient, p.grad);
    assert.notEqual(gradient, seed);
    assert.equal(gradient.device, "webgpu");
    assert.equal(gradient.requiresGrad, false);
    assert.equal(getTestTensorVersion(gradient), 1);
    const next = gpu(session, [3, 4, 5, 6]); seed.copy_(next);
    assert.deepEqual([...new Uint32Array((await gradient.toArray()).buffer)], [...words]);
    const alias = gradient.view([2, 2]); p.grad = null;
    assert.equal(p.grad, null);
    assert.deepEqual([...new Uint32Array((await alias.toArray()).buffer)], [...words]);
    for (const handle of [p, seed, next, gradient, alias]) handle.close();
  } finally { await session.close(); }
});

test("GPU implicit backward seed and assigned tracked gradient stay on their device", async () => {
  const session = createConnectedRuntimeSession(new WebGpuBackend(executionDevice()));
  try {
    const p = gpu(session, [2], { shape: [], requiresGrad: true }); p.backward();
    assert.equal(p.grad.device, "webgpu");
    assert.deepEqual([...await p.grad.toArray()], [1]);
    const assigned = gpu(session, [7], { shape: [], requiresGrad: true });
    p.grad = assigned;
    assert.equal(p.grad, assigned);
    assert.equal(p.grad.requiresGrad, true);
    const ownView = p.view([]); p.grad = ownView;
    assert.equal(p.grad, ownView);
    assert.throws(() => { p.grad = p; }, { code: "INVALID_GRADIENT" });
    assert.equal(p.grad, ownView);
    assert.throws(() => session.sgd([p], { lr: 0.1 }), {
      code: "UNSUPPORTED_GRADIENT", message: "Optimizers are supported only on CPU.",
    });
  } finally { await session.close(); }
});

test("GPU gradient metadata rejects mixed devices before assignment shape and preserves state", async () => {
  const session = createConnectedRuntimeSession(new WebGpuBackend(executionDevice()));
  try {
    const p = gpu(session, [2, 3], { requiresGrad: true }), old = gpu(session, [10, 20]);
    p.grad = old;
    for (const shape of [[2], [1]]) {
      const other = session.tensor(new Float32Array(shape[0]));
      const before = getTestRuntimeOwnership(session);
      assert.throws(() => { p.grad = other; }, { code: "UNSUPPORTED_DEVICE" });
      assert.equal(p.grad, old);
      assert.deepEqual(getTestRuntimeOwnership(session), before);
      other.close();
    }
    const wrongShape = session.tensor([1], { shape: [] });
    assert.throws(() => p.backward(wrongShape), { code: "SHAPE_MISMATCH" });
    const wrongDevice = session.tensor([1, 1]);
    assert.throws(() => p.backward(wrongDevice), { code: "UNSUPPORTED_DEVICE" });
    assert.equal(p.grad, old);
  } finally { await session.close(); }
});

test("disconnected backward inputs on another enabled device remain ignored", async () => {
  const session = createConnectedRuntimeSession(new WebGpuBackend(executionDevice()));
  try {
    const p = gpu(session, [2], { shape: [], requiresGrad: true });
    const disconnected = session.tensor([3], { requiresGrad: true });
    p.backward(undefined, { inputs: [disconnected, p, p] });
    assert.equal(disconnected.grad, null);
    assert.equal(p.grad.device, "webgpu");
    assert.deepEqual([...await p.grad.toArray()], [1]);
  } finally { await session.close(); }
});

test("clearing and dropping a computed GPU gradient cannot cancel its mandatory effect", async () => {
  const completion = deferred(), submitted = deferred();
  const acquired = executionDevice({ completion: () => completion.promise });
  const submit = acquired.queue.submit;
  acquired.queue.submit = commands => { submit(commands); submitted.resolve(); };
  const session = createConnectedRuntimeSession(new WebGpuBackend(acquired));
  const p = gpu(session, [2], { requiresGrad: true }), product = p.mul(p), loss = product.sum();
  loss.backward(); const gradient = p.grad;
  assert.equal(gradient.device, "webgpu");
  p.grad = null;
  for (const handle of [gradient, p, product, loss]) handle.close();
  await submitted.promise;
  assert.equal(getTestRuntimeOwnership(session).pendingCopies, 1);
  let completed = false;
  const finish = completeRuntimeSession(session).then(() => { completed = true; });
  assert.equal(completed, false);
  completion.resolve(); await finish;
  assert.ok(Object.values(getTestRuntimeOwnership(session)).every(value => value === 0));
  await session.close();
  assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
});

test("failed GPU gradient acquisition delivers its causal responsibility once", async () => {
  const acquired = executionDevice({ scopeError: () => ({ message: "controlled gradient execution failure" }) });
  const session = createConnectedRuntimeSession(new WebGpuBackend(acquired));
  const p = gpu(session, [2], { requiresGrad: true }), product = p.mul(p), loss = product.sum();
  loss.backward(); const gradient = p.grad;
  await assert.rejects(gradient.toArray(), { code: "BACKEND_STATUS_ERROR" });
  assert.equal(getTestRuntimeOwnership(session).undeliveredEffects, 0);
  const source = gpu(session, [3]);
  assert.throws(() => session.noGrad(() => p.copy_(source)), { code: "MUTATION_FAILED" });
  await completeRuntimeSession(session);
  await session.close();
  assert.equal(session.diagnostics().webgpu.unknownCompletionBytes, 0);
});

test("a prepared CPU backend cannot rescue conservative GPU gradient owner admission", async context => {
  const server = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist", import.meta.url)));
  const origin = await server.start(), acquired = executionDevice();
  context.mock.getter(globalThis, "navigator", () => ({
    gpu: { requestAdapter: async () => ({ requestDevice: async () => acquired }) },
  }));
  const session = await createWebGpuRuntimeSession({ manifestUrl: new URL("manifest.json", origin) });
  try {
    await prepareRuntimeSession(session);
    const leaves = Array.from({ length: 64 }, () => gpu(session, [2], { shape: [], requiresGrad: true }));
    let root = leaves[0];
    for (const leaf of leaves.slice(1)) {
      const next = root.add(leaf);
      if (root !== leaves[0]) root.close();
      root = next;
    }
    const before = getTestRuntimeOwnership(session), diagnostics = session.diagnostics();
    assert.throws(() => root.backward(), { code: "RESOURCE_EXHAUSTED" });
    assert.deepEqual(getTestRuntimeOwnership(session), before);
    assert.deepEqual(session.diagnostics(), diagnostics);
    assert.ok(leaves.every(leaf => leaf.grad === null));
    root.backward(undefined, { inputs: [leaves[0]] });
    assert.equal(leaves[0].grad.device, "webgpu");
  } finally { await session.close(); await server.close(); }
});
