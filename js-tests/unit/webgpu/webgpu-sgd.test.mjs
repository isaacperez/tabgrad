import assert from "node:assert/strict";
import { test } from "node:test";
import { WebGpuBackend } from "../../../dist/backends/webgpu/webgpu-backend.js";
import { ExecutableProgram } from "../../../dist/execution/executable-program.js";
import { executionDevice, deferred } from "./helpers/webgpu-device.mjs";
import { createConnectedRuntimeSession, completeRuntimeSession } from "../../../dist/runtime/runtime.js";
import { getTestTensorVersion } from "../../../dist/testing.js";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createWebGpuRuntimeSession } from "../../../dist/runtime/runtime.js";
import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";
import { inspectExecutionFailureContext } from "../../../dist/shared/errors.js";

function coefficientProgram(length = 65, alphas = [0xbdcccccd, 0x3f000000]) {
  const provenance = { operation: "add-alpha", source: "SGD.step" };
  const values = Array.from({ length: alphas.length + 2 }, (_, slot) => ({ slot, storageSlot: slot,
    dtype: "float32", device: "webgpu", layout: "contiguous", shape: [length],
    source: slot < 2 ? "binding" : "computed", provenance }));
  const computations = alphas.map((alphaBits, index) => ({ kind: "add-alpha-f32", alphaBits,
    inputs: [index === 0 ? 0 : index + 1, 1], output: index + 2, provenance }));
  return new ExecutableProgram(values, computations, values.length - 1);
}

function hostBindings(length) {
  return new Map([[0, { hostData: new Float32Array(length).fill(2) }],
    [1, { hostData: new Float32Array(length).fill(3) }]]);
}

test("actual JavaScript collection retires unrooted GPU optimizer/parameter/gradient cycles", () => {
  const result = execFileSync(process.execPath, ["--expose-gc", "--max-old-space-size=512",
    fileURLToPath(new URL("../../fixtures/sgd-gpu-finalization-child.mjs", import.meta.url))],
  { encoding: "utf8", timeout: 30_000 });
  const rows = JSON.parse(result);
  assert.equal(rows.length, 5);
  for (const row of rows) assert.ok(Object.values(row.owners).every(value => value === 0));
});

test("ordinary GPU SGD preserves capture, gradient identity and dropped mandatory updates", async () => {
  const acquired = executionDevice(), session = createConnectedRuntimeSession(new WebGpuBackend(acquired));
  try {
    const p = session.tensor([2], { device: "webgpu", requiresGrad: true });
    const g = session.tensor([3], { device: "webgpu" }); p.grad = g;
    const group = { params: [p], lr: 0.1 };
    const optimizer = session.sgd([group]);
    assert.equal(optimizer.paramGroups[0], group);
    assert.equal(group.params[0], p);
    assert.equal(optimizer.step(), undefined);
    assert.equal(p.grad, g);
    assert.equal(getTestTensorVersion(p), 1);
    group.lr = 2;
    optimizer.zeroGrad();
    assert.equal(p.grad, null);
    p.close(); g.close(); optimizer.close();
    await completeRuntimeSession(session);
    assert.equal(acquired.bindingGroups.length, 1);
    assert.deepEqual([...new Uint32Array(acquired.bindingGroups[0][3].resource.buffer.data)], [0xbdcccccd, 0, 0, 0]);
    assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
  } finally { await session.close(); }
});

test("numeric GPU reset preserves canonical gradient and alias versions on its device", async () => {
  for (const length of [0, 1, 65]) {
    const session = createConnectedRuntimeSession(new WebGpuBackend(executionDevice()));
    try {
      const p = session.tensor(new Float32Array(length), { device: "webgpu" });
      const g = session.tensor(new Float32Array(length).fill(7), { device: "webgpu", requiresGrad: true });
      const alias = g.view([length]); p.grad = g;
      const optimizer = session.sgd([p]);
      optimizer.zeroGrad(false);
      assert.equal(p.grad, g);
      assert.equal(g.device, "webgpu");
      assert.equal(g.requiresGrad, false);
      assert.equal(getTestTensorVersion(g), 1);
      assert.equal(getTestTensorVersion(alias), 1);
      await completeRuntimeSession(session);
      optimizer.close(); p.close(); g.close(); alias.close();
    } finally { await session.close(); }
    assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
  }
});

test("mixed SGD groups execute per occurrence without transferring GPU values to CPU", async (context) => {
  const fixtures = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist", import.meta.url)));
  const distributionUrl = await fixtures.start(), acquired = executionDevice();
  context.mock.getter(globalThis, "navigator", () => ({ gpu: {
    requestAdapter: async () => ({ requestDevice: async () => acquired }),
  } }));
  const session = await createWebGpuRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl) });
  try {
    const p = session.tensor([2], { device: "webgpu" }), q = session.tensor([4]);
    const r = session.tensor([6], { device: "webgpu" }), s = session.tensor([8]);
    const pg = session.tensor([3], { device: "webgpu" }), qg = session.tensor([6]);
    const rg = session.tensor([4], { device: "webgpu" }), sg = session.tensor([2]);
    p.grad = pg; q.grad = qg; r.grad = rg; s.grad = sg;
    const optimizer = session.sgd([{ params: [p, q], lr: 0.5 }, { params: [s, r], lr: 0.25 }]);
    optimizer.step();
    assert.deepEqual([...await q.toArray()], [1]);
    assert.deepEqual([...await s.toArray()], [7.5]);
    await completeRuntimeSession(session);
    assert.equal(session.diagnostics().webgpu.readbackBytes, 0);
    assert.equal(session.diagnostics().webgpu.uploadBytes, 16);
    assert.deepEqual(acquired.bindingGroups.map(entries => new Uint32Array(entries[3].resource.buffer.data)[0]),
      [0xbf000000, 0xbe800000]);
    for (const [parameter, gradient] of [[p, pg], [q, qg], [r, rg], [s, sg]]) {
      assert.equal(parameter.grad, gradient);
      assert.equal(getTestTensorVersion(parameter), 1);
    }
    optimizer.zeroGrad(false);
    await completeRuntimeSession(session);
    assert.equal(pg.device, "webgpu"); assert.equal(qg.device, "cpu");
    optimizer.close();
    for (const handle of [p, q, r, s, pg, qg, rg, sg]) handle.close();
  } finally { await session.close(); await fixtures.close(); }
});

test("failed SGD preparation retains source/slot provenance and a once-delivered mutation barrier", async () => {
  const original = new Error("coefficient pipeline failed"), acquired = executionDevice();
  acquired.createComputePipelineAsync = async () => { throw original; };
  const session = createConnectedRuntimeSession(new WebGpuBackend(acquired));
  try {
    const p = session.tensor([2], { device: "webgpu" }), g = session.tensor([3], { device: "webgpu" });
    p.grad = g; const optimizer = session.sgd([p]); optimizer.step();
    await assert.rejects(p.toArray(), error => {
      const failure = inspectExecutionFailureContext(error);
      assert.equal(error.cause, original);
      assert.equal(failure.provenance.source, "SGD.step");
      assert.equal(failure.programValueSlot, failure.program.computations.find(step => step.kind === "add-alpha-f32").output);
      return true;
    });
    assert.throws(() => optimizer.step(), { code: "MUTATION_FAILED" });
    await completeRuntimeSession(session);
    assert.equal(acquired.shaderSources.length, 1);
    assert.equal(acquired.buffers.length, 0);
    optimizer.close(); p.close(); g.close();
  } finally { await session.close(); }
});

for (const unknown of [false, true]) {
  test(`dropped GPU SGD close preserves ${unknown ? "unknown" : "confirmed"} packet completion`, async () => {
    const gate = deferred(), submitted = deferred(), acquired = executionDevice({ completion: () => gate.promise });
    const submit = acquired.queue.submit;
    acquired.queue.submit = commands => { submit(commands); submitted.resolve(); };
    const session = createConnectedRuntimeSession(new WebGpuBackend(acquired));
    const p = session.tensor([2], { device: "webgpu" }), g = session.tensor([3], { device: "webgpu" });
    p.grad = g; const optimizer = session.sgd([p]); optimizer.step();
    optimizer.zeroGrad(); optimizer.close(); p.close(); g.close();
    await submitted.promise;
    const before = session.diagnostics().webgpu.ownedBufferBytes;
    assert.equal(before, 28); // Three scalar buffers plus this dispatch's immutable packet.
    let finished = false; const closing = session.close().then(() => { finished = true; });
    const outcome = unknown ? assert.rejects(closing, { code: "BACKEND_STATUS_ERROR" }) : closing;
    await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
    if (unknown) gate.reject(new Error("unknown coefficient completion")); else gate.resolve();
    await outcome;
    assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
    assert.equal(session.diagnostics().webgpu.unknownCompletionBytes, unknown ? before : 0);
    assert.equal(session.diagnostics().liveRequestLeases, 0);
  });
}

// This device controls storage and completion; it does not execute numerical shaders.
test("coefficient computations retain distinct immutable packets and share one kind pipeline", async () => {
  const acquired = executionDevice(), backend = new WebGpuBackend(acquired);
  try {
    assert.ok(backend.capabilities.computations.includes("add-alpha-f32"));
    const program = coefficientProgram();
    await backend.prepare(program);
    const ticket = backend.execute(program, hostBindings(65), program.values.map(() => false));
    const retained = await ticket.result; await ticket.drained;
    assert.equal(acquired.shaderSources.length, 1);
    assert.deepEqual(acquired.dispatches, [2, 2]);
    const first = acquired.bindingGroups[0][3].resource.buffer;
    const second = acquired.bindingGroups[1][3].resource.buffer;
    assert.notEqual(first, second);
    assert.deepEqual([...new Uint32Array(first.data)], [0xbdcccccd, 0, 0, 0]);
    assert.deepEqual([...new Uint32Array(second.data)], [0x3f000000, 0, 0, 0]);
    assert.ok(first.destroyed && second.destroyed);
    assert.equal(backend.diagnostics().ownedBufferBytes, 65 * 4);
    for (const allocation of retained.values()) backend.release(allocation);
    await backend.prepare(coefficientProgram(1, [0x7fc00000, 0x80000000]));
    assert.equal(acquired.shaderSources.length, 1);
    assert.equal(backend.diagnostics().ownedBufferBytes, 0);
  } finally { await backend.close(); }
});

test("coefficient launch handles empty and partial workgroups without metadata for skipped arithmetic", async () => {
  for (const length of [0, 1, 63, 64, 65, 127, 128, 129]) {
    const acquired = executionDevice(), backend = new WebGpuBackend(acquired);
    try {
      const program = coefficientProgram(length, [0xbdcccccd]);
      await backend.prepare(program);
      const ticket = backend.execute(program, hostBindings(length), program.values.map(() => false));
      const retained = await ticket.result; await ticket.drained;
      assert.deepEqual(acquired.dispatches, length ? [Math.ceil(length / 64)] : []);
      assert.equal(acquired.bindingGroups.length, length ? 1 : 0);
      assert.equal(backend.diagnostics().ownedBufferBytes, Math.max(4, length * 4));
      for (const allocation of retained.values()) backend.release(allocation);
      assert.equal(backend.diagnostics().ownedBufferBytes, 0);
      assert.ok(acquired.buffers.every(buffer => buffer.destroyed));
    } finally { await backend.close(); }
  }
});

test("coefficient capability requires its 16-byte immutable packet even for empty programs", async () => {
  const acquired = executionDevice(); acquired.limits.maxBufferSize = 8;
  const backend = new WebGpuBackend(acquired);
  try {
    assert.equal(backend.capabilities.computations.includes("add-alpha-f32"), false);
    assert.throws(() => backend.prepare(coefficientProgram(0, [0])), { code: "BACKEND_CAPABILITY_MISMATCH" });
    assert.equal(acquired.shaderSources.length, 0);
    assert.equal(acquired.buffers.length, 0);
  } finally { await backend.close(); }
});

test("resident packet write failure preserves its queued obligation before submit", async () => {
  const acquired = executionDevice(), backend = new WebGpuBackend(acquired), gate = deferred();
  const initial = coefficientProgram(1, []);
  const uploaded = backend.execute(initial, hostBindings(1), [true, true]);
  const residents = await uploaded.result; await uploaded.drained;
  const before = backend.diagnostics().ownedBufferBytes;
  const original = new Error("queued coefficient write failed");
  const write = acquired.queue.writeBuffer;
  acquired.queue.writeBuffer = (...args) => { write(...args); throw original; };
  acquired.queue.onSubmittedWorkDone = () => gate.promise;
  const program = coefficientProgram(1, [0x3f000000]);
  await backend.prepare(program);
  const ticket = backend.execute(program, new Map([[0, { resident: residents.get(0) }],
    [1, { resident: residents.get(1) }]]), [true, true, false]);
  await assert.rejects(ticket.result, error => error.cause === original);
  let drained = false; const drainage = ticket.drained.then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drained, false);
  assert.equal(backend.diagnostics().ownedBufferBytes, before + 20);
  assert.equal(acquired.bindingGroups.length, 0);
  gate.resolve(); await drainage;
  assert.equal(backend.diagnostics().ownedBufferBytes, before);
  for (const allocation of residents.values()) backend.release(allocation);
  await backend.close();
});

test("resident coefficient packet writes require independent drain after encoding fails before submit", async () => {
  const gate = deferred(), acquired = executionDevice();
  const backend = new WebGpuBackend(acquired);
  const initial = coefficientProgram(1, []);
  const initialTicket = backend.execute(initial, hostBindings(1), [true, true]);
  const residents = await initialTicket.result; await initialTicket.drained;
  const before = backend.diagnostics().ownedBufferBytes;
  const original = new Error("coefficient bind failure");
  acquired.createBindGroup = () => { throw original; };
  acquired.queue.onSubmittedWorkDone = () => gate.promise;
  const program = coefficientProgram(1, [0xbdcccccd]);
  await backend.prepare(program);
  const ticket = backend.execute(program, new Map([[0, { resident: residents.get(0) }],
    [1, { resident: residents.get(1) }]]), [true, true, false]);
  await assert.rejects(ticket.result, error => error.cause === original && error.details.programValueSlot === 2);
  let drained = false; const drainage = ticket.drained.then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drained, false);
  assert.equal(backend.diagnostics().ownedBufferBytes, before + 4 + 16);
  assert.equal(backend.diagnostics().pendingSubmissions, 1);
  assert.ok(acquired.buffers.every(buffer => !buffer.destroyed));
  gate.resolve(); await drainage;
  assert.equal(backend.diagnostics().ownedBufferBytes, before);
  for (const allocation of residents.values()) backend.release(allocation);
  await backend.close();
  assert.ok(acquired.buffers.every(buffer => buffer.destroyed));
});
