import assert from "node:assert/strict";
import { test } from "node:test";
import { createWebGpuRuntimeSession } from "../../../dist/index.js";
import { deferred, executionDevice } from "./helpers/webgpu-device.mjs";
import { inspectExecutionFailureContext } from "../../../dist/shared/errors.js";

function openSession(context, acquired) {
  context.mock.getter(globalThis, "navigator", () => ({ gpu: {
    requestAdapter: async () => ({ requestDevice: async () => acquired }),
  } }));
  return createWebGpuRuntimeSession();
}

test("GPU functional gradients use resident derivative operations without accumulating leaf state", async (context) => {
  const acquired = executionDevice(), session = await openSession(context, acquired);
  try {
    const input = session.tensor(new Float32Array(65).fill(2), { device: "webgpu", requiresGrad: true });
    const product = input.mul(input), loss = product.sum();
    const [gradient, repeated] = session.grad(loss, [input, input]);
    assert.notEqual(gradient, repeated);
    assert.equal(gradient.device, "webgpu");
    assert.deepEqual(gradient.shape, [65]);
    assert.equal(gradient.requiresGrad, false);
    assert.equal(input.grad, null);
    assert.equal(session.diagnostics().liveSavedValues, 0);
    product.close(); loss.close(); input.close(); repeated.close();
    assert.equal((await gradient.toArray()).length, 65);
    // This device double measures dispatch/ownership, not arithmetic.
    assert.deepEqual(acquired.dispatches, [2, 2, 2, 2]);
    assert.equal(session.diagnostics().webgpu.readbackBytes, 65 * 4);
    assert.equal(session.diagnostics().webgpu.uploadBytes, 65 * 4 + 4);
    const completed = session.diagnostics().webgpu;
    await gradient.toArray();
    assert.equal(session.diagnostics().webgpu.kernelCalls, completed.kernelCalls);
    gradient.close();
  } finally { await session.close(); }
  assert.ok(acquired.buffers.every((buffer) => buffer.destroyed));
  assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
  assert.equal(session.diagnostics().liveDerivativeNodes, 0);
});

test("GPU gradient state preserves device boundaries and optimizer exclusion", async (context) => {
  const session = await openSession(context, executionDevice());
  try {
    const gpu = session.tensor([2], { device: "webgpu", requiresGrad: true });
    const gpuSeed = session.tensor([1], { device: "webgpu" });
    const cpu = session.tensor([3], { requiresGrad: true }), cpuSeed = session.tensor([1]);
    const before = session.diagnostics();
    assert.throws(() => session.sgd([gpu], { lr: 0.1 }), { code: "UNSUPPORTED_GRADIENT" });
    for (const action of [() => { gpu.grad = cpuSeed; }, () => { cpu.grad = gpuSeed; },
      () => cpu.backward(gpuSeed)]) {
      assert.throws(action, { code: "UNSUPPORTED_DEVICE" });
      assert.deepEqual(session.diagnostics(), before);
    }
    cpu.backward(undefined, { inputs: [gpu] });
    assert.equal(cpu.grad, null); assert.equal(gpu.grad, null);
    gpu.grad = gpuSeed; assert.equal(gpu.grad, gpuSeed); gpu.grad = null;
    cpu.backward();
    const accumulated = cpu.grad;
    assert.deepEqual([...await accumulated.toArray()], [1]); accumulated.close();
    gpu.close(); gpuSeed.close(); cpu.close(); cpuSeed.close();
  } finally { await session.close(); }
});

test("invalid GPU gradient seeds and ordered request access leave valid history available", async (context) => {
  const session = await openSession(context, executionDevice());
  const other = await openSession(context, executionDevice());
  try {
    const x = session.tensor([2, 3], { device: "webgpu", requiresGrad: true }), square = x.mul(x);
    const seed = session.tensor([1, 1], { device: "webgpu" });
    const cpuSeed = session.tensor([1, 1]);
    const wrongShape = session.tensor([1], { device: "webgpu" });
    const foreign = other.tensor([1, 1], { device: "webgpu" });
    const disconnected = session.tensor([4, 5], { device: "webgpu", requiresGrad: true });
    const before = session.diagnostics();
    for (const [call, code] of [[() => session.grad(square, [x]), "INVALID_GRADIENT"],
      [() => session.grad(square, [x], cpuSeed), "UNSUPPORTED_DEVICE"],
      [() => session.grad(square, [x], wrongShape), "SHAPE_MISMATCH"],
      [() => session.grad(square, [x], foreign), "DIFFERENT_SESSION"],
      [() => session.grad(square, [x], x), "UNSUPPORTED_GRADIENT"],
      [() => session.grad(square, [disconnected], seed), "UNUSED_INPUT"],
      [() => session.grad(square, [, x], seed), "INVALID_TENSOR"]]) {
      assert.throws(call, { code }); assert.deepEqual(session.diagnostics(), before);
    }
    const effects = [], original = new Error("ordered getter"), requested = [x, x];
    Object.defineProperty(requested, 0, { get() { effects.push(0); return x; } });
    Object.defineProperty(requested, 1, { get() { effects.push(1); throw original; } });
    assert.throws(() => session.grad(square, requested, seed), (error) => error === original);
    assert.deepEqual(effects, [0, 1]); assert.deepEqual(session.diagnostics(), before);
    const [gradient] = session.grad(square, [x], seed);
    assert.equal(session.diagnostics().liveSavedValues, 0);
    assert.throws(() => session.grad(square, [x], seed), { code: "CONSUMED_HISTORY" });
    gradient.close(); x.close(); square.close(); seed.close(); cpuSeed.close(); wrongShape.close(); foreign.close(); disconnected.close();
  } finally { await session.close(); await other.close(); }
});

test("GPU scalar expansion has unary independent output bindings and empty/tail launches", async (context) => {
  for (const length of [0, 1, 63, 64, 65, 127, 128, 129]) {
    const acquired = executionDevice(), session = await openSession(context, acquired);
    try {
      const x = session.tensor(new Float32Array(length), { device: "webgpu", requiresGrad: true });
      const sum = x.sum(), [gradient] = session.grad(sum, [x]);
      sum.close(); x.close();
      assert.equal((await gradient.toArray()).length, length);
      assert.deepEqual(acquired.dispatches, length ? [Math.ceil(length / 64)] : []);
      assert.equal(acquired.shaderSources.length, 1);
      assert.match(acquired.shaderSources[0], /output\[index\] = scalar\[0\]/);
      for (const entries of acquired.bindingGroups) {
        assert.deepEqual(entries.map(({ binding }) => binding), [0, 1]);
        assert.notEqual(entries[0].resource.buffer, entries[1].resource.buffer);
      }
      assert.equal(session.diagnostics().webgpu.uploadBytes, 4);
      const later = session.tensor([2], { device: "webgpu", requiresGrad: true });
      const loss = later.sum(), [second] = session.grad(loss, [later]);
      await second.toArray();
      assert.equal(acquired.shaderSources.length, 1);
      gradient.close(); second.close(); loss.close(); later.close();
    } finally { await session.close(); }
    assert.ok(acquired.buffers.every((buffer) => buffer.destroyed));
  }
});

test("expansion preparation failure preserves derivative provenance without restoring consumed saves", async (context) => {
  const acquired = executionDevice(), cause = new Error("expansion preparation failed");
  const compile = acquired.createComputePipelineAsync;
  acquired.createComputePipelineAsync = () => acquired.shaderSources.at(-1).includes("scalar[0]") ? Promise.reject(cause) : compile();
  const session = await openSession(context, acquired);
  try {
    const x = session.tensor([2, 3], { device: "webgpu", requiresGrad: true });
    const square = x.mul(x), sum = square.sum();
    const [gradient] = session.grad(sum, [x]);
    assert.equal(session.diagnostics().liveSavedValues, 0);
    await assert.rejects(gradient.toArray(), (error) => {
      assert.equal(error.cause, cause); assert.equal(error.details.phase, "preparation");
      const context = inspectExecutionFailureContext(error);
      assert.equal(context.provenance.source, "DerivativeHistory.sum");
      assert.equal(context.programValueSlot, context.program.computations.find(({ kind }) => kind === "expand-f32").output);
      return true;
    });
    assert.throws(() => session.grad(sum, [x]), { code: "CONSUMED_HISTORY" });
    const laterSum = x.sum(), [later] = session.grad(laterSum, [x]);
    await assert.rejects(later.toArray(), (error) => {
      const context = inspectExecutionFailureContext(error);
      assert.equal(error.cause, cause);
      assert.equal(context.provenance.source, "DerivativeHistory.sum");
      assert.deepEqual(context.program.computations.map(({ kind }) => kind), ["expand-f32"]);
      assert.equal(context.programValueSlot, context.program.computations[0].output);
      return true;
    });
    assert.equal(acquired.shaderSources.filter((source) => source.includes("scalar[0]")).length, 1);
    later.close(); laterSum.close();
    x.close(); square.close(); sum.close(); gradient.close();
  } finally { await session.close(); }
  assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
});

test("abandoned GPU derivatives acquire no physical work or surviving history", async (context) => {
  const acquired = executionDevice(), session = await openSession(context, acquired);
  for (let repetition = 0; repetition < 16; repetition++) {
    const x = session.tensor([2, 3], { device: "webgpu", requiresGrad: true });
    const product = x.mul(x), sum = product.sum(), [gradient] = session.grad(sum, [x]);
    x.close(); product.close(); sum.close(); gradient.close();
    const state = session.diagnostics();
    for (const key of ["liveTensorHandles", "liveTensorValues", "liveOperationRecords", "liveDerivativeNodes", "liveSavedValues", "liveRequestLeases"]) {
      assert.equal(state[key], 0, `${key} after iteration ${repetition}`);
    }
  }
  assert.equal(acquired.shaderSources.length, 0); assert.equal(acquired.buffers.length, 0);
  await session.close();
});

for (const phase of ["encoding", "submission", "readback"]) {
  test(`GPU derivative ${phase} failure retires ordinary execution ownership`, async (context) => {
    const cause = new Error(`derivative ${phase} failed`);
    const acquired = executionDevice(phase === "encoding" ? { bindGroupError: cause }
      : phase === "readback" ? { mapError: cause } : {});
    if (phase === "submission") acquired.queue.submit = () => { throw cause; };
    const session = await openSession(context, acquired);
    const x = session.tensor([2], { device: "webgpu", requiresGrad: true });
    const sum = x.sum(), [gradient] = session.grad(sum, [x]);
    await assert.rejects(gradient.toArray(), (error) => error.cause === cause);
    gradient.close(); sum.close(); x.close(); await session.close();
    assert.equal(session.diagnostics().liveRequestLeases, 0);
    assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
    assert.ok(acquired.buffers.every((buffer) => buffer.destroyed));
  });
}

for (const phase of ["encoding", "submission", "readback"]) {
  test(`same-session GPU derivative ${phase} failures and recoveries retain only fixed owners`, async (context) => {
    const cause = new Error(`recoverable ${phase} failure`);
    let failing = false;
    const acquired = executionDevice({ mapping: () => failing && phase === "readback" ? Promise.reject(cause) : Promise.resolve() });
    const bind = acquired.createBindGroup, submit = acquired.queue.submit;
    acquired.createBindGroup = (descriptor) => {
      if (failing && phase === "encoding") throw cause;
      return bind(descriptor);
    };
    acquired.queue.submit = (commands) => {
      if (failing && phase === "submission") throw cause;
      return submit(commands);
    };
    const session = await openSession(context, acquired);
    try {
      const input = session.tensor([2, 3], { device: "webgpu", requiresGrad: true });
      await input.toArray();
      await new Promise((resolve) => setImmediate(resolve));
      const baseline = session.diagnostics();
      const fixedBuffers = acquired.buffers.filter((buffer) => !buffer.destroyed);
      assert.equal(fixedBuffers.length, 1);
      for (let repetition = 0; repetition < 16; repetition++) {
        for (const shouldFail of [true, false]) {
          const product = input.mul(input), loss = product.sum(), [gradient] = session.grad(loss, [input]);
          assert.equal(session.diagnostics().liveSavedValues, 0);
          failing = shouldFail;
          if (shouldFail) await assert.rejects(gradient.toArray(), (error) => error.cause === cause);
          else assert.equal((await gradient.toArray()).length, 2);
          // The double checks ownership and recovery, not derivative arithmetic.
          gradient.close(); loss.close(); product.close();
          await new Promise((resolve) => setImmediate(resolve));
          const state = session.diagnostics();
          for (const key of ["liveTensorHandles", "liveTensorValues", "liveOperationRecords", "liveMaterializationRecords", "liveDerivativeNodes", "liveSavedValues", "liveRequestLeases"]) {
            assert.equal(state[key], baseline[key], `${key}: repetition ${repetition}, failure ${shouldFail}`);
          }
          assert.equal(state.webgpu.ownedBufferBytes, baseline.webgpu.ownedBufferBytes);
          assert.equal(state.webgpu.pendingSubmissions, 0);
          assert.equal(state.webgpu.unknownCompletionBytes, 0);
          assert.deepEqual(acquired.buffers.filter((buffer) => !buffer.destroyed), fixedBuffers);
        }
      }
      input.close();
    } finally { await session.close(); }
    assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
    assert.ok(acquired.buffers.every((buffer) => buffer.destroyed));
  });
}

test("pending GPU derivative close waits for actual drain", async (context) => {
  const gate = deferred(), started = deferred();
  const acquired = executionDevice({ completion() { started.resolve(); return gate.promise; } });
  const session = await openSession(context, acquired);
  const x = session.tensor([2], { device: "webgpu", requiresGrad: true }), sum = x.sum();
  const [gradient] = session.grad(sum, [x]);
  const observed = gradient.toArray();
  await started.promise;
  gradient.close(); sum.close(); x.close();
  let settled = false; const closing = session.close().then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false); assert.ok(session.diagnostics().webgpu.pendingSubmissions > 0);
  gate.resolve(); assert.equal((await observed).length, 1); await closing;
  assert.equal(session.diagnostics().liveRequestLeases, 0);
  assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
});

test("derivative device loss reports unknown drain and releases saved/history owners", async (context) => {
  const gate = deferred(), started = deferred();
  const acquired = executionDevice({ completion() { started.resolve(); return gate.promise; } });
  const session = await openSession(context, acquired);
  const x = session.tensor([2], { device: "webgpu", requiresGrad: true }), sum = x.sum();
  const [gradient] = session.grad(sum, [x]);
  const observed = gradient.toArray();
  const rejection = assert.rejects(observed, { code: "BACKEND_STATUS_ERROR" });
  await started.promise;
  const bytes = session.diagnostics().webgpu.ownedBufferBytes;
  acquired.lose(); await rejection;
  gradient.close(); sum.close(); x.close(); await session.close();
  assert.equal(session.diagnostics().webgpu.unknownCompletionBytes, bytes);
  assert.equal(session.diagnostics().liveSavedValues, 0);
  assert.equal(session.diagnostics().liveDerivativeNodes, 0);
  gate.resolve(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.diagnostics().liveRequestLeases, 0);
});
