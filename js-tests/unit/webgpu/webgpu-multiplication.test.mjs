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

async function flushContinuations() { await new Promise((resolve) => setImmediate(resolve)); }

function assertProductPreparationFailure(error, cause) {
  assert.equal(error.details.phase, "preparation");
  assert.equal(error.cause, cause);
  const failure = inspectExecutionFailureContext(error);
  assert.equal(failure.operation, "mul");
  assert.equal(failure.provenance.source, "Tensor.mul");
  assert.equal(failure.programValueSlot, failure.program.computations.find((step) => step.kind === "mul-f32").output);
  assert.notEqual(failure.programValueSlot, failure.program.result);
  return true;
}

test("GPU multiplication shares binary launch ownership and prepares its own pipeline", async (context) => {
  const acquired = executionDevice();
  const session = await openSession(context, acquired);
  try {
    const input = session.tensor(new Float32Array(65).fill(2), { device: "webgpu" });
    const added = input.add(input);
    await added.toArray();
    const product = added.mul(added);
    assert.equal(product.device, "webgpu");
    assert.deepEqual(product.shape, [65]);
    const before = session.diagnostics().webgpu;
    const result = await product.toArray();
    assert.equal(result.length, 65); // The double controls ownership, not arithmetic.
    assert.equal(acquired.shaderSources.length, 2);
    assert.match(acquired.shaderSources[1], /fn multiply_binary32/);
    assert.deepEqual(acquired.dispatches, [2, 2]);
    const entries = acquired.bindingGroups.at(-1);
    assert.equal(entries[0].resource.buffer, entries[1].resource.buffer);
    assert.notEqual(entries[0].resource.buffer, entries[2].resource.buffer);
    assert.equal(session.diagnostics().webgpu.uploadBytes, before.uploadBytes);
    const completed = session.diagnostics().webgpu;
    await product.toArray();
    assert.equal(session.diagnostics().webgpu.kernelCalls, completed.kernelCalls);
    const later = product.mul(added); await later.toArray();
    assert.equal(acquired.shaderSources.length, 2);
    assert.equal(session.diagnostics().webgpu.uploadBytes, before.uploadBytes);
    input.close(); added.close(); product.close(); later.close();
  } finally { await session.close(); }
  assert.ok(acquired.buffers.every((buffer) => buffer.destroyed));
  assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
});

test("multiplication preserves empty, full and partial launch boundaries", async (context) => {
  for (const length of [0, 1, 63, 64, 65, 127, 128, 129]) {
    const acquired = executionDevice(), session = await openSession(context, acquired);
    try {
      const input = session.tensor(new Float32Array(length), { device: "webgpu" });
      const output = input.mul(input);
      input.close();
      assert.equal((await output.toArray()).length, length);
      assert.deepEqual(acquired.dispatches, length ? [Math.ceil(length / 64)] : []);
      assert.match(acquired.shaderSources[0], /@compute @workgroup_size\(64\)/);
      output.close();
    } finally { await session.close(); }
    assert.ok(acquired.buffers.every((buffer) => buffer.destroyed));
  }
});

test("multiplication admission rejects shapes and foreign sessions without retained work", async (context) => {
  const session = await openSession(context, executionDevice());
  const other = await openSession(context, executionDevice());
  try {
    const input = session.tensor([1, 2], { device: "webgpu" });
    const mismatch = session.tensor([1, 2], { shape: [1, 2], device: "webgpu" });
    const broadcastable = session.tensor([1], { device: "webgpu" });
    const foreign = other.tensor([1, 2], { device: "webgpu" });
    const before = session.diagnostics();
    for (const tensor of [mismatch, broadcastable]) assert.throws(() => input.mul(tensor), { code: "SHAPE_MISMATCH" });
    assert.throws(() => input.mul(foreign), { code: "DIFFERENT_SESSION" });
    assert.deepEqual(session.diagnostics(), before);
  } finally { await session.close(); await other.close(); }
});

test("failed multiplication preparation after addition cannot reuse the addition pipeline", async (context) => {
  const cause = new Error("multiplication pipeline failed"), acquired = executionDevice();
  const pipeline = acquired.createComputePipelineAsync;
  acquired.createComputePipelineAsync = () => acquired.shaderSources.length === 2 ? Promise.reject(cause) : pipeline();
  const session = await openSession(context, acquired);
  try {
    const input = session.tensor([1], { device: "webgpu" });
    const added = input.add(input); await added.toArray(); added.close();
    const before = session.diagnostics().webgpu;
    const product = input.mul(input), total = product.sum();
    await assert.rejects(total.toArray(), (error) => assertProductPreparationFailure(error, cause));
    const pendingAddition = input.add(input), laterProduct = pendingAddition.mul(input), laterTotal = laterProduct.sum();
    await assert.rejects(laterTotal.toArray(), (error) => assertProductPreparationFailure(error, cause));
    assert.equal(session.diagnostics().webgpu.kernelCalls, before.kernelCalls);
    input.close(); product.close(); total.close(); pendingAddition.close(); laterProduct.close(); laterTotal.close();
  } finally { await session.close(); }
  assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
});

test("unobserved multiplication retires owners without preparation or buffers", async (context) => {
  const acquired = executionDevice(), session = await openSession(context, acquired);
  const input = session.tensor(new Float32Array(65), { device: "webgpu" });
  const alias = input.view([5, 13]), output = alias.mul(alias);
  input.close(); alias.close(); output.close();
  assert.equal(acquired.shaderSources.length, 0);
  assert.equal(acquired.buffers.length, 0);
  assert.equal(session.diagnostics().liveTensorValues, 0);
  assert.equal(session.diagnostics().liveOperationRecords, 0);
  await session.close();
});

test("multiplication encoding failure preserves its computation provenance and queued upload drain", async (context) => {
  const gate = deferred(), cause = new Error("multiplication binding failed");
  const acquired = executionDevice({ bindGroupError: cause, completion: () => gate.promise });
  const session = await openSession(context, acquired);
  const input = session.tensor([2], { device: "webgpu" });
  const first = input.mul(input), second = first.add(input);
  const rejected = assert.rejects(second.toArray(), (error) => {
    const failure = inspectExecutionFailureContext(error);
    assert.equal(failure.operation, "mul");
    assert.equal(failure.provenance.source, "Tensor.mul");
    assert.equal(failure.programValueSlot, failure.program.computations[0].output);
    assert.equal(error.cause, cause);
    return true;
  });
  input.close(); first.close(); second.close();
  await flushContinuations();
  assert.ok(acquired.buffers.length > 0 && acquired.buffers.every((buffer) => !buffer.destroyed));
  const closing = session.close();
  gate.resolve(); await rejected; await closing;
  assert.ok(acquired.buffers.every((buffer) => buffer.destroyed));
});

test("submitted multiplication keeps ownership through close and records unknown drain on loss", async (context) => {
  for (const lose of [false, true]) {
    const gate = deferred(), acquired = executionDevice({ completion: () => gate.promise });
    const session = await openSession(context, acquired);
    const input = session.tensor([2, 3], { device: "webgpu" }), product = input.mul(input);
    const observation = product.toArray();
    const rejection = lose ? assert.rejects(observation, (error) => {
      assert.equal(error.code, "BACKEND_STATUS_ERROR");
      assert.equal(inspectExecutionFailureContext(error).operation, "mul");
      return true;
    }) : undefined;
    input.close(); product.close();
    await flushContinuations();
    assert.equal(acquired.dispatches.length, 1);
    assert.ok(acquired.buffers.every((buffer) => !buffer.destroyed));
    assert.equal(session.diagnostics().liveRequestLeases, 1);
    const bytes = session.diagnostics().webgpu.ownedBufferBytes;
    if (lose) { acquired.lose(); await rejection; }
    const closing = session.close();
    if (!lose) { gate.resolve(); await observation; }
    await closing;
    assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
    assert.equal(session.diagnostics().webgpu.unknownCompletionBytes, lose ? bytes : 0);
    assert.ok(acquired.buffers.every((buffer) => buffer.destroyed));
    gate.resolve(); await flushContinuations();
    assert.equal(session.diagnostics().liveRequestLeases, 0);
  }
});
