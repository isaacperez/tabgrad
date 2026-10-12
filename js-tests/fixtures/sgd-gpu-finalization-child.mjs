import assert from "node:assert/strict";
import { createConnectedRuntimeSession, completeRuntimeSession } from "../../dist/runtime/runtime.js";
import { WebGpuBackend } from "../../dist/backends/webgpu/webgpu-backend.js";
import { getTestRuntimeOwnership, getTestRuntimeSemanticOwnership } from "../../dist/testing.js";
import { executionDevice } from "../unit/webgpu/helpers/webgpu-device.mjs";

function owners(session) {
  return { ...Object.fromEntries(Object.entries(getTestRuntimeSemanticOwnership(session))
    .filter(([key]) => !key.startsWith("collector"))), ...getTestRuntimeOwnership(session) };
}

async function cycle(payload, repetitions, held) {
  const acquired = executionDevice(), session = createConnectedRuntimeSession(new WebGpuBackend(acquired));
  const p = session.tensor(new Float32Array(payload).fill(2), { device: "webgpu", requiresGrad: true });
  const optimizer = session.sgd([p], { lr: 0.125 });
  for (let index = 0; index < repetitions; index++) {
    optimizer.zeroGrad(false);
    const product = p.mul(p), loss = product.sum();
    loss.backward(); product.close(); loss.close();
    optimizer.step();
    await completeRuntimeSession(session);
  }
  const gradient = p.grad;
  p.optimizerCycle = optimizer; gradient.parameterCycle = p; optimizer.gradientCycle = gradient;
  return { session, acquired, weak: new WeakRef(optimizer), holder: held ? optimizer : undefined };
}

assert.equal(typeof globalThis.gc, "function", "Run with --expose-gc");
const rows = [];
for (const [payload, repetitions, held] of [[0, 16, false], [1, 16, false], [65, 16, false], [65, 1, false], [65, 16, true]]) {
  const state = await cycle(payload, repetitions, held);
  const witness = { collected: false };
  const registry = new FinalizationRegistry(() => { witness.collected = true; });
  let target = {}; registry.register(target, null); target = null;
  await new Promise(resolve => setImmediate(resolve));
  while (!witness.collected) { globalThis.gc(); await new Promise(resolve => setImmediate(resolve)); }
  if (held) {
    assert.notEqual(state.weak.deref(), undefined);
    assert.equal(owners(state.session).optimizerRegistrations, 1);
    assert.ok(state.session.diagnostics().webgpu.ownedBufferBytes > 0);
    state.holder = undefined;
    await new Promise(resolve => setImmediate(resolve));
  }
  while (Object.values(owners(state.session)).some(value => value !== 0)) {
    globalThis.gc(); await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(state.weak.deref(), undefined);
  await completeRuntimeSession(state.session);
  assert.equal(state.session.diagnostics().webgpu.ownedBufferBytes, 0);
  assert.ok(state.acquired.buffers.every(buffer => buffer.destroyed));
  rows.push({ payload, repetitions, held, owners: owners(state.session), buffers: state.acquired.buffers.length });
  await state.session.close();
}
console.log(JSON.stringify(rows));
