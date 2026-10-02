import assert from "node:assert/strict";
import { test } from "node:test";
import { createConnectedRuntimeSession, createRuntimeSession, observeTensorSynchronously } from "../../../dist/runtime/runtime.js";
import { ConnectedWebGpuBackend } from "../../../dist/backends/webgpu/webgpu-connected-backend.js";
import { WebAssemblyCpuBackend } from "../../../dist/backends/cpu/cpu-backend.js";
import { GPU_ACCOUNTED, GPU_CONTROL_LENGTH, GPU_METRIC_LENGTH } from "../../../dist/backends/webgpu/webgpu-connection.js";
import { publishSharedGpuSuccess } from "../../../dist/backends/webgpu/webgpu-shared-completion.js";
import { ExecutionTicket } from "../../../dist/execution/execution-ticket.js";

/** Controlled allocations exercise ownership only, never numerical or performance claims. */
function controlledCpu(context) {
  let nextId = 0;
  const failures = new Map();
  const released = [];
  context.mock.method(WebAssemblyCpuBackend.prototype, "prepare", () => undefined);
  context.mock.method(WebAssemblyCpuBackend.prototype, "execute", (program, bindings, retainedSlots) => {
    const allocations = new Map();
    for (const value of program.values) {
      if (value.storageSlot !== value.slot) continue;
      const resident = bindings.get(value.slot)?.resident;
      if (retainedSlots[value.slot] || resident !== undefined) {
        allocations.set(value.slot, resident ?? { id: ++nextId });
      }
    }
    return allocations;
  });
  context.mock.method(WebAssemblyCpuBackend.prototype, "read", (_allocation, length) => new Float32Array(length).fill(1));
  context.mock.method(WebAssemblyCpuBackend.prototype, "release", (allocation) => {
    released.push(allocation.id);
    if (failures.has(allocation.id)) throw failures.get(allocation.id);
  });
  const session = createRuntimeSession();
  context.after(async () => { await session.close().catch(() => undefined); });
  return { session, failures, released };
}

function cleanupCauses(error) {
  return error instanceof AggregateError ? error.errors.flatMap(cleanupCauses) : [error];
}

function assertNoSemanticOwners(session) {
  const diagnostics = session.diagnostics();
  for (const field of ["liveTensorHandles", "liveTensorValues", "liveOperationRecords", "liveMaterializationRecords", "liveRequestLeases", "liveDerivativeNodes", "liveSavedValues"]) {
    assert.equal(diagnostics[field], 0, field);
  }
}

/** Actual connection/runtime owners with a controlled producer, not shader execution. */
function connectedRuntime(context) {
  const physical = new MessageChannel();
  const supervision = new MessageChannel();
  const control = new Int32Array(new SharedArrayBuffer(GPU_CONTROL_LENGTH * 4));
  const faults = { release: undefined, unacknowledgedClose: false };
  const counts = { releaseTransfers: 0, terminalAttempts: 0 };
  let nextId = 0;
  physical.port1.postMessage = (packet) => {
    if (packet.kind === "close") {
      counts.terminalAttempts += 1;
      Atomics.store(control, GPU_ACCOUNTED, faults.unacknowledgedClose ? 2 : 1);
      return;
    }
    if (packet.kind === "release") {
      counts.releaseTransfers += 1;
      if (faults.release !== undefined) throw faults.release;
      publishSharedGpuSuccess(packet.completion, control, new Uint8Array());
      return;
    }
    const payload = packet.kind === "execute"
      ? new Float64Array([0, ++nextId]) : new Float32Array([1]);
    publishSharedGpuSuccess(packet.completion, control, new Uint8Array(payload.buffer));
  };
  const backend = new ConnectedWebGpuBackend({
    connectionType: "tabgrad-webgpu", protocolVersion: 1,
    port: physical.port1, supervision: supervision.port1, control: control.buffer,
    metrics: new SharedArrayBuffer(GPU_METRIC_LENGTH * 8),
    capabilities: { device: "webgpu", computations: ["add-f32"], gradients: false, maximumTensorBytes: 1048576 },
    diagnostics: { state: "ready" },
  });
  const session = createConnectedRuntimeSession(backend);
  context.after(async () => {
    // Fixture accounting retires ports even when a regression assertion fails;
    // it is not evidence that a real physical device drained.
    Atomics.store(control, GPU_ACCOUNTED, 1);
    const closing = session.close().catch(() => undefined);
    // A broken lease cannot be repaired by fixture teardown. Leave its join
    // pending rather than hanging the runner or pretending retirement succeeded.
    if (session.diagnostics().liveRequestLeases === 0) await closing;
    await backend.close().catch(() => undefined);
    physical.port2.close(); supervision.port2.close();
  });
  return { session, backend, faults, counts, control };
}

test("release failure cannot interrupt independent handles or the shared session close", async (context) => {
  const { session, backend, faults, counts } = connectedRuntime(context);
  const first = session.tensor([1], { device: "webgpu" });
  const alias = first.view([1]);
  const second = session.tensor([1], { device: "webgpu" });
  session.tensor([2], { requiresGrad: true });
  observeTensorSynchronously(session, first);
  observeTensorSynchronously(session, second);
  const failure = new Error("controlled release transport failure");
  faults.release = failure;
  let releaseAttempts = 0;
  let cpuCloseAttempts = 0;
  let reentrantClose;
  const release = backend.release;
  context.mock.method(backend, "release", function (allocation) {
    releaseAttempts += 1;
    if (releaseAttempts === 1) reentrantClose = session.close();
    return release.call(this, allocation);
  });
  const closeCpu = WebAssemblyCpuBackend.prototype.close;
  context.mock.method(WebAssemblyCpuBackend.prototype, "close", function () {
    cpuCloseAttempts += 1;
    return closeCpu.call(this);
  });
  let closing;
  assert.doesNotThrow(() => { closing = session.close(); });
  assert.ok(closing instanceof Promise);
  assert.equal(reentrantClose, closing);
  assert.equal(session.close(), closing);
  assert.throws(() => session.tensor([3]), { code: "CLOSED_SESSION" });
  for (const tensor of [first, alias, second]) {
    assert.throws(() => tensor.toArray(), { code: "CLOSED_TENSOR" });
    assert.doesNotThrow(() => tensor.close());
  }
  await assert.rejects(closing, (error) => error.code === "BACKEND_STATUS_ERROR" && error.cause === failure);
  assert.equal(releaseAttempts, 2, "both independent resident owners must be retired");
  assert.equal(counts.releaseTransfers, 1, "a retired generation needs no second release transfer");
  assert.equal(cpuCloseAttempts, 1);
  assert.equal(counts.terminalAttempts, 1);
  assertNoSemanticOwners(session);
});

test("CPU terminal failure still attempts GPU close and preserves multiple cleanup causes", async (context) => {
  const { session, backend } = connectedRuntime(context);
  const cpuFailure = new Error("controlled CPU close failure");
  const gpuFailure = new Error("controlled GPU close failure");
  let cpuAttempts = 0;
  let gpuAttempts = 0;
  context.mock.method(WebAssemblyCpuBackend.prototype, "close", async () => {
    cpuAttempts += 1;
    throw cpuFailure;
  });
  context.mock.method(backend, "close", async () => {
    gpuAttempts += 1;
    throw gpuFailure;
  });
  const closing = session.close();
  await assert.rejects(closing, (error) => error instanceof AggregateError
    && error.errors.length === 2 && error.errors[0] === cpuFailure && error.errors[1] === gpuFailure);
  assert.equal(session.close(), closing);
  assert.equal(cpuAttempts, 1);
  assert.equal(gpuAttempts, 1);
});

test("final alias release attempts every pending input after independent resident failures", async (context) => {
  const { session, failures, released } = controlledCpu(context);
  const leftSource = session.tensor([1]);
  const rightSource = session.tensor([1]);
  const left = leftSource.add(leftSource);
  const right = rightSource.add(rightSource);
  leftSource.close(); rightSource.close();
  await left.toArray(); await right.toArray();
  const pending = left.add(right);
  const alias = pending.view([1]);
  pending.close(); left.close(); right.close();
  const firstFailure = new Error("controlled first resident release failure");
  const secondFailure = new Error("controlled second resident release failure");
  failures.set(1, firstFailure); failures.set(2, secondFailure);
  assert.throws(() => alias.close(), (error) => {
    assert.deepEqual(cleanupCauses(error), [firstFailure, secondFailure]);
    return true;
  });
  assert.deepEqual(released, [1, 2]);
  assertNoSemanticOwners(session);
  assert.doesNotThrow(() => alias.close());
  await session.close();
  assert.deepEqual(released, [1, 2], "reported final-handle failures are not retried or replayed");
});

test("saved derivative release failures cannot strand history or the handle's ordinary value", async (context) => {
  const { session, failures, released } = controlledCpu(context);
  const left = session.tensor([1], { requiresGrad: true });
  const right = session.tensor([1], { requiresGrad: true });
  await left.toArray(); await right.toArray();
  const product = left.mul(right);
  await product.toArray();
  left.close(); right.close();
  const firstFailure = new Error("controlled saved right release failure");
  const secondFailure = new Error("controlled saved left release failure");
  failures.set(2, firstFailure); failures.set(1, secondFailure);
  assert.throws(() => product.close(), (error) => {
    assert.deepEqual(cleanupCauses(error), [firstFailure, secondFailure]);
    return true;
  });
  assert.deepEqual(released, [2, 1, 3]);
  assertNoSemanticOwners(session);
  await session.close();
  assert.deepEqual(released, [2, 1, 3]);
});

for (const chained of [false, true]) {
  test(`materialization retires all completed dependency edges after failure (chained=${chained})`, async (context) => {
    const { session, failures, released } = controlledCpu(context);
    const leftSource = session.tensor([1]);
    const rightSource = session.tensor([1]);
    const left = leftSource.add(leftSource);
    const right = rightSource.add(rightSource);
    leftSource.close(); rightSource.close();
    await left.toArray(); await right.toArray();
    const intermediate = left.add(right);
    const output = chained ? intermediate.add(left) : intermediate;
    if (chained) intermediate.close();
    left.close(); right.close();
    const leftFailure = new Error("controlled completed left release failure");
    const rightFailure = new Error("controlled completed right release failure");
    failures.set(1, leftFailure); failures.set(2, rightFailure);
    const expected = chained ? [rightFailure, leftFailure] : [leftFailure, rightFailure];
    await assert.rejects(output.toArray(), (error) => {
      assert.equal(error.code, "BACKEND_STATUS_ERROR");
      assert.deepEqual(cleanupCauses(error.cause), expected);
      return true;
    });
    assert.deepEqual(released, chained ? [2, 1] : [1, 2]);
    assert.equal(session.diagnostics().liveOperationRecords, 0);
    assert.equal(session.diagnostics().liveTensorValues, 1);
    output.close();
    assertNoSemanticOwners(session);
    await session.close();
  });
}

for (const resultFails of [false, true]) for (const closeBeforeDrain of [false, true]) {
  test(`request pin cleanup preserves outcome and lease (resultFails=${resultFails}, closeBeforeDrain=${closeBeforeDrain})`, async (context) => {
    const { session, backend, faults, counts } = connectedRuntime(context);
    let drained = false;
    let retire;
    const executionFailure = new Error("controlled readback failure");
    const payload = new Float32Array([1]);
    const ticket = new ExecutionTicket(
      () => resultFails ? Promise.reject(executionFailure) : Promise.resolve(payload),
      () => new Promise(() => undefined),
      {
        read() { if (resultFails) throw executionFailure; return payload; },
        isDrained: () => drained,
        onDrained(callback) { retire = callback; },
      },
    );
    context.mock.method(backend, "read", () => ticket);
    const tensor = session.tensor([1], { device: "webgpu" });
    const observation = tensor.toArray();
    tensor.close();
    let closing = closeBeforeDrain ? session.close() : undefined;
    if (resultFails) {
      await assert.rejects(observation, (error) => error.code === "BACKEND_STATUS_ERROR"
        && error.cause === executionFailure && error.details.phase === "readback");
    } else assert.deepEqual(await observation, payload);
    assert.equal(session.diagnostics().liveRequestLeases, 1);
    assert.equal(counts.terminalAttempts, 0, "backend close must wait for the accepted physical drain");
    assert.equal(typeof retire, "function");
    const cleanupFailure = new Error("controlled delayed pin release failure");
    faults.release = cleanupFailure;
    drained = true;
    assert.doesNotThrow(() => retire());
    assert.equal(session.diagnostics().liveRequestLeases, 0);
    closing ??= session.close();
    await assert.rejects(closing, (error) => error.code === "BACKEND_STATUS_ERROR" && error.cause === cleanupFailure);
    assert.equal(session.close(), closing);
    assert.equal(counts.terminalAttempts, 1);
    assertNoSemanticOwners(session);
  });
}

test("shared input occurrences retire once without invalidating an independently retained alias", async (context) => {
  const { session, failures, released } = controlledCpu(context);
  const source = session.tensor([1]);
  const input = source.add(source); source.close();
  await input.toArray();
  const sibling = input.view([1]);
  const pending = input.add(input);
  input.close(); pending.close();
  assert.deepEqual(released, []);
  assert.deepEqual(await sibling.toArray(), new Float32Array([1]));
  const failure = new Error("controlled final sibling release failure");
  failures.set(1, failure);
  assert.throws(() => sibling.close(), (error) => error === failure);
  assert.deepEqual(released, [1]);
  assertNoSemanticOwners(session);
  await session.close();
  assert.deepEqual(released, [1]);
});

test("release and unacknowledged terminal cleanup failures remain distinct without claiming physical reclamation", async (context) => {
  const { session, faults, counts } = connectedRuntime(context);
  const tensor = session.tensor([1], { device: "webgpu" });
  observeTensorSynchronously(session, tensor);
  const releaseFailure = new Error("controlled release transport failure before unknown drain");
  faults.release = releaseFailure;
  faults.unacknowledgedClose = true;
  await assert.rejects(session.close(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.equal(error.errors[0].cause, releaseFailure);
    assert.equal(error.errors[1].code, "BACKEND_STATUS_ERROR");
    assert.equal(error.errors[1].details.physicalCompletion, "unknown");
    return true;
  });
  assert.equal(counts.terminalAttempts, 1);
  assertNoSemanticOwners(session);
});
