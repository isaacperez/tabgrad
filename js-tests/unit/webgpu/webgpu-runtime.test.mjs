import assert from "node:assert/strict";
import { test } from "node:test";
import * as tabgrad from "../../../dist/index.js";
import { inspectExecutionFailureContext } from "../../../dist/shared/errors.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

/** Acquisition-only double: numerical qualification uses a real browser/device. */
function device() {
  const loss = deferred();
  return {
    destroyed: 0,
    lost: loss.promise,
    lose: () => loss.resolve({ reason: "unknown", message: "injected device loss" }),
    features: new Set(),
    adapterInfo: { vendor: "test", architecture: "test", description: "acquisition double", device: "", isFallbackAdapter: false },
    limits: { maxBufferSize: 268435456, maxStorageBufferBindingSize: 134217728,
      maxComputeWorkgroupsPerDimension: 65535, maxComputeWorkgroupSizeX: 256,
      maxComputeInvocationsPerWorkgroup: 256, maxStorageBuffersPerShaderStage: 8 },
    destroy() { this.destroyed += 1; loss.resolve({ reason: "destroyed", message: "" }); },
  };
}

test("GPU capability admission rejects unsupported operators before retaining work", async (context) => {
  const acquired = device();
  installGpu(context, { requestAdapter: async () => ({ requestDevice: async () => acquired }) });
  const session = await tabgrad.createWebGpuRuntimeSession();
  try {
    const gpu = session.tensor([2], { device: "webgpu" });
    const cpu = session.tensor([3]);
    const before = session.diagnostics();
    for (const operation of [() => gpu.mul(gpu), () => gpu.sum(), () => gpu.add(cpu), () => cpu.add(gpu),
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

/** Controls completion/error events only; this double does not execute shaders. */
function executionDevice({ completion = () => Promise.resolve(), finishError, mapError,
  mapping = () => Promise.resolve(), scopeError = () => null, bindGroupError } = {}) {
  const acquired = device();
  const buffers = [];
  const shaderSources = [];
  const dispatches = [];
  const bindingGroups = [];
  let scopes = 0;
  let submitted = 0;
  return Object.assign(acquired, {
    buffers,
    shaderSources, dispatches, bindingGroups,
    createShaderModule({ code }) { shaderSources.push(code); return {}; },
    async createComputePipelineAsync() { return { getBindGroupLayout() { return {}; } }; },
    createBindGroup({ entries }) {
      if (bindGroupError !== undefined) throw bindGroupError;
      bindingGroups.push(entries); return {};
    },
    pushErrorScope() { scopes += 1; },
    popErrorScope() { scopes -= 1; return Promise.resolve(scopes === 0 ? scopeError(submitted) : null); },
    createBuffer({ size }) {
      const buffer = {
        data: new ArrayBuffer(size), destroyed: false,
        destroy() { this.destroyed = true; },
        mapAsync() { return mapError === undefined ? mapping() : Promise.reject(mapError); },
        getMappedRange() { assert.equal(this.destroyed, false); return this.data; }, unmap() {},
      };
      buffers.push(buffer); return buffer;
    },
    createCommandEncoder() {
      const copies = [];
      return {
        beginComputePass() { return { setPipeline() {}, setBindGroup() {},
          dispatchWorkgroups(count) { dispatches.push(count); }, end() {} }; },
        copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, bytes) {
          copies.push(() => new Uint8Array(destination.data, destinationOffset, bytes).set(new Uint8Array(source.data, sourceOffset, bytes)));
        },
        finish() { if (finishError !== undefined) throw finishError; return copies; },
      };
    },
    queue: {
      writeBuffer(buffer, offset, data) { new Uint8Array(buffer.data, offset, data.byteLength).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)); },
      submit(commands) { submitted += 1; for (const command of commands) for (const copy of command) copy(); },
      onSubmittedWorkDone() { return completion(submitted); },
    },
  });
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
