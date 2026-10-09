import { deferred, device, executionDevice } from "./helpers/webgpu-device.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as tabgrad from "../../../dist/index.js";
import { inspectExecutionFailureContext } from "../../../dist/shared/errors.js";

test("GPU capability admission rejects unsupported operators before retaining work", async (context) => {
  const acquired = device();
  installGpu(context, { requestAdapter: async () => ({ requestDevice: async () => acquired }) });
  const session = await tabgrad.createWebGpuRuntimeSession();
  try {
    const gpu = session.tensor([2], { device: "webgpu" });
    const cpu = session.tensor([3]);
    const before = session.diagnostics();
    for (const operation of [() => gpu.mul(gpu), () => gpu.add(cpu), () => cpu.add(gpu),
      () => session.grad(gpu, [gpu]), () => session.tensor([1], { device: "webgpu", requiresGrad: true })]) {
      assert.throws(operation, (error) => error instanceof tabgrad.TabgradError
        && error.details.device === "webgpu");
      assert.deepEqual(session.diagnostics(), before);
    }
    const added = gpu.add(gpu);
    assert.equal(added.device, "webgpu");
    assert.equal(added.view([]).device, "webgpu");
    assert.equal(session.diagnostics().backendLoads, 0);
  } finally { await session.close(); }
});

test("each acquired device extent rejects oversized creation without retained work", async (context) => {
  for (const [limit, bound, elements] of [["maxBufferSize", 8, 2],
    ["maxStorageBufferBindingSize", 8, 2], ["maxComputeWorkgroupsPerDimension", 1, 64]]) {
    const acquired = device();
    acquired.limits[limit] = bound;
    installGpu(context, { requestAdapter: async () => ({ requestDevice: async () => acquired }) });
    const session = await tabgrad.createWebGpuRuntimeSession();
    try {
      const exact = session.tensor(new Float32Array(elements), { device: "webgpu" });
      assert.deepEqual(exact.shape, [elements]);
      exact.close();
      const before = session.diagnostics();
      assert.throws(() => session.tensor(new Float32Array(elements + 1), { device: "webgpu" }),
        { code: "RESOURCE_EXHAUSTED" });
      assert.deepEqual(session.diagnostics(), before);
    } finally { await session.close(); }
  }
});

function installGpu(context, gpu) {
  context.mock.getter(globalThis, "navigator", () => ({ gpu }));
}

async function flushContinuations() {
  // A macrotask boundary observes settled promise chains without a timing assumption.
  await new Promise((resolve) => setImmediate(resolve));
}

test("addition launch preserves width, bindings and empty/full/partial dispatch boundaries", async (context) => {
  for (const [length, expected] of [[0, []], [1, [1]], [63, [1]], [64, [1]],
    [65, [2]], [127, [2]], [128, [2]], [129, [3]]]) {
    const acquired = executionDevice();
    installGpu(context, { requestAdapter: async () => ({ requestDevice: async () => acquired }) });
    const session = await tabgrad.createWebGpuRuntimeSession();
    try {
      const input = session.tensor(new Float32Array(length), { device: "webgpu" });
      const output = input.add(input);
      assert.equal((await output.toArray()).length, length);
      assert.deepEqual(acquired.dispatches, expected, `dispatch coverage for ${length} elements`);
      assert.equal(acquired.shaderSources.length, 1);
      assert.match(acquired.shaderSources[0], /@compute @workgroup_size\(64\)/);
      assert.equal(acquired.bindingGroups.length, expected.length);
      for (const entries of acquired.bindingGroups) {
        assert.deepEqual(entries.map(({ binding }) => binding), [0, 1, 2]);
        assert.equal(entries[0].resource.buffer, entries[1].resource.buffer);
        assert.notEqual(entries[0].resource.buffer, entries[2].resource.buffer);
      }
      input.close(); output.close();
    } finally { await session.close(); }
    assert.ok(acquired.buffers.every((buffer) => buffer.destroyed));
  }
});

test("ready GPU factory fails explicitly when WebGPU is unavailable", async (context) => {
  assert.equal(typeof tabgrad.createWebGpuRuntimeSession, "function");
  installGpu(context, undefined);
  await assert.rejects(tabgrad.createWebGpuRuntimeSession(), { code: "UNSUPPORTED_DEVICE" });
  const cpu = tabgrad.createRuntimeSession();
  const input = cpu.tensor([3]);
  assert.equal(input.device, "cpu");
  assert.deepEqual([...await input.toArray()], [3]);
  await cpu.close();
});

test("synchronous encoding failure identifies the actual computation slot", async (context) => {
  const cause = new Error("binding creation failed");
  const acquired = executionDevice({ bindGroupError: cause });
  installGpu(context, { requestAdapter: async () => ({ requestDevice: async () => acquired }) });
  const session = await tabgrad.createWebGpuRuntimeSession();
  try {
    const input = session.tensor([1], { device: "webgpu" });
    const first = input.add(input), second = first.add(input);
    await assert.rejects(second.toArray(), (error) => {
      const failure = inspectExecutionFailureContext(error);
      assert.equal(failure.programValueSlot, failure.program.computations[0].output);
      assert.notEqual(failure.programValueSlot, failure.program.result);
      assert.equal(error.cause, cause);
      return true;
    });
  } finally { await session.close(); }
});

test("GPU factory does not expose a session before device acquisition and owns close", async (context) => {
  assert.equal(typeof tabgrad.createWebGpuRuntimeSession, "function");
  const acquired = device();
  const ready = deferred();
  installGpu(context, { requestAdapter: async () => ({ requestDevice: () => ready.promise }) });
  let returned = false;
  const creating = tabgrad.createWebGpuRuntimeSession().then((session) => { returned = true; return session; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(returned, false);
  ready.resolve(acquired);
  const session = await creating;
  assert.ok(session instanceof tabgrad.RuntimeSession);
  assert.equal(session.tensor([1]).device, "cpu");
  assert.equal(session.diagnostics().backendLoads, 0);
  assert.equal(acquired.destroyed, 0);
  const closing = session.close();
  assert.equal(session.close(), closing);
  await closing;
  assert.equal(acquired.destroyed, 1);
});

test("GPU acquisition reports no adapter and preserves acquisition failures", async (context) => {
  assert.equal(typeof tabgrad.createWebGpuRuntimeSession, "function");
  installGpu(context, { requestAdapter: async () => null });
  await assert.rejects(tabgrad.createWebGpuRuntimeSession(), { code: "UNSUPPORTED_DEVICE" });
  const failure = new Error("device acquisition rejected");
  installGpu(context, { requestAdapter: async () => ({ requestDevice: async () => { throw failure; } }) });
  await assert.rejects(tabgrad.createWebGpuRuntimeSession(), (error) => (
    error.code === "BACKEND_LOAD_FAILED" && error.cause === failure
    && error.details.backend === "webgpu"
  ));
});

test("setup cancellation rejects promptly and releases a late-acquired device", async (context) => {
  assert.equal(typeof tabgrad.createWebGpuRuntimeSession, "function");
  const controller = new AbortController();
  const requested = deferred();
  const ready = deferred();
  installGpu(context, { requestAdapter: async () => ({ requestDevice: () => {
    requested.resolve(); return ready.promise;
  } }) });
  const creating = tabgrad.createWebGpuRuntimeSession({ setupAbortSignal: controller.signal });
  const rejected = assert.rejects(creating, (error) => (
    error.code === "BACKEND_LOAD_FAILED" && error.cause === controller.signal.reason
  ));
  await requested.promise;
  controller.abort();
  await rejected;
  const acquired = device();
  ready.resolve(acquired);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(acquired.destroyed, 1);
});

test("cancellation before or during adapter acquisition never requests a device", async (context) => {
  assert.equal(typeof tabgrad.createWebGpuRuntimeSession, "function");
  const controller = new AbortController();
  const adapter = deferred();
  let adapters = 0;
  let devices = 0;
  installGpu(context, { requestAdapter: () => { adapters += 1; return adapter.promise; } });
  const creating = tabgrad.createWebGpuRuntimeSession({ setupAbortSignal: controller.signal });
  const rejected = assert.rejects(creating, { code: "BACKEND_LOAD_FAILED" });
  controller.abort();
  await rejected;
  adapter.resolve({ requestDevice: () => { devices += 1; return device(); } });
  await Promise.resolve(); await Promise.resolve();
  await assert.rejects(tabgrad.createWebGpuRuntimeSession({ setupAbortSignal: controller.signal }), {
    code: "BACKEND_LOAD_FAILED",
  });
  assert.equal(adapters, 1);
  assert.equal(devices, 0);
});

test("setup signal does not revoke the returned session", async (context) => {
  assert.equal(typeof tabgrad.createWebGpuRuntimeSession, "function");
  const acquired = device();
  const controller = new AbortController();
  installGpu(context, { requestAdapter: async () => ({ requestDevice: async () => acquired }) });
  const session = await tabgrad.createWebGpuRuntimeSession({ setupAbortSignal: controller.signal });
  controller.abort();
  assert.equal(acquired.destroyed, 0);
  assert.deepEqual([...await session.tensor([7]).toArray()], [7]);
  await session.close();
  assert.equal(acquired.destroyed, 1);
});

test("failed session construction releases the acquired GPU", async (context) => {
  assert.equal(typeof tabgrad.createWebGpuRuntimeSession, "function");
  const acquired = device();
  installGpu(context, { requestAdapter: async () => ({ requestDevice: async () => acquired }) });
  await assert.rejects(tabgrad.createWebGpuRuntimeSession({ manifestUrl: "http://[" }));
  assert.equal(acquired.destroyed, 1);
});

test("cancellation during the final device handoff cannot leak an acquired device", async (context) => {
  const acquired = device();
  const controller = new AbortController();
  const ready = deferred();
  const requested = deferred();
  installGpu(context, { requestAdapter: async () => ({ requestDevice: () => { requested.resolve(); return ready.promise; } }) });
  const creating = tabgrad.createWebGpuRuntimeSession({ setupAbortSignal: controller.signal });
  const outcome = assert.rejects(creating, { code: "BACKEND_LOAD_FAILED" });
  await requested.promise;
  ready.resolve(acquired);
  queueMicrotask(() => controller.abort());
  await outcome;
  assert.equal(acquired.destroyed, 1);
});

test("factory rejects a device already lost during acquisition", async (context) => {
  const acquired = device(); acquired.lose();
  installGpu(context, { requestAdapter: async () => ({ requestDevice: async () => acquired }) });
  await assert.rejects(tabgrad.createWebGpuRuntimeSession(), { code: "BACKEND_STATUS_ERROR" });
  assert.equal(acquired.destroyed, 1);
});

test("GPU loss retires GPU admission without invalidating CPU semantics", async (context) => {
  const acquired = device();
  installGpu(context, { requestAdapter: async () => ({ requestDevice: async () => acquired }) });
  const session = await tabgrad.createWebGpuRuntimeSession();
  const gpu = session.tensor([1], { device: "webgpu" });
  const cpu = session.tensor([2]);
  acquired.lose(); await Promise.resolve();
  assert.throws(() => gpu.add(gpu), { code: "BACKEND_STATUS_ERROR" });
  await assert.rejects(gpu.toArray(), { code: "BACKEND_STATUS_ERROR" });
  assert.deepEqual([...await cpu.toArray()], [2]);
  assert.equal(session.diagnostics().webgpu.state, "lost");
  await session.close();
  assert.equal(acquired.destroyed, 1);
});

test("accepted GPU observation protects buffers through close and physical drain", async (context) => {
  const gate = deferred();
  const acquired = executionDevice({ completion: () => gate.promise });
  installGpu(context, { requestAdapter: async () => ({ requestDevice: async () => acquired }) });
  const session = await tabgrad.createWebGpuRuntimeSession();
  const input = session.tensor([2, 3], { device: "webgpu" });
  const observation = input.toArray();
  input.close(); const closing = session.close();
  await flushContinuations();
  assert.equal(acquired.destroyed, 0);
  assert.equal(acquired.buffers.some((buffer) => buffer.destroyed), false);
  assert.equal(session.diagnostics().liveRequestLeases, 1);
  gate.resolve();
  assert.deepEqual([...await observation], [2, 3]);
  await closing;
  assert.equal(acquired.buffers.every((buffer) => buffer.destroyed), true);
  assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
  assert.equal(session.diagnostics().webgpu.pendingSubmissions, 0);
});

test("readback rejection does not release resources before submitted copy drain", async (context) => {
  const gate = deferred();
  const acquired = executionDevice({ completion: (submitted) => submitted === 2 ? gate.promise : Promise.resolve(), mapError: new Error("mapping rejected") });
  installGpu(context, { requestAdapter: async () => ({ requestDevice: async () => acquired }) });
  const session = await tabgrad.createWebGpuRuntimeSession();
  const input = session.tensor([2, 3], { device: "webgpu" });
  let resultSettled = false;
  const rejected = assert.rejects(input.toArray(), (error) => error.code === "BACKEND_STATUS_ERROR" && error.details.phase === "readback")
    .then(() => { resultSettled = true; });
  const cpu = session.tensor([8]);
  let cpuResult;
  const cpuObservation = cpu.toArray().then((result) => { cpuResult = result; });
  input.close();
  await flushContinuations();
  assert.equal(resultSettled, true, "a known failure must publish independently of physical drain");
  assert.deepEqual([...cpuResult], [8]);
  assert.equal(session.diagnostics().liveRequestLeases, 1);
  let closed = false;
  const closing = session.close().then(() => { closed = true; });
  await flushContinuations();
  assert.equal(closed, false);
  assert.equal(acquired.buffers.length, 2);
  assert.equal(acquired.buffers.some((buffer) => buffer.destroyed), false);
  assert.equal(acquired.destroyed, 0);
  gate.resolve(); await rejected; await cpuObservation; await closing;
  assert.equal(acquired.buffers.every((buffer) => buffer.destroyed), true);
});

test("loss before observation retains the demanded operation context", async (context) => {
  const acquired = executionDevice();
  installGpu(context, { requestAdapter: async () => ({ requestDevice: async () => acquired }) });
  const session = await tabgrad.createWebGpuRuntimeSession();
  try {
    const input = session.tensor([2], { device: "webgpu" });
    const output = input.add(input);
    await input.toArray();
    acquired.lose(); await flushContinuations();
    for (const tensor of [output, input]) {
      await assert.rejects(tensor.toArray(), (error) => {
        const failure = inspectExecutionFailureContext(error);
        assert.ok(failure, "device loss must preserve request-scoped program context");
        assert.equal(failure.program.domain, "webgpu");
        if (tensor === output) {
          assert.equal(failure.operation, "add");
          assert.equal(failure.provenance.source, "Tensor.add");
        }
        assert.equal(error.details.phase, "device-loss");
        return true;
      });
    }
  } finally { await session.close(); }
});

test("scoped failure preserves pending mapping even after queue completion", async (context) => {
  const map = deferred(), drain = deferred();
  const acquired = executionDevice({ mapping: () => map.promise,
    completion: (submitted) => submitted === 2 ? drain.promise : Promise.resolve(),
    scopeError: (submitted) => submitted === 2 ? new Error("scoped readback failure") : null });
  installGpu(context, { requestAdapter: async () => ({ requestDevice: async () => acquired }) });
  const session = await tabgrad.createWebGpuRuntimeSession();
  const input = session.tensor([1], { device: "webgpu" });
  let failed = false;
  const rejected = assert.rejects(input.toArray(), { code: "BACKEND_STATUS_ERROR" }).then(() => { failed = true; });
  input.close(); await flushContinuations();
  assert.equal(failed, true);
  assert.equal(session.diagnostics().liveRequestLeases, 1);
  let closed = false;
  const closing = session.close().then(() => { closed = true; });
  drain.resolve(); await flushContinuations();
  assert.equal(closed, false);
  assert.equal(acquired.buffers.some((buffer) => buffer.destroyed), false);
  map.resolve(); await rejected; await closing;
  assert.equal(acquired.buffers.every((buffer) => buffer.destroyed), true);
  assert.equal(session.diagnostics().liveRequestLeases, 0);
});

test("rejected physical drain accounts loss without accepting a late map", async (context) => {
  const map = deferred(), drain = deferred();
  const acquired = executionDevice({ mapping: () => map.promise,
    completion: (submitted) => submitted === 2 ? drain.promise : Promise.resolve() });
  installGpu(context, { requestAdapter: async () => ({ requestDevice: async () => acquired }) });
  const session = await tabgrad.createWebGpuRuntimeSession();
  const input = session.tensor([1], { device: "webgpu" });
  const rejected = assert.rejects(input.toArray(), (error) => error.code === "BACKEND_STATUS_ERROR" && error.details.phase === "drain");
  await flushContinuations(); drain.reject(new Error("completion failed")); await rejected;
  await session.close();
  assert.equal(session.diagnostics().webgpu.state, "lost");
  assert.ok(session.diagnostics().webgpu.unknownCompletionBytes > 0);
  assert.equal(session.diagnostics().liveRequestLeases, 0);
  map.resolve(); await flushContinuations();
  assert.equal(session.diagnostics().liveMaterializationRecords, 0);
});

test("encoding failure after upload still owns the queued write until drain", async (context) => {
  const gate = deferred(); let drainRequested = false;
  const acquired = executionDevice({ completion: () => { drainRequested = true; return gate.promise; }, finishError: new Error("encoding failed") });
  installGpu(context, { requestAdapter: async () => ({ requestDevice: async () => acquired }) });
  const session = await tabgrad.createWebGpuRuntimeSession();
  const input = session.tensor([2, 3], { device: "webgpu" });
  const rejected = assert.rejects(input.toArray(), { code: "BACKEND_STATUS_ERROR" });
  input.close(); const closing = session.close();
  await flushContinuations();
  assert.equal(drainRequested, true);
  assert.equal(acquired.buffers.some((buffer) => buffer.destroyed), false);
  gate.resolve(); await rejected; await closing;
  assert.equal(acquired.buffers.every((buffer) => buffer.destroyed), true);
});

test("loss during submission preserves unknown physical accounting and permits CPU work", async (context) => {
  const gate = deferred();
  const acquired = executionDevice({ completion: () => gate.promise });
  installGpu(context, { requestAdapter: async () => ({ requestDevice: async () => acquired }) });
  const session = await tabgrad.createWebGpuRuntimeSession();
  const input = session.tensor([2, 3], { device: "webgpu" });
  const rejected = assert.rejects(input.toArray(), { code: "BACKEND_STATUS_ERROR" });
  input.close();
  await flushContinuations();
  acquired.lose(); await rejected;
  assert.ok(session.diagnostics().webgpu.unknownCompletionBytes >= 8);
  assert.equal(session.diagnostics().webgpu.pendingSubmissions, 1);
  const cpu = session.tensor([8]);
  assert.deepEqual([...await cpu.toArray()], [8]);
  await session.close();
  assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
  assert.ok(session.diagnostics().webgpu.unknownCompletionBytes >= 8);
  gate.resolve(); await flushContinuations();
  assert.equal(session.diagnostics().webgpu.state, "lost");
  assert.equal(session.diagnostics().liveMaterializationRecords, 0);
});


test("total sum traverses input stages and prepares independently after addition", async (context) => {
  for (const [length, counts] of [[0, [0]], [1, [1]], [128, [128]], [129, [129, 2]],
    [16384, [16384, 128]], [16385, [16385, 129, 2]]]) {
    const acquired = executionDevice();
    installGpu(context, { requestAdapter: async () => ({ requestDevice: async () => acquired }) });
    const session = await tabgrad.createWebGpuRuntimeSession();
    try {
      const input = session.tensor(new Float32Array(length), { device: "webgpu" });
      const addition = input.add(input);
      await addition.toArray(); addition.close(); await flushContinuations();
      const previousGroups = acquired.bindingGroups.length;
      const previousDispatches = acquired.dispatches.length;
      const total = input.sum();
      assert.deepEqual(total.shape, []); assert.equal(total.device, "webgpu");
      assert.equal((await total.toArray()).length, 1);
      assert.equal(acquired.shaderSources.length, 2, "addition readiness must not bypass sum preparation");
      assert.deepEqual(acquired.dispatches.slice(previousDispatches), counts.map((n) => Math.max(1, Math.ceil(n / 128))));
      const groups = acquired.bindingGroups.slice(previousGroups);
      assert.equal(groups.length, counts.length);
      for (const [stage, entries] of groups.entries()) {
        assert.deepEqual(entries.map(({ binding }) => binding), [0, 1, 2]);
        assert.notEqual(entries[0].resource.buffer, entries[1].resource.buffer);
        assert.deepEqual([...new Uint32Array(entries[2].resource.buffer.data)],
          [counts[stage], Number(stage === counts.length - 1), Number(stage !== 0), 0]);
        if (stage !== 0) assert.equal(entries[0].resource.buffer, groups[stage - 1][1].resource.buffer);
      }
      await flushContinuations();
      assert.equal(session.diagnostics().webgpu.ownedBufferBytes, Math.max(4, length * 4) + 4, "private partials/parameters must drain, not remain cached");
      const twice = total.sum(); await twice.toArray(); twice.close();
      assert.equal(acquired.shaderSources.length, 2, "sum pipeline should be reused");
      input.close(); total.close();
    } finally { await session.close(); }
    assert.ok(acquired.buffers.every((buffer) => buffer.destroyed));
  }
});


test("sum parameter writes on resident or empty input survive failed encoding until drain", async (context) => {
  for (const length of [0, 1, 16385]) {
    const gate = deferred(); let failing = false;
    const acquired = executionDevice({ completion: () => failing ? gate.promise : Promise.resolve() });
    const encode = acquired.createCommandEncoder;
    acquired.createCommandEncoder = () => {
      const encoder = encode();
      const finish = encoder.finish;
      encoder.finish = () => { if (failing) throw new Error("sum encoding failure"); return finish(); };
      return encoder;
    };
    installGpu(context, { requestAdapter: async () => ({ requestDevice: async () => acquired }) });
    const session = await tabgrad.createWebGpuRuntimeSession();
    let closing;
    try {
      const input = session.tensor(new Float32Array(length), { device: "webgpu" });
      await input.toArray(); await flushContinuations();
      const oldBuffers = new Set(acquired.buffers);
      failing = true;
      const total = input.sum();
      const rejected = assert.rejects(total.toArray(), { code: "BACKEND_STATUS_ERROR" });
      input.close(); total.close(); closing = session.close();
      await rejected; await flushContinuations();
      const temporary = acquired.buffers.filter((buffer) => !oldBuffers.has(buffer));
      assert.ok(temporary.length >= 2, "scalar and immutable parameters were allocated");
      assert.ok(temporary.every((buffer) => !buffer.destroyed), "queued sum writes remain physically owned");
      assert.equal(acquired.destroyed, 0, "close must wait for those writes");
      gate.resolve(); await closing;
      assert.ok(temporary.every((buffer) => buffer.destroyed));
      assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
    } finally { gate.resolve(); await (closing ?? session.close()); }
  }
});


test("sum stage failure retains private resources and operation provenance through loss", async (context) => {
  const gate = deferred(); let failing = false, stages = 0;
  const cause = new Error("second sum stage failed");
  const acquired = executionDevice({ completion: () => failing ? gate.promise : Promise.resolve() });
  const bind = acquired.createBindGroup;
  acquired.createBindGroup = (descriptor) => {
    if (failing && ++stages === 2) throw cause;
    return bind(descriptor);
  };
  installGpu(context, { requestAdapter: async () => ({ requestDevice: async () => acquired }) });
  const session = await tabgrad.createWebGpuRuntimeSession();
  const input = session.tensor(new Float32Array(16385), { device: "webgpu" });
  await input.toArray(); await flushContinuations();
  const baseline = new Set(acquired.buffers);
  failing = true;
  const total = input.sum();
  const rejected = assert.rejects(total.toArray(), (error) => {
    const context = inspectExecutionFailureContext(error);
    assert.equal(context.programValueSlot, context.program.result);
    assert.equal(error.cause, cause); return true;
  });
  input.close(); total.close();
  await rejected; await flushContinuations();
  const owned = acquired.buffers.filter((buffer) => !baseline.has(buffer));
  assert.ok(owned.length >= 5 && owned.every((buffer) => !buffer.destroyed));
  assert.equal(session.diagnostics().liveRequestLeases, 1);
  const bytes = session.diagnostics().webgpu.ownedBufferBytes;
  acquired.lose(); await session.close();
  assert.equal(session.diagnostics().webgpu.unknownCompletionBytes, bytes);
  assert.equal(session.diagnostics().webgpu.pendingSubmissions, 1);
  assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
  assert.ok(owned.every((buffer) => buffer.destroyed));
  gate.resolve(); await flushContinuations();
  assert.equal(session.diagnostics().webgpu.unknownCompletionBytes, bytes);
});

test("sum preparation failure after successful addition is not bypassed", async (context) => {
  const cause = new Error("sum pipeline failed");
  const acquired = executionDevice();
  const pipeline = acquired.createComputePipelineAsync;
  acquired.createComputePipelineAsync = () => acquired.shaderSources.length === 2 ? Promise.reject(cause) : pipeline();
  installGpu(context, { requestAdapter: async () => ({ requestDevice: async () => acquired }) });
  const session = await tabgrad.createWebGpuRuntimeSession();
  try {
    const input = session.tensor([1], { device: "webgpu" });
    const addition = input.add(input); await addition.toArray(); addition.close();
    const calls = session.diagnostics().webgpu.kernelCalls;
    const total = input.sum();
    await assert.rejects(total.toArray(), (error) => error.details.phase === "preparation" && error.cause === cause);
    assert.equal(session.diagnostics().webgpu.kernelCalls, calls);
    input.close(); total.close();
  } finally { await session.close(); }
});

test("sum admission respects acquired parameter and workgroup limits before retaining work", async (context) => {
  for (const [limit, value] of [["maxBufferSize", 8], ["maxComputeWorkgroupStorageSize", 2815],
    ["maxComputeWorkgroupSizeX", 63], ["maxComputeInvocationsPerWorkgroup", 63]]) {
    const acquired = device(); acquired.limits[limit] = value;
    installGpu(context, { requestAdapter: async () => ({ requestDevice: async () => acquired }) });
    const session = await tabgrad.createWebGpuRuntimeSession();
    try {
      const input = session.tensor([1], { device: "webgpu" });
      const before = session.diagnostics();
      assert.throws(() => input.sum(), { code: "BACKEND_CAPABILITY_MISMATCH" });
      assert.deepEqual(session.diagnostics(), before);
      input.close();
    } finally { await session.close(); }
  }
});

test("dropping all owners of an unobserved sum launches no GPU work", async (context) => {
  const acquired = executionDevice();
  installGpu(context, { requestAdapter: async () => ({ requestDevice: async () => acquired }) });
  const session = await tabgrad.createWebGpuRuntimeSession();
  const input = session.tensor(new Float32Array(16385), { device: "webgpu" });
  const view = input.view([5, 3277]);
  const total = view.sum();
  input.close(); view.close(); total.close();
  assert.equal(acquired.shaderSources.length, 0);
  assert.equal(acquired.buffers.length, 0);
  assert.equal(session.diagnostics().liveTensorValues, 0);
  assert.equal(session.diagnostics().liveOperationRecords, 0);
  await session.close();
});

test("submitted multistage sum protects private buffers through immediate session close", async (context) => {
  const gate = deferred();
  const acquired = executionDevice({ completion: () => gate.promise });
  installGpu(context, { requestAdapter: async () => ({ requestDevice: async () => acquired }) });
  const session = await tabgrad.createWebGpuRuntimeSession();
  const input = session.tensor(new Float32Array(16385), { device: "webgpu" });
  const total = input.sum();
  const observation = total.toArray();
  input.close(); total.close();
  const closing = session.close();
  try {
    await flushContinuations();
    assert.equal(acquired.dispatches.length, 3);
    assert.ok(acquired.buffers.length >= 7);
    assert.equal(acquired.buffers.some((buffer) => buffer.destroyed), false);
    assert.equal(acquired.destroyed, 0);
    assert.equal(session.diagnostics().liveRequestLeases, 1);
  } finally { gate.resolve(); }
  await observation; await closing;
  assert.equal(acquired.buffers.every((buffer) => buffer.destroyed), true);
  assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
  assert.equal(session.diagnostics().webgpu.pendingSubmissions, 0);
});
