import assert from "node:assert/strict";
import { test } from "node:test";
import { createConnectedRuntimeSession, completeRuntimeSession, observeTensorSynchronously } from "../../../dist/runtime/runtime.js";
import { getTestRuntimeOwnership, getTestTensorVersion } from "../../../dist/testing.js";
import { SharedGpuCompletion, publishSharedGpuSuccess, publishSharedGpuFailure, publishSharedGpuDrain } from "../../../dist/backends/webgpu/webgpu-shared-completion.js";
import { GPU_CONTROL_LENGTH } from "../../../dist/backends/webgpu/webgpu-connection.js";
import { WebGpuBackend } from "../../../dist/backends/webgpu/webgpu-backend.js";
import { TabgradError } from "../../../dist/shared/errors.js";
import { ExecutionTicket } from "../../../dist/execution/execution-ticket.js";
import { executionDevice, deferred } from "./helpers/webgpu-device.mjs";

/** Controls shared completion/ownership only; numerical qualification uses physical GPU. */
class CopyBackend {
  capabilities = { device: "webgpu", computations: ["add-f32", "mul-f32", "sum-f32", "expand-f32"], gradients: true, maximumTensorBytes: 134217728 };
  ready = true;
  synchronousObservation = true;
  control = new Int32Array(new SharedArrayBuffer(GPU_CONTROL_LENGTH * 4));
  allocations = new Set();
  requests = [];
  failure;
  executes = 0;
  assertAvailable() { if (this.failure) throw this.failure; }
  prepare() { this.assertAvailable(); }
  diagnostics() { return { state: this.failure ? "lost" : "ready", ownedBufferBytes: this.allocations.size * 4 }; }
  execute(program, bindings) {
    this.assertAvailable(); this.executes += 1;
    const results = new Map(), created = [];
    for (const value of program.values) {
      if (value.slot !== value.storageSlot) continue;
      const resident = bindings.get(value.slot)?.resident ?? {};
      if (!this.allocations.has(resident)) created.push(resident);
      this.allocations.add(resident); results.set(value.slot, resident);
    }
    let decoded = false;
    const completion = new SharedGpuCompletion(this.control, 0, () => { decoded = true; return results; },
      () => { if (!decoded) for (const value of created) this.allocations.delete(value); });
    this.requests.push(completion); return completion.ticket;
  }
  read(_allocation, length) { this.assertAvailable(); return new Float32Array(length); }
  release(allocation) { assert.ok(this.allocations.delete(allocation), "duplicate allocation retirement"); }
  async close() { this.allocations.clear(); }
  publish(index, failure, drained = true) {
    const request = this.requests[index];
    if (failure) { publishSharedGpuFailure(request.buffer, this.control, failure); if (drained) publishSharedGpuDrain(request.buffer, this.control); }
    else publishSharedGpuSuccess(request.buffer, this.control, new Uint8Array());
    request.refresh();
  }
  drain(index) { const request = this.requests[index]; publishSharedGpuDrain(request.buffer, this.control); request.refresh(); }
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const gpu = (session, data, options = {}) => session.tensor(data, { device: "webgpu", ...options });

test("GPU host copy preserves identity, aliases, independent families and versions", async () => {
  const acquired = executionDevice(), session = createConnectedRuntimeSession(new WebGpuBackend(acquired));
  try {
    const source = gpu(session, [7, 9]), destination = gpu(session, [2, 3]), alias = destination.view([1, 2]);
    assert.equal(destination.copy_(source), destination);
    assert.equal(getTestTensorVersion(alias), 1);
    const later = gpu(session, [11, 13]); source.copy_(later);
    assert.deepEqual([...await alias.toArray()], [7, 9]);
    assert.deepEqual([...await source.toArray()], [11, 13]);
    destination.copy_(destination); assert.equal(getTestTensorVersion(alias), 2);
    for (const value of [source, destination, alias, later]) value.close();
  } finally { await session.close(); }
  assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
});

test("GPU active copy creates connected zeros on GPU and preserves ordered guards", async () => {
  const session = createConnectedRuntimeSession(new WebGpuBackend(executionDevice()));
  try {
    const x = gpu(session, [2, 4], { requiresGrad: true }), source = gpu(session, [7, 9], { requiresGrad: true });
    const mismatch = gpu(session, [1]);
    assert.throws(() => x.copy_(mismatch), { code: "INPLACE_GRADIENT" });
    assert.equal(getTestTensorVersion(x), 0);
    const destination = x.add(x), seed = gpu(session, [NaN, Infinity]); destination.copy_(source);
    const [zero, passed] = session.grad(destination, [x, source], seed);
    assert.equal(zero.device, "webgpu"); assert.equal(passed.device, "webgpu");
    const composed = zero.add(seed); composed.close();
    for (const value of [x, source, mismatch, destination, seed, zero, passed]) value.close();
  } finally { await session.close(); }
});

test("dropped shared GPU copies complete without observing a tensor", async () => {
  const backend = new CopyBackend(), session = createConnectedRuntimeSession(backend);
  const x = gpu(session, [2]), p = gpu(session, [0]), result = x.add(x);
  p.copy_(result); x.close(); p.close(); result.close();
  assert.equal(getTestRuntimeOwnership(session).pendingCopies, 1);
  backend.publish(0);
  await completeRuntimeSession(session);
  assert.ok(Object.values(getTestRuntimeOwnership(session)).every(value => value === 0));
  await session.close();
});

test("synchronous observation progresses a shared copy predecessor without local callbacks", async () => {
  const backend = new CopyBackend(), session = createConnectedRuntimeSession(backend);
  const x = gpu(session, [2]), p = gpu(session, [0]), result = x.add(x); p.copy_(result);
  backend.publish(0);
  assert.equal(observeTensorSynchronously(session, p).length, 1);
  assert.equal(getTestRuntimeOwnership(session).pendingCopies, 0);
  await flush(); assert.equal(session.diagnostics().liveRequestLeases, 0);
  await session.close();
});

test("a Promise-only predecessor preserves synchronous-unavailable rejection and later completion", async () => {
  const backend = new CopyBackend(), execute = backend.execute.bind(backend);
  backend.execute = (...args) => { const ticket = execute(...args); return new ExecutionTicket(ticket.result, ticket.drained); };
  const session = createConnectedRuntimeSession(backend), x = gpu(session, [2]), p = gpu(session, [0]), result = x.add(x);
  p.copy_(result); const before = getTestRuntimeOwnership(session);
  assert.throws(() => observeTensorSynchronously(session, p), { code: "SYNCHRONOUS_OBSERVATION_UNAVAILABLE" });
  assert.deepEqual(getTestRuntimeOwnership(session), before);
  backend.publish(0); await completeRuntimeSession(session); await session.close();
});

test("loss during shared predecessor observation delivers the writer failure before readiness rejection", async () => {
  const backend = new CopyBackend(), execute = backend.execute.bind(backend);
  backend.execute = (...args) => {
    const ticket = execute(...args);
    return new ExecutionTicket(ticket.result, ticket.drained, {
      read() {
        const result = ticket.synchronous.read();
        backend.failure = new TabgradError("BACKEND_STATUS_ERROR", "loss while observing predecessor");
        backend.ready = false;
        return result;
      },
      isDrained() { return ticket.synchronous.isDrained(); },
      onDrained(callback) { ticket.synchronous.onDrained(callback); },
    });
  };
  const session = createConnectedRuntimeSession(backend), x = gpu(session, [2]), p = gpu(session, [0]), result = x.add(x);
  p.copy_(result); backend.publish(0);
  assert.throws(() => observeTensorSynchronously(session, p), { code: "BACKEND_STATUS_ERROR" });
  assert.equal(getTestRuntimeOwnership(session).undeliveredEffects, 0);
  await completeRuntimeSession(session); await session.close();
});

for (const shape of [[], [0], [2]]) {
  test(`host/self GPU copy checks lost generation for shape ${JSON.stringify(shape)}`, async () => {
    const backend = new CopyBackend(), session = createConnectedRuntimeSession(backend);
    const p = gpu(session, new Float32Array(shape.reduce((n, d) => n * d, 1)), { shape });
    backend.failure = new TabgradError("BACKEND_STATUS_ERROR", "lost host generation");
    p.copy_(p); assert.equal(getTestTensorVersion(p), 1);
    await assert.rejects(completeRuntimeSession(session), { code: "BACKEND_STATUS_ERROR" });
    assert.throws(() => p.copy_(p), { code: "MUTATION_FAILED" });
    await session.close();
  });
}

test("failed shared copy successors publish causally but the source remains pinned until drain", async () => {
  const backend = new CopyBackend(), session = createConnectedRuntimeSession(backend);
  const x = gpu(session, [2]), p = gpu(session, [0]), next = gpu(session, [3]), result = x.add(x);
  p.copy_(result); for (let i = 0; i < 4; i++) p.copy_(next);
  assert.equal(getTestRuntimeOwnership(session).pendingCopies, 5);
  const failure = new TabgradError("BACKEND_STATUS_ERROR", "controlled source failure");
  backend.publish(0, failure, false); await flush();
  assert.equal(getTestRuntimeOwnership(session).pendingCopies, 1);
  await assert.rejects(p.toArray(), { code: "BACKEND_STATUS_ERROR" });
  assert.throws(() => p.copy_(next), { code: "MUTATION_FAILED" });
  let finished = false; const complete = completeRuntimeSession(session).then(() => { finished = true; });
  await flush(); assert.equal(finished, false);
  backend.drain(0); await complete; assert.equal(getTestRuntimeOwnership(session).pendingCopies, 0);
  await session.close();
});

test("loss after source execution begins cannot publish a successful GPU copy", async () => {
  const backend = new CopyBackend(), session = createConnectedRuntimeSession(backend);
  const x = gpu(session, [2]), p = gpu(session, [0]), result = x.add(x); p.copy_(result);
  backend.failure = new TabgradError("BACKEND_STATUS_ERROR", "generation lost"); backend.publish(0); await flush();
  assert.throws(() => p.copy_(x), { code: "MUTATION_FAILED" });
  await assert.rejects(completeRuntimeSession(session), { code: "BACKEND_STATUS_ERROR" });
  await session.close();
});

for (const unknown of [false, true]) {
  test(`pending dropped GPU copy close preserves ${unknown ? "unknown" : "confirmed"} completion`, async () => {
    const completion = deferred(), submitted = deferred(), device = executionDevice({ completion: () => completion.promise });
    const submit = device.queue.submit;
    device.queue.submit = commands => { submit(commands); submitted.resolve(); };
    const session = createConnectedRuntimeSession(new WebGpuBackend(device));
    const x = gpu(session, [2, 3]), p = gpu(session, [0, 0]), result = x.add(x);
    p.copy_(result); x.close(); p.close(); result.close();
    await submitted.promise;
    assert.equal(session.diagnostics().webgpu.pendingSubmissions, 1);
    let finished = false; const close = session.close().then(() => { finished = true; });
    const failure = unknown ? assert.rejects(close, { code: "BACKEND_STATUS_ERROR" }) : close;
    await flush(); assert.equal(finished, false);
    if (unknown) completion.reject(new Error("unconfirmed queue completion")); else completion.resolve();
    await failure; assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
    assert.equal(session.diagnostics().liveRequestLeases, 0);
    assert.equal(session.diagnostics().webgpu.unknownCompletionBytes > 0, unknown);
  });
}
