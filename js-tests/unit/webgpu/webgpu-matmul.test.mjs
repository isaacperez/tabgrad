import assert from "node:assert/strict";
import { test } from "node:test";
import { createWebGpuRuntimeSession } from "../../../dist/index.js";
import { inspectExecutionFailureContext } from "../../../dist/shared/errors.js";
import { deferred, executionDevice } from "./helpers/webgpu-device.mjs";

function openSession(context, acquired) {
  context.mock.getter(globalThis, "navigator", () => ({ gpu: {
    requestAdapter: async () => ({ requestDevice: async () => acquired }),
  } }));
  return createWebGpuRuntimeSession();
}

test("GPU matrix computations cache one pipeline and own distinct immutable geometry packets", async context => {
  const acquired = executionDevice(), session = await openSession(context, acquired);
  try {
    const a = session.tensor([1, 2, 3, 4, 5, 6], { shape: [2, 3], device: "webgpu", requiresGrad: true });
    const b = session.tensor([7, 8, 9, 10, 11, 12], { shape: [3, 2], device: "webgpu", requiresGrad: true });
    const y = a.matmul(b), seed = session.tensor([1, 2, 3, 4], { shape: [2, 2], device: "webgpu" });
    const [da, db] = session.grad(y, [a, b], seed);
    await y.toArray(); await da.toArray(); await db.toArray();
    assert.equal(acquired.shaderSources.length, 1);
    assert.match(acquired.shaderSources[0], /fn fused_multiply_add_binary32/);
    const packets = acquired.bindingGroups.map(group => group[3].resource.buffer);
    assert.equal(new Set(packets).size, 3);
    assert.deepEqual(packets.map(buffer => Array.from(new Uint32Array(buffer.data))),
      [[2, 2, 3, 0], [2, 3, 2, 2], [3, 2, 2, 1]]);
    assert.ok(packets.every(buffer => buffer.destroyed));
    for (const tensor of [a, b, y, seed, da, db]) tensor.close();
  } finally { await session.close(); }
  assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
});

test("matrix output capacity is checked independently of both accepted inputs", async context => {
  const acquired = executionDevice();
  acquired.limits.maxBufferSize = 1024; acquired.limits.maxStorageBufferBindingSize = 1024;
  const session = await openSession(context, acquired);
  try {
    const a = session.tensor(new Float32Array(65), { shape: [65, 1], device: "webgpu" });
    const b = session.tensor(new Float32Array(65), { shape: [1, 65], device: "webgpu" });
    const before = session.diagnostics();
    assert.throws(() => a.matmul(b), { code: "RESOURCE_EXHAUSTED" });
    assert.deepEqual(session.diagnostics(), before);
  } finally { await session.close(); }
});

test("empty matrix metadata keeps unused safe axes while nonempty contraction-zero work writes zeros", async context => {
  const acquired = executionDevice(), session = await openSession(context, acquired);
  try {
    const a = session.tensor([], { shape: [0, Number.MAX_SAFE_INTEGER], device: "webgpu" });
    const b = session.tensor([], { shape: [Number.MAX_SAFE_INTEGER, 0], device: "webgpu" });
    const empty = a.matmul(b); assert.deepEqual(empty.shape, [0, 0]);
    assert.equal((await empty.toArray()).length, 0);
    assert.deepEqual(acquired.dispatches, []);
    const x = session.tensor([], { shape: [3, 0], device: "webgpu" });
    const z = session.tensor([], { shape: [0, 23], device: "webgpu" });
    const output = x.matmul(z); await output.toArray();
    assert.deepEqual(acquired.dispatches, [2]);
    assert.deepEqual(Array.from(new Uint32Array(acquired.bindingGroups[0][3].resource.buffer.data)), [3, 23, 0, 0]);
  } finally { await session.close(); }
  assert.ok(acquired.buffers.every(buffer => buffer.destroyed));
});

test("matrix preparation failure preserves the failing producer behind a downstream reduction", async context => {
  const acquired = executionDevice(), cause = new Error("matrix preparation failure");
  const prepare = acquired.createComputePipelineAsync;
  acquired.createComputePipelineAsync = () => acquired.shaderSources.at(-1).includes("fn fused_multiply_add_binary32")
    ? Promise.reject(cause) : prepare();
  const session = await openSession(context, acquired);
  try {
    const a = session.tensor([2], { shape: [1, 1], device: "webgpu" });
    const y = a.matmul(a), loss = y.sum();
    await assert.rejects(loss.toArray(), error => {
      assert.equal(error.details.phase, "preparation"); assert.equal(error.cause, cause);
      const recorded = inspectExecutionFailureContext(error);
      assert.equal(recorded.operation, "matmul"); assert.equal(recorded.provenance.source, "Tensor.matmul");
      assert.notEqual(recorded.programValueSlot, recorded.program.result);
      return true;
    });
  } finally { await session.close(); }
  assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
});

test("a matrix geometry write retains physical drain after pre-submit encoding failure", async context => {
  const fence = deferred(), cause = new Error("matrix bind group failure");
  const acquired = executionDevice({ completion: () => fence.promise, bindGroupError: cause });
  const session = await openSession(context, acquired);
  const a = session.tensor([2], { shape: [1, 1], device: "webgpu" });
  const y = a.matmul(a);
  const observed = y.toArray();
  await assert.rejects(observed, error => error.cause === cause);
  assert.ok(acquired.buffers.some(buffer => buffer.data.byteLength === 16));
  assert.ok(acquired.buffers.every(buffer => !buffer.destroyed));
  let closed = false;
  const close = session.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  fence.resolve(); await close;
  assert.ok(acquired.buffers.every(buffer => buffer.destroyed));
  assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
});
