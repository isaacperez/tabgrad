import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { checkBackwardCase, isDirectBackwardCase } from "../../browser/helpers/backward-cases.mjs";
import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";
import { createTestRuntimeSession, getTestTensorVersion, getTestRuntimeSemanticOwnership, getTestRuntimeOwnership } from "../../../dist/testing.js";

const fixtures = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist", import.meta.url)));
let distributionUrl;
before(async () => { distributionUrl = await fixtures.start(); });
after(async () => { await fixtures.close(); });
const oracle = JSON.parse(await readFile(new URL("../../fixtures/python-tensor-oracle.json", import.meta.url), "utf8"));

for (const forceVariant of ["scalar", "simd128"]) {
  for (const fixture of oracle.backwardCases.filter(isDirectBackwardCase)) {
    test(`native backward ${fixture.name} (${forceVariant})`, async () => {
      const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
      try { await checkBackwardCase(session, fixture, getTestTensorVersion); }
      finally { await session.close(); }
      assert.equal(session.diagnostics().liveTensorValues, 0);
      assert.equal(session.diagnostics().liveDerivativeNodes, 0);
      assert.equal(session.diagnostics().liveAllocationBytes, 0);
    });
  }
}

for (const forceVariant of ["scalar", "simd128"]) {
  test(`gradient slots preserve identity independently of exposure and aliases (${forceVariant})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
    try {
      const owner = session.tensor([2, 3], { requiresGrad: true });
      const view = owner.view([2]);
      const assigned = session.tensor([5, 7], { requiresGrad: true });
      assert.equal(owner.grad, null);
      owner.grad = assigned;
      assert.equal(owner.grad, assigned);
      assert.equal(owner.grad, owner.grad);
      assert.equal(view.grad, null);
      assert.throws(() => { owner.grad = owner; }, { code: "INVALID_GRADIENT" });
      assigned.close();
      const reacquired = owner.grad;
      assert.notEqual(reacquired, assigned);
      assert.equal(owner.grad, reacquired);
      assert.equal(reacquired.requiresGrad, true);
      assert.deepEqual([...await reacquired.toArray()], [5, 7]);
      assert.throws(() => assigned.toArray(), { code: "CLOSED_TENSOR" });
      owner.grad = null;
      assert.equal(owner.grad, null);
      assert.deepEqual([...await reacquired.toArray()], [5, 7]);
    } finally { await session.close(); }
    assert.equal(session.diagnostics().liveTensorValues, 0);
  });

  test(`fresh backward accumulates into the same leaf gradient and numerical reset preserves it (${forceVariant})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
    try {
      const x = session.tensor([2, 3], { requiresGrad: true });
      assert.equal(x.mul(x).sum().backward(), undefined);
      const initial = x.grad;
      const alias = initial.view([1, 2]);
      assert.deepEqual([...await initial.toArray()], [4, 6]);
      x.mul(x).sum().backward();
      assert.equal(x.grad, initial);
      assert.deepEqual([...await alias.toArray()], [8, 12]);
      assert.equal(getTestTensorVersion(initial), 2);
      session.noGrad(() => initial.copy_(session.tensor([0, 0])));
      x.mul(x).sum().backward();
      assert.equal(x.grad, initial);
      assert.deepEqual([...await initial.toArray()], [4, 6]);
      x.grad = null;
      x.mul(x).sum().backward();
      assert.notEqual(x.grad, initial);
      assert.deepEqual([...await initial.toArray()], [4, 6]);
    } finally { await session.close(); }
    assert.equal(session.diagnostics().liveTensorValues, 0);
  });
}

for (const forceVariant of ["scalar", "simd128"]) {
  test(`tracked view seeds share acquired family while direct seeds clone exact bits (${forceVariant})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
    try {
      for (const shape of [[], [1, 1], [2], [2, 2], [2, 0]]) {
        const count = shape.reduce((a, b) => a * b, 1);
        for (const direct of [true, false]) {
          const x = session.tensor(new Float32Array(count).fill(2), { shape, requiresGrad: true });
          const seed = session.tensor(new Float32Array(count).fill(-0), { shape, requiresGrad: true });
          const output = direct ? x : x.view(shape);
          output.backward(seed);
          const gradient = x.grad;
          assert.deepEqual(gradient.shape, shape);
          assert.equal(gradient.requiresGrad, false);
          assert.deepEqual([...new Uint32Array((await gradient.toArray()).buffer)], new Array(count).fill(0x80000000));
          const replacement = session.tensor(new Float32Array(count).fill(9), { shape });
          session.noGrad(() => seed.copy_(replacement));
          assert.deepEqual([...await gradient.toArray()], new Array(count).fill(direct ? -0 : 9));
          assert.equal(getTestTensorVersion(gradient), direct ? 1 : 1);
          replacement.close(); gradient.close(); output.close(); seed.close(); x.close();
        }
      }
    } finally { await session.close(); }
  });

  test(`retained nonleaf replacement also receives functional cutoff and failure contributions (${forceVariant})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
    try {
      const x = session.tensor([2, 3], { requiresGrad: true });
      const mid = x.mul(x);
      const seed = session.tensor([1, 1]);
      mid.backward(seed, { inputs: [mid] });
      const old = mid.grad;
      assert.equal(getTestTensorVersion(old), 0);
      assert.deepEqual([...await old.toArray()], [1, 1]);
      assert.equal(x.grad, null);
      session.noGrad(() => x.copy_(session.tensor([4, 5])));
      const [returned] = session.grad(mid, [mid], seed);
      assert.deepEqual([...await returned.toArray()], [1, 1]);
      assert.notEqual(mid.grad, old);
      assert.equal(getTestTensorVersion(mid.grad), 0);
      assert.equal(getTestTensorVersion(old), 0);
      assert.deepEqual([...await mid.grad.toArray()], [2, 2]);
      assert.deepEqual([...await old.toArray()], [1, 1]);
      assert.throws(() => mid.backward(seed, { inputs: [mid] }), { code: "CONSUMED_HISTORY" });
      assert.deepEqual([...await mid.grad.toArray()], [3, 3]);
    } finally { await session.close(); }
  });

  test(`unreachable own-view, mutual and history-gradient cycles retire all owners (${forceVariant})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
    for (const kind of ["own-view", "mutual", "history"]) {
      const x = session.tensor([2], { requiresGrad: true });
      const y = kind === "own-view" ? x.view([1]) : kind === "history" ? x.add(x) : session.tensor([3], { requiresGrad: true });
      x.grad = y;
      if (kind === "mutual") y.grad = x;
      y.close(); x.close();
      assert.equal(session.diagnostics().liveTensorValues, 0, kind);
      assert.equal(session.diagnostics().liveDerivativeNodes, 0, kind);
    }
    await session.close();
  });

  test(`partial backward commits survive a later saved-version error (${forceVariant})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
    try {
      const x = session.tensor([2, 3], { requiresGrad: true });
      const y = session.tensor([5, 7], { requiresGrad: true });
      const bad = x.mul(x);
      const good = y.add(y);
      const root = bad.add(good).sum();
      session.noGrad(() => x.copy_(session.tensor([4, 5])));
      assert.throws(() => root.backward(), { code: "SAVED_VERSION_MISMATCH" });
      assert.equal(x.grad, null);
      assert.deepEqual([...await y.grad.toArray()], [2, 2]);
      const initial = y.grad;
      assert.throws(() => root.backward(), { code: "SAVED_VERSION_MISMATCH" });
      assert.equal(y.grad, initial);
      assert.deepEqual([...await initial.toArray()], [4, 4]);
    } finally { await session.close(); }
  });
}

test("acquisition retains the receiving shape when a view seed has another rank", async () => {
  const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant: "scalar" });
  try {
    const x = session.tensor([2, 3, 4, 5], { shape: [2, 2], requiresGrad: true });
    const seed = session.tensor([1, 2, 3, 4], { shape: [4] });
    x.view([4]).backward(seed);
    assert.deepEqual(x.grad.shape, [2, 2]);
    assert.deepEqual([...await x.grad.toArray()], [1, 2, 3, 4]);
  } finally { await session.close(); }
});

test("gradient acquisition capacity rejects before association or history consumption", async () => {
  const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant: "scalar", updateLimits: { pendingCopies: 0 } });
  try {
    const x = session.tensor([2], { requiresGrad: true });
    const output = x.mul(x);
    assert.throws(() => output.backward(), { code: "RESOURCE_EXHAUSTED" });
    assert.equal(x.grad, null);
    const [gradient] = session.grad(output, [x]);
    assert.deepEqual([...await gradient.toArray()], [4]);
  } finally { await session.close(); }
});

test("caller-held add seed is cloned for both receivers and a acquired clone can be saved", async () => {
  const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant: "scalar" });
  try {
    const x = session.tensor([2, 3], { requiresGrad: true });
    const y = session.tensor([4, 5], { requiresGrad: true });
    const seed = session.tensor([5, 7], { requiresGrad: true });
    x.add(y).backward(seed);
    const gx = x.grad; const gy = y.grad;
    session.noGrad(() => seed.copy_(session.tensor([9, 11])));
    assert.deepEqual([...await gx.toArray()], [5, 7]);
    assert.deepEqual([...await gy.toArray()], [5, 7]);
    const leaf = session.tensor([1, 1], { requiresGrad: true });
    const [result] = session.grad(gx.mul(leaf).sum(), [leaf]);
    assert.deepEqual([...await result.toArray()], [5, 7]);
  } finally { await session.close(); }
});

test("direct acquired clone is a valid saved operand before any mutation", async () => {
  const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant: "scalar" });
  try {
    const x = session.tensor([2], { requiresGrad: true });
    const seed = session.tensor([5]); x.backward(seed);
    const leaf = session.tensor([1], { requiresGrad: true });
    const [result] = session.grad(x.grad.mul(leaf).sum(), [leaf]);
    assert.deepEqual([...await result.toArray()], [5]);
  } finally { await session.close(); }
});

test("failed gradient acquisition does not poison its independent caller-held seed", async () => {
  const fault = new Error("controlled gradient acquisition failure");
  const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant: "scalar", beforeCopyPublication() { throw fault; } });
  const x = session.tensor([2, 3], { requiresGrad: true }); const seed = session.tensor([5, 7]);
  x.view([2]).backward(seed); const gradient = x.grad;
  await assert.rejects(gradient.toArray(), error => error === fault || error.cause === fault);
  assert.deepEqual([...await seed.toArray()], [5, 7]);
  await session.close();
});

test("functional retained cutoff preserves a failing root writer and terminal barrier", async () => {
  const fault = new Error("controlled retained root writer");
  let release;
  fixtures.virtualResponses.set('/backward-root-fault.json', { body: await readFile(new URL('../../../dist/manifest.json', import.meta.url)),
    contentType: 'application/json', waitFor: new Promise(resolve => { release = resolve; }) });
  const session = createTestRuntimeSession({ manifestUrl: new URL("backward-root-fault.json", distributionUrl), forceVariant: "scalar", beforeCopyPublication() { throw fault; } });
  try {
    const x = session.tensor([2], { requiresGrad: true }); const root = x.add(x);
    assert.throws(() => root.backward(undefined, { inputs: [root, session.tensor([1])] }), { code: "GRADIENT_NOT_TRACKED" });
    session.noGrad(() => root.copy_(x.add(x)));
    const [returned] = session.grad(root, [root]);
    release();
    await assert.rejects(returned.toArray(), error => error.cause === fault);
    await assert.rejects(root.grad.toArray(), error => error.cause === fault);
    const fresh = session.tensor([3], { requiresGrad: true });
    assert.throws(() => fresh.backward(), { code: "MUTATION_FAILED" });
    assert.equal(fresh.grad, null);
  } finally { release(); await session.close(); }
});

test("real dropped JS exposure reports fallible finalization cleanup through session close", async () => {
  const { spawnSync } = await import("node:child_process");
  const script = `
import assert from 'node:assert/strict';
import { RuntimeSession } from './dist/index.js';
import { WebAssemblyCpuBackend } from './dist/backends/cpu/cpu-backend.js';
let next=0;
WebAssemblyCpuBackend.prototype.prepare=()=>undefined;
WebAssemblyCpuBackend.prototype.execute=(program,bindings,retained)=>new Map(program.values.filter(value=>value.storageSlot===value.slot&&retained[value.slot]).map(value=>[value.slot,{id:++next}]));
WebAssemblyCpuBackend.prototype.read=(_allocation,length)=>new Float32Array(length);
const fault=new Error('controlled real finalization cleanup');
WebAssemblyCpuBackend.prototype.release=()=>{throw fault;};
const session=new RuntimeSession();
let held=session.tensor([7]);
let heldView=held.view([1]);held.grad=heldView;heldView.close();heldView=null;
let source=session.tensor([2]);
let dropped=source.add(source);source.close();source=null;
await dropped.toArray();
let cycle=dropped.view([1]);dropped.grad=cycle;cycle=null;
const weak=new WeakRef(dropped);dropped=null;
for(let attempt=0;attempt<80;attempt++){await new Promise(resolve=>setImmediate(resolve));globalThis.gc();await new Promise(resolve=>setImmediate(resolve));if(session.diagnostics().liveTensorHandles===1)break;}
assert.equal(weak.deref(),undefined);
assert.equal(session.diagnostics().liveTensorHandles,1);
let preserved=held.grad;assert.deepEqual([...await preserved.toArray()],[7]);preserved.close();preserved=null;
await assert.rejects(session.close(),error=>error===fault);
assert.equal(session.diagnostics().liveTensorHandles,0);
assert.equal(session.diagnostics().liveTensorValues,0);
`;
  const result = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

for (const forceVariant of ['scalar', 'simd128']) {
  test(`actual strong leaf endpoints, weak nonleaf hooks and fixed semantic roots (${forceVariant})`, async () => {
    const { checkBackwardLifetime } = await import('../../browser/helpers/backward-lifetime.mjs');
    const session = createTestRuntimeSession({ manifestUrl: new URL('manifest.json', distributionUrl), forceVariant });
    try { await checkBackwardLifetime(session, getTestRuntimeSemanticOwnership); }
    finally { await session.close(); }
    const semantic = getTestRuntimeSemanticOwnership(session);
    for (const key of ['identities', 'identityReferences', 'gradientAssociations', 'viewBaseReferences', 'leafEndpointOwners', 'nonleafEntryOwners', 'publicExposures']) assert.equal(semantic[key], 0, key);
  });
}

test('plain inference retirement has no persistent-owner collector traversal', async () => {
  const session = createTestRuntimeSession({ manifestUrl: new URL('manifest.json', distributionUrl), forceVariant: 'scalar' });
  for (let index = 0; index < 32; index += 1) {
    const x = session.tensor([2]); const y = x.add(x); x.close(); y.close();
    assert.equal(getTestRuntimeSemanticOwnership(session).collectorPasses, 0);
  }
  await session.close();
});

test('direct JS backward validates its strict options before derivative consumption', async () => {
  const session = createTestRuntimeSession({ manifestUrl: new URL('manifest.json', distributionUrl), forceVariant: 'scalar' });
  try {
    const x = session.tensor([2], { requiresGrad: true }); const root = x.mul(x).sum();
    for (const options of [null, [], { inputs: [] }, { inputs: x }, { inputs: [1] }, { retainGraph: 0 }, { createGraph: null }, { unexpected: false }]) {
      assert.throws(() => root.backward(undefined, options)); assert.equal(x.grad, null);
    }
    for (const options of [{ retainGraph: true }, { createGraph: true }]) assert.throws(() => root.backward(undefined, options), { code: 'UNSUPPORTED_GRADIENT' });
    root.backward(); assert.deepEqual([...await x.grad.toArray()], [4]);
  } finally { await session.close(); }
});

test('all receiver effects reserve pending capacity before recipe consumption', async () => {
  const session = createTestRuntimeSession({ manifestUrl: new URL('manifest.json', distributionUrl), forceVariant: 'scalar', updateLimits: { pendingCopies: 1 } });
  try {
    const x = session.tensor([2], { requiresGrad: true }); const y = session.tensor([3], { requiresGrad: true });
    const sx = x.mul(x); const sy = y.mul(y); const root = sx.add(sy).sum();
    const before = getTestRuntimeOwnership(session);
    assert.throws(() => root.backward(), { code: 'RESOURCE_EXHAUSTED' });
    assert.equal(x.grad, null); assert.equal(y.grad, null);
    assert.deepEqual(getTestRuntimeOwnership(session), before);
    root.backward(undefined, { inputs: [x] });
    assert.deepEqual([...await x.grad.toArray()], [4]);
    sy.backward(); assert.deepEqual([...await y.grad.toArray()], [6]);
  } finally { await session.close(); }
});

test('cleared and replaced associations preserve independent accepted effects until delayed drain', async () => {
  let release;
  fixtures.virtualResponses.set('/backward-drain.json', { body: await readFile(new URL('../../../dist/manifest.json', import.meta.url)), contentType: 'application/json', waitFor: new Promise(resolve => { release = resolve; }) });
  const session = createTestRuntimeSession({ manifestUrl: new URL('backward-drain.json', distributionUrl), forceVariant: 'scalar' });
  const x = session.tensor([2], { requiresGrad: true });
  const square = x.mul(x); const root = square.sum(); square.close(); root.backward(); root.close();
  const old = x.grad; x.grad = session.tensor([10]); old.close();
  const next = x.mul(x); const nextRoot = next.sum(); next.close(); nextRoot.backward(); nextRoot.close();
  x.grad = null;
  const last = x.mul(x); const lastRoot = last.sum(); last.close(); lastRoot.backward(); lastRoot.close();
  assert.equal(getTestRuntimeOwnership(session).pendingCopies, 3);
  const closing = session.close();
  assert.equal(getTestRuntimeSemanticOwnership(session).identities, 0);
  assert.ok(session.diagnostics().liveTensorValues > 0);
  release(); await closing;
  assert.equal(getTestRuntimeOwnership(session).pendingCopies, 0);
  assert.equal(session.diagnostics().liveTensorValues, 0);
  assert.equal(session.diagnostics().liveRequestLeases, 0);
});

test('actual backward faults preserve seed isolation, terminal barrier and dropped mandatory effects', async () => {
  const { checkBackwardFaults } = await import('../../browser/helpers/backward-lifetime.mjs');
  await checkBackwardFaults(options => createTestRuntimeSession({ manifestUrl: new URL('manifest.json', distributionUrl), forceVariant: 'scalar', ...options }));
});

test('committed nonleaf replacement survives fallible previous gradient child retirement', async () => {
  const { checkBackwardReplacementCleanup } = await import('../../browser/helpers/backward-lifetime.mjs');
  const { WebAssemblyCpuBackend } = await import('../../../dist/backends/cpu/cpu-backend.js');
  await checkBackwardReplacementCleanup(options => createTestRuntimeSession({ manifestUrl: new URL('manifest.json', distributionUrl), forceVariant: 'scalar', ...options }), WebAssemblyCpuBackend, getTestRuntimeSemanticOwnership);
});

test('functional retained effects reserve capacity before consuming any selected recipe', async () => {
  const session = createTestRuntimeSession({ manifestUrl: new URL('manifest.json', distributionUrl), forceVariant: 'scalar', updateLimits: { pendingCopies: 1 } });
  try {
    const x = session.tensor([2], { requiresGrad: true }); const mid = x.mul(x); const root = mid.sum(); const plain = session.tensor([1]);
    assert.throws(() => root.backward(undefined, { inputs: [root, mid, plain] }), { code: 'GRADIENT_NOT_TRACKED' });
    const before = getTestRuntimeOwnership(session);
    assert.throws(() => session.grad(root, [x]), { code: 'RESOURCE_EXHAUSTED' });
    assert.equal(root.grad, null); assert.equal(mid.grad, null);
    assert.deepEqual(getTestRuntimeOwnership(session), before);
    const [result] = session.grad(mid, [mid]);
    assert.deepEqual([...await result.toArray()], [1]);
  } finally { await session.close(); }
});

test('independent cyclic cleanup failures preserve the accepted read pin until drain', async () => {
  const { checkBackwardCleanup } = await import('../../browser/helpers/backward-lifetime.mjs');
  const { WebAssemblyCpuBackend } = await import('../../../dist/backends/cpu/cpu-backend.js');
  const { ExecutionTicket } = await import('../../../dist/execution/execution-ticket.js');
  await checkBackwardCleanup(options => createTestRuntimeSession({ manifestUrl: new URL('manifest.json', distributionUrl), forceVariant: 'scalar', ...options }), WebAssemblyCpuBackend, ExecutionTicket, getTestRuntimeSemanticOwnership);
});

test('backward seed-shape validation precedes installing selected nonleaf retention', async () => {
  const session = createTestRuntimeSession({ manifestUrl: new URL('manifest.json', distributionUrl), forceVariant: 'scalar' });
  try {
    const x = session.tensor([2, 3], { requiresGrad: true }); const mid = x.add(x); const root = mid.sum();
    assert.throws(() => root.backward(session.tensor([1, 1]), { inputs: [mid] }), { code: 'SHAPE_MISMATCH' });
    root.backward(); assert.equal(mid.grad, null);
  } finally { await session.close(); }
});

test('backward invalid output history precedes installing selected nonleaf retention', async () => {
  const session = createTestRuntimeSession({ manifestUrl: new URL('manifest.json', distributionUrl), forceVariant: 'scalar' });
  try {
    const x = session.tensor([2, 3], { requiresGrad: true }); const mid = x.add(x); const plain = session.noGrad(() => mid.sum());
    assert.throws(() => plain.backward(session.tensor([1], { shape: [] }), { inputs: [mid] }), { code: 'GRADIENT_NOT_TRACKED' });
    mid.sum().backward(); assert.equal(mid.grad, null);
  } finally { await session.close(); }
});

for (const forceVariant of ['scalar', 'simd128']) {
  test(`direct acquisition preserves exceptional float32 captures and version (${forceVariant})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl: new URL('manifest.json', distributionUrl), forceVariant });
    try {
      const data = new Float32Array([-0, Infinity, -Infinity, NaN]);
      const owner = session.tensor([1, 1, 1, 1], { requiresGrad: true }); const seed = session.tensor(data, { requiresGrad: true });
      owner.backward(seed); const gradient = owner.grad;
      assert.equal(getTestTensorVersion(gradient), 1); assert.equal(gradient.requiresGrad, false);
      session.noGrad(() => seed.copy_(session.tensor([9, 9, 9, 9])));
      const values = await gradient.toArray();
      assert.equal(Object.is(values[0], -0), true); assert.equal(values[1], Infinity); assert.equal(values[2], -Infinity); assert.equal(Number.isNaN(values[3]), true);
      assert.equal(getTestTensorVersion(gradient), 1);
    } finally { await session.close(); }
  });
}

test('gradient assignment budgets its actual owning identity occurrence before publication', async () => {
  const session = createTestRuntimeSession({ forceVariant: 'scalar', updateLimits: { owners: 4 } });
  try {
    const owner = session.tensor([2]); const gradient = session.tensor([3]);
    const before = getTestRuntimeSemanticOwnership(session);
    assert.throws(() => { owner.grad = gradient; }, { code: 'RESOURCE_EXHAUSTED' });
    assert.equal(owner.grad, null);
    assert.deepEqual(getTestRuntimeSemanticOwnership(session), before);
    assert.deepEqual([...await gradient.toArray()], [3]);
  } finally { await session.close(); }
});
