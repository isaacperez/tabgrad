import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";
import { createTestRuntimeSession, getTestRuntimeOwnership, getTestTensorVersion, getTestTensorAncestry } from "../../../dist/testing.js";

const fixtures = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist", import.meta.url)));
let distributionUrl;
before(async () => { distributionUrl = await fixtures.start(); });
after(async () => { await fixtures.close(); });

for (const forceVariant of ["scalar", "simd128"]) {
  test(`copy_ preserves handles, whole-storage aliases and admitted snapshots (${forceVariant})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
    const destination = session.tensor([2, 4], { requiresGrad: true });
    const alias = destination.view([1, 2]);
    const source = session.tensor([7, 9]);
    const later = session.tensor([11, 13]);
    const old = destination.add(destination);
    const beforeCopy = destination.toArray();
    try {
      assert.equal(session.noGrad(() => destination.copy_(source)), destination);
      const betweenCopies = alias.toArray();
      assert.equal(session.noGrad(() => destination.copy_(later)), destination);
      source.close(); later.close();
      assert.deepEqual([...await beforeCopy], [2, 4]);
      assert.deepEqual([...await betweenCopies], [7, 9]);
      assert.deepEqual([...await alias.toArray()], [11, 13]);
      assert.deepEqual([...await old.toArray()], [4, 8]);
      assert.equal(destination.requiresGrad, true);
      const [gradient] = session.grad(old, [destination], session.tensor([1, 1]));
      assert.deepEqual([...await gradient.toArray()], [2, 2]);
      gradient.close();
    } finally { await session.close(); }
    assert.equal(session.diagnostics().liveTensorValues, 0);
    assert.equal(session.diagnostics().liveOperationRecords, 0);
    assert.equal(session.diagnostics().liveAllocationBytes, 0);
  });
}

test("active copy promotes/replaces history and keeps connected positive destination zeros", async () => {
  const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant: "scalar" });
  try {
    const original = session.tensor([2, 4], { requiresGrad: true });
    const source = session.tensor([7, 9], { requiresGrad: true });
    const destination = original.add(original);
    const old = destination.add(destination);
    assert.equal(destination.copy_(source), destination);
    const seed = session.tensor([NaN, -0]);
    const [zero, incoming] = session.grad(destination, [original, source], seed);
    assert.deepEqual([...new Uint32Array((await zero.toArray()).buffer)], [0, 0]);
    assert.ok(Number.isNaN((await incoming.toArray())[0]));
    assert.equal(Object.is((await incoming.toArray())[1], -0), true);
    const [again] = session.grad(destination, [source], seed);
    assert.equal(Object.is((await again.toArray())[1], -0), true);
    const [oldGradient] = session.grad(old, [original], session.tensor([1, 1]));
    assert.deepEqual([...await oldGradient.toArray()], [4, 4]);
    const plain = session.tensor([0, 0]);
    plain.copy_(source);
    assert.equal(plain.requiresGrad, true);
    assert.deepEqual([...await session.grad(plain, [source], session.tensor([1, 1]))[0].toArray()], [1, 1]);
  } finally { await session.close(); }
  assert.equal(session.diagnostics().liveDerivativeNodes, 0);
});

test("copy guards and saved-version gradient preflight are transactional", async () => {
  const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant: "scalar" });
  try {
    const x = session.tensor([2], { requiresGrad: true });
    const y = session.tensor([3], { requiresGrad: true });
    const mismatch = session.tensor([9, 10]);
    assert.throws(() => x.copy_(mismatch), { code: "INPLACE_GRADIENT" });
    assert.deepEqual([...await x.toArray()], [2]);
    const product = x.mul(y);
    session.noGrad(() => x.copy_(y));
    const before = session.diagnostics();
    assert.throws(() => session.grad(product, [x]), { code: "SAVED_VERSION_MISMATCH" });
    assert.equal(session.diagnostics().liveTensorHandles, before.liveTensorHandles);
    assert.equal(session.diagnostics().liveSavedValues, before.liveSavedValues);
    const cutoff = session.grad(product, [product])[0];
    assert.deepEqual([...await cutoff.toArray()], [1]);
    const direct = y.add(y);
    direct.copy_(x);
    const [sourceOnly] = session.grad(direct, [x]);
    assert.deepEqual([...await sourceOnly.toArray()], [1]);
  } finally { await session.close(); }
});

test("dropped copy effects execute and failed current roots gate payload-free derivatives", async () => {
  const manifestUrl = fixtures.installFixture("copy-status", { kernelBehavior: "status", failureCall: 1 });
  const session = createTestRuntimeSession({ manifestUrl, forceVariant: "scalar" });
  const destination = session.tensor([2], { shape: [], requiresGrad: true });
  const input = session.tensor([3], { shape: [] });
  const old = destination.add(destination);
  const source = input.add(input);
  session.noGrad(() => destination.copy_(source));
  source.close();
  const [currentCutoff] = session.grad(destination, [destination]);
  const [oldGradient] = session.grad(old, [destination]);
  try {
    await assert.rejects(currentCutoff.toArray(), { code: "BACKEND_STATUS_ERROR" });
    assert.equal(session.diagnostics().kernelCalls, 1, "mandatory source executes exactly once");
    await assert.rejects(destination.toArray(), { code: "BACKEND_STATUS_ERROR" });
    assert.equal(session.diagnostics().kernelCalls, 1, "failed committed write never replays");
    assert.deepEqual([...await oldGradient.toArray()], [2]);
    assert.deepEqual([...await input.toArray()], [3]);
    assert.throws(() => session.noGrad(() => destination.copy_(input)), { code: "MUTATION_FAILED" });
  } finally { await session.close(); }
  assert.equal(session.diagnostics().liveRequestLeases, 0);
  assert.equal(session.diagnostics().liveAllocationBytes, 0);
});

test("closing a dropped pending copy reports its causal responsibility and drains sources", async () => {
  const session = createTestRuntimeSession({ manifestUrl: fixtures.installFixture("copy-close-status", { kernelBehavior: "status" }), forceVariant: "scalar" });
  const destination = session.tensor([1]);
  const input = session.tensor([2]);
  const source = input.add(input);
  destination.copy_(source);
  destination.close(); source.close(); input.close();
  await assert.rejects(session.close(), { code: "BACKEND_STATUS_ERROR" });
  assert.equal(session.diagnostics().kernelCalls, 1);
  assert.equal(session.diagnostics().liveTensorValues, 0);
  assert.equal(session.diagnostics().liveRequestLeases, 0);
});

test("active whole-storage view copies rebase current entries and consume CopySlices once", async () => {
  const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant: "scalar" });
  try {
    const leaf = session.tensor([2, 4], { requiresGrad: true });
    const source = session.tensor([7, 9], { shape: [1, 2], requiresGrad: true });
    const base = leaf.add(leaf);
    const view = base.view([1, 2]);
    const sibling = base.view([2]);
    const old = view.add(view);
    view.copy_(source);
    const seed = session.tensor([1, 1], { shape: [1, 2] });
    const [newGradient] = session.grad(view, [source], seed);
    assert.deepEqual([...await newGradient.toArray()], [1, 1]);
    assert.throws(() => session.grad(view, [source], seed), { code: "CONSUMED_HISTORY" });
    const [baseCutoff] = session.grad(view, [base], seed);
    assert.deepEqual([...await baseCutoff.toArray()], [1, 1]);
    const [siblingGradient] = session.grad(sibling, [base], session.tensor([1, 1]));
    assert.deepEqual([...await siblingGradient.toArray()], [1, 1]);
    const [oldGradient] = session.grad(old, [leaf], seed);
    assert.deepEqual([...await oldGradient.toArray()], [4, 4]);
  } finally { await session.close(); }
  assert.equal(session.diagnostics().liveDerivativeNodes, 0);
});

test("managed completion delivers dropped effects before entry success", async () => {
  const { PythonRuntimeBridge } = await import("../../../dist/frontends/python/python-runtime-bridge.js");
  const session = createTestRuntimeSession({ manifestUrl: fixtures.installFixture("copy-managed-status", { kernelBehavior: "status" }), forceVariant: "scalar" });
  const bridge = new PythonRuntimeBridge(session);
  const destination = session.tensor([1]);
  const input = session.tensor([2]);
  const source = input.add(input);
  await assert.rejects(bridge.runManaged(async () => { destination.copy_(source); }), { code: "BACKEND_STATUS_ERROR" });
  await session.close();
  assert.equal(session.diagnostics().liveRequestLeases, 0);
});

test("copy capacity limits reject before version, history or request admission", async () => {
  let release;
  const manifestUrl = new URL("copy-capacity.json", distributionUrl);
  fixtures.virtualResponses.set(manifestUrl.pathname, {
    body: await readFile(new URL("../../../dist/manifest.json", import.meta.url)), contentType: "application/json",
    waitFor: new Promise((resolve) => { release = resolve; }),
  });
  const session = createTestRuntimeSession({ manifestUrl, forceVariant: "scalar", updateLimits: { pendingCopies: 1 } });
  const destination = session.tensor([1]);
  const input = session.tensor([2]);
  const first = input.add(input);
  try {
    destination.copy_(first);
    const before = session.diagnostics();
    assert.throws(() => destination.copy_(input), { code: "RESOURCE_EXHAUSTED" });
    assert.equal(session.diagnostics().liveRequestLeases, before.liveRequestLeases);
    release();
    assert.deepEqual([...await destination.toArray()], [4]);
  } finally { release(); await session.close(); }
  const bytes = createTestRuntimeSession({ forceVariant: "scalar", updateLimits: { backingBytes: 4 } });
  try {
    const a = bytes.tensor([1]), b = bytes.tensor([2]);
    assert.throws(() => a.copy_(b), { code: "RESOURCE_EXHAUSTED" });
    assert.deepEqual([...await a.toArray()], [1]);
    assert.equal(bytes.diagnostics().liveRequestLeases, 0);
  } finally { await bytes.close(); }
});

test("publication faults gate host/self copies without poisoning the source family", async () => {
  const fault = new Error("copy publication failure");
  const session = createTestRuntimeSession({ forceVariant: "scalar", beforeCopyPublication: () => { throw fault; } });
  const source = session.tensor([5], { shape: [] });
  const destination = session.tensor([2], { shape: [], requiresGrad: true });
  session.noGrad(() => destination.copy_(source));
  const [gradient] = session.grad(destination, [destination]);
  try {
    await assert.rejects(gradient.toArray(), (error) => error.cause === fault || error === fault);
    await assert.rejects(destination.toArray());
    assert.deepEqual([...await source.toArray()], [5]);
  } finally { await session.close(); }
});

test("copy byte capacity preserves both families without preparing work", async () => {
  const session = createTestRuntimeSession({ forceVariant: "scalar", updateLimits: { backingBytes: 4 } });
  try {
    const destination = session.tensor([1]), source = session.tensor([2]);
    assert.throws(() => destination.copy_(source), { code: "RESOURCE_EXHAUSTED" });
    assert.deepEqual([...await destination.toArray()], [1]);
    assert.deepEqual([...await source.toArray()], [2]);
    assert.equal(session.diagnostics().backendLoads, 0);
  } finally { await session.close(); }
});

test("zero-edge derivative results preserve a failing explicit seed writer", async () => {
  const fault = new Error("seed publication");
  let publications = 0;
  const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant: "scalar", beforeCopyPublication: () => { if (++publications === 2) throw fault; } });
  const x = session.tensor([2], { shape: [], requiresGrad: true });
  const d = x.add(x);
  const plain = session.tensor([3], { shape: [] });
  d.copy_(plain);
  const seed = session.tensor([1], { shape: [] });
  seed.copy_(plain);
  const [gradient] = session.grad(d, [x], seed);
  const observed = await Promise.allSettled([gradient.toArray()]);
  const closed = await Promise.allSettled([session.close()]);
  assert.equal(observed[0].status, "rejected", "a failed seed must gate a zero-edge gradient");
  assert.equal(closed[0].status, "fulfilled", "the observation delivered this causal responsibility");
});

test("fallible old-backing retirement cannot erase a committed mandatory copy", async () => {
  const { WebAssemblyCpuBackend } = await import("../../../dist/backends/cpu/cpu-backend.js");
  const release = WebAssemblyCpuBackend.prototype.release;
  const fault = new Error("old backing release");
  let publications = 0;
  const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant: "scalar", beforeCopyPublication: () => { publications += 1; } });
  const base = session.tensor([2]);
  const destination = base.add(base);
  const source = session.tensor([5]);
  await destination.toArray();
  let inject = true;
  WebAssemblyCpuBackend.prototype.release = function (allocation) {
    release.call(this, allocation);
    if (inject) { inject = false; throw fault; }
  };
  try {
    assert.throws(() => destination.copy_(source), (error) => error === fault);
    assert.equal(publications, 1, "committed effect is still scheduled");
    assert.deepEqual([...await destination.toArray()], [5]);
  } finally {
    WebAssemblyCpuBackend.prototype.release = release;
    await session.close();
  }
  assert.equal(session.diagnostics().liveTensorValues, 0);
  assert.equal(session.diagnostics().liveRequestLeases, 0);
});

for (const forceVariant of ["scalar", "simd128"]) {
  test(`fixed-owner noGrad update loops detach completed steps at 2/16/64 (${forceVariant})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
    const parameter = session.tensor([2, 4], { requiresGrad: true });
    const alias = parameter.view([1, 2]);
    const factor = session.tensor([-0.25, -0.25]);
    const checkpoints = [];
    try {
      for (let step = 1; step <= 64; step += 1) {
        const squared = parameter.mul(parameter);
        const loss = squared.sum();
        const [gradient] = session.grad(loss, [parameter]);
        const scaled = gradient.mul(factor);
        const update = parameter.add(scaled);
        session.noGrad(() => parameter.copy_(update));
        for (const handle of [squared, loss, gradient, scaled, update]) handle.close();
        if ([2, 16, 64].includes(step)) {
          assert.deepEqual([...await alias.toArray()], [2 * 2 ** -step, 4 * 2 ** -step]);
          assert.equal(getTestTensorVersion(parameter), step);
          assert.equal(parameter.requiresGrad, true);
          assert.deepEqual(getTestTensorAncestry(parameter), { values: 1, operations: 0, releasedValues: 0 });
          const ownership = getTestRuntimeOwnership(session);
          assert.equal(ownership.pendingCopies, 0);
          assert.equal(session.diagnostics().liveRequestLeases, 0);
          checkpoints.push([ownership, session.diagnostics().liveAllocationBytes, session.diagnostics().liveDerivativeNodes]);
        }
      }
      assert.deepEqual(checkpoints[1], checkpoints[0]);
      assert.deepEqual(checkpoints[2], checkpoints[0]);
    } finally { await session.close(); }
    assert.deepEqual(getTestRuntimeOwnership(session), { families: 0, backings: 0, backingBytes: 0, valueReferences: 0,
      derivativeReferences: 0, writerOutcomes: 0, controlReferences: 0, pendingCopies: 0, undeliveredEffects: 0 });
  });
}

test("copy transitions preserve float32 source bits, self/empty versions and one physical owner", async () => {
  const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant: "simd128" });
  const source = session.tensor(new Float32Array(new Uint32Array([0, 0x80000000, 1, 0x7f800000, 0xff800000, 0x7fc00123]).buffer));
  const destination = session.tensor([1, 1, 1, 1, 1, 1]);
  try {
    const expected = new Uint32Array((await source.toArray()).buffer);
    destination.copy_(source);
    assert.deepEqual(new Uint32Array((await destination.toArray()).buffer), expected);
    source.copy_(session.tensor([2, 2, 2, 2, 2, 2]));
    assert.deepEqual(new Uint32Array((await destination.toArray()).buffer), expected);
    destination.copy_(destination);
    assert.equal(getTestTensorVersion(destination), 2);
    const empty = session.tensor([], { shape: [2, 0] });
    empty.copy_(empty); assert.equal(getTestTensorVersion(empty), 1);
    assert.deepEqual([...await empty.toArray()], []);
    const resident = session.tensor([2]).add(session.tensor([3]));
    assert.deepEqual([...await resident.toArray()], [5]);
    const other = session.tensor([0]); other.copy_(resident);
    const before = session.diagnostics();
    const doubled = other.add(resident);
    assert.deepEqual([...await doubled.toArray()], [10]);
    assert.equal(session.diagnostics().hostToWasmBytes, before.hostToWasmBytes);
    resident.close(); other.close();
    assert.deepEqual([...await doubled.toArray()], [10]);
  } finally { await session.close(); }
  assert.equal(session.diagnostics().liveAllocationBytes, 0);
  assert.equal(getTestRuntimeOwnership(session).backings, 0);
});

test("control-capturing gradients and downstream admissions reserve count/byte capacity atomically", async () => {
  let release;
  fixtures.virtualResponses.set("/copy-capture-capacity.json", { body: await readFile(new URL("../../../dist/manifest.json", import.meta.url)),
    contentType: "application/json", waitFor: new Promise(resolve => { release = resolve; }) });
  const session = createTestRuntimeSession({ manifestUrl: new URL("copy-capture-capacity.json", distributionUrl),
    forceVariant: "scalar", updateLimits: { backingBytes: 12 } });
  const parameter = session.tensor([2], { shape: [], requiresGrad: true });
  const input = session.tensor([3], { shape: [] });
  const source = input.add(input);
  session.noGrad(() => parameter.copy_(source));
  const before = session.diagnostics();
  try {
    // The predecessor is retired; the source and input own eight bytes.
    const padding = session.tensor([0], { shape: [] });
    const current = session.diagnostics();
    assert.throws(() => session.grad(parameter, [parameter]), { code: "RESOURCE_EXHAUSTED" });
    assert.equal(session.diagnostics().liveTensorHandles, current.liveTensorHandles);
    assert.equal(session.diagnostics().liveTensorValues, current.liveTensorValues);
    assert.throws(() => parameter.add(source), { code: "RESOURCE_EXHAUSTED" });
    assert.equal(session.diagnostics().liveTensorHandles, current.liveTensorHandles);
    padding.close();
  } finally { release(); await session.close(); }
  assert.equal(before.liveSavedValues, 0);
});

test("retained old reads cannot reach retired families' newer current chains", async () => {
  const { getTestTensorReachability } = await import("../../../dist/testing.js");
  const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant: "scalar" });
  const kept = session.tensor([0]);
  let current = session.tensor([1]);
  kept.copy_(current);
  const checkpoints = [];
  try {
    for (let step = 1; step <= 64; step++) {
      const next = session.tensor([step + 1]);
      current.copy_(next);
      current.close();
      current = next;
      if ([2, 16, 64].includes(step)) checkpoints.push(getTestTensorReachability(kept));
    }
    assert.deepEqual([...await kept.toArray()], [1]);
    assert.deepEqual(checkpoints[1], checkpoints[0]);
    assert.deepEqual(checkpoints[2], checkpoints[0]);
  } finally { await session.close(); }
});

test("already admitted independent successors inherit a committed session write failure", async () => {
  const realManifest = await readFile(new URL("../../../dist/manifest.json", import.meta.url), "utf8");
  let release;
  fixtures.virtualResponses.set("/copy-causal-successor.json", { body: Buffer.from(realManifest), contentType: "application/json",
    waitFor: new Promise(resolve => { release = resolve; }) });
  const url = new URL("copy-causal-successor.json", distributionUrl);
  let publications = 0;
  const fault = new Error("ordered publication failure");
  const session = createTestRuntimeSession({ manifestUrl: url, forceVariant: "scalar", beforeCopyPublication() {
    if (++publications === 1) throw fault;
  } });
  const input = session.tensor([2]);
  const source = input.add(input);
  const first = session.tensor([0]);
  const second = session.tensor([0]);
  first.copy_(source);
  second.copy_(input);
  release();
  try {
    const observed = await Promise.allSettled([first.toArray(), second.toArray()]);
    assert.equal(observed[0].status, "rejected");
    assert.equal(observed[1].status, "rejected");
    assert.equal(publications, 1);
    assert.deepEqual([...await input.toArray()], [2]);
  } finally { await session.close(); }
});

for (const shape of [[], [2, 0]]) for (const order of ['source-first', 'destination-first']) {
  test(`pending copy survives ${order} handle closure (${JSON.stringify(shape)})`, async () => {
    let release;
    const path = `/copy-close-${order}-${shape.length}.json`;
    fixtures.virtualResponses.set(path, { body: await readFile(new URL('../../../dist/manifest.json', import.meta.url)),
      contentType: 'application/json', waitFor: new Promise(resolve => { release = resolve; }) });
    const session = createTestRuntimeSession({ manifestUrl: new URL(path, distributionUrl), forceVariant: 'scalar' });
    const data = shape.length ? [] : [2];
    const input = session.tensor(data, { shape });
    const source = input.add(input);
    const destination = session.tensor(shape.length ? [] : [0], { shape });
    destination.copy_(source);
    const read = destination.toArray();
    if (order === 'source-first') { source.close(); input.close(); destination.close(); }
    else { destination.close(); source.close(); input.close(); }
    const closing = session.close();
    assert.ok(session.diagnostics().liveRequestLeases > 0);
    release();
    assert.deepEqual([...await read], shape.length ? [] : [4]);
    await closing;
    assert.equal(getTestRuntimeOwnership(session).pendingCopies, 0);
    assert.equal(session.diagnostics().liveAllocationBytes, 0);
    assert.equal(session.diagnostics().liveRequestLeases, 0);
  });
}

test('finite owner capacity rejects pending C views, arithmetic and observations without partial admission', async () => {
  let release;
  fixtures.virtualResponses.set('/copy-owner-limit.json', { body: await readFile(new URL('../../../dist/manifest.json', import.meta.url)),
    contentType: 'application/json', waitFor: new Promise(resolve => { release = resolve; }) });
  const session = createTestRuntimeSession({ manifestUrl: new URL('copy-owner-limit.json', distributionUrl), forceVariant: 'scalar', updateLimits: { owners: 16 } });
  const input = session.tensor([2]);
  const source = input.add(input);
  const destination = session.tensor([0]);
  try {
    destination.copy_(source);
    const before = getTestRuntimeOwnership(session);
    const diagnostics = session.diagnostics();
    for (const admit of [() => destination.view([1]), () => destination.add(input), () => destination.toArray()]) {
      assert.throws(admit, { code: 'RESOURCE_EXHAUSTED' });
      assert.deepEqual(getTestRuntimeOwnership(session), before);
      assert.equal(session.diagnostics().liveTensorHandles, diagnostics.liveTensorHandles);
      assert.equal(session.diagnostics().liveRequestLeases, diagnostics.liveRequestLeases);
    }
    assert.equal(getTestTensorVersion(destination), 1);
    release();
    await source.toArray();
    assert.deepEqual([...await destination.toArray()], [4]);
  } finally { release(); await session.close(); }
});

test('shared copy resident remains owned once after borrowed invocation rollback', async () => {
  const session = createTestRuntimeSession({ manifestUrl: fixtures.installFixture('copy-borrowed-rollback', { kernelBehavior: 'status', failureCall: 2 }), forceVariant: 'scalar' });
  try {
    const input = session.tensor([2]);
    const source = input.add(input);
    assert.deepEqual([...await source.toArray()], [4]);
    input.close();
    const destination = session.tensor([0]);
    destination.copy_(source);
    const sharedBytes = session.diagnostics().liveAllocationBytes;
    const failed = destination.add(source);
    await assert.rejects(failed.toArray(), { code: 'BACKEND_STATUS_ERROR' });
    assert.equal(session.diagnostics().liveAllocationBytes, sharedBytes);
    assert.deepEqual([...await destination.toArray()], [4]);
    assert.deepEqual([...await source.toArray()], [4]);
    destination.close(); failed.close();
    assert.equal(session.diagnostics().liveAllocationBytes, sharedBytes);
    source.close();
    assert.equal(session.diagnostics().liveAllocationBytes, 0);
  } finally { await session.close(); }
});

test('readback failure after copy publication preserves the successful version and permits later writes', async () => {
  const fault = new Error('copy readback');
  let inject = true;
  const session = createTestRuntimeSession({ manifestUrl: new URL('manifest.json', distributionUrl), forceVariant: 'scalar', beforeReadback() {
    if (inject) { inject = false; throw fault; }
  } });
  const input = session.tensor([2]);
  const source = input.add(input);
  const destination = session.tensor([0]);
  try {
    destination.copy_(source);
    await assert.rejects(destination.toArray(), error => error.cause === fault);
    assert.deepEqual([...await destination.toArray()], [4]);
    const calls = session.diagnostics().kernelCalls;
    destination.copy_(input);
    assert.deepEqual([...await destination.toArray()], [2]);
    assert.equal(session.diagnostics().kernelCalls, calls);
    assert.equal(getTestTensorVersion(destination), 2);
  } finally { await session.close(); }
});

test('preparation failures terminally gate copy snapshots and payload-free sum derivatives', async () => {
  const manifest = fixtures.installFixture('copy-preparation-failure', { omitKernelExport: true });
  const session = createTestRuntimeSession({ manifestUrl: manifest, forceVariant: 'scalar' });
  const input = session.tensor([2], { requiresGrad: true });
  const destination = session.tensor([0], { requiresGrad: true });
  const source = input.add(input);
  session.noGrad(() => destination.copy_(source));
  const total = destination.sum();
  const [gradient] = session.grad(total, [destination]);
  source.close(); destination.close(); total.close();
  try {
    await assert.rejects(gradient.toArray());
    await assert.rejects(gradient.toArray());
    assert.deepEqual([...await input.toArray()], [2]);
    assert.throws(() => input.copy_(input), { code: 'INPLACE_GRADIENT' });
    assert.throws(() => session.noGrad(() => input.copy_(input)), { code: 'MUTATION_FAILED' });
    assert.equal(getTestTensorVersion(input), 0);
    assert.equal(session.diagnostics().kernelCalls, 0);
  } finally { await session.close(); }
});
