import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";
import { createTestRuntimeSession, getTestRuntimeOwnership, getTestRuntimeSemanticOwnership } from "../../../dist/testing.js";
import { prepareRuntimeSession, completeRuntimeSession, completeGradientExposure, gradientExposureNeedsCompletion } from "../../../dist/runtime/runtime.js";
import { WriterOutcomeLedger } from "../../../dist/runtime/writer-outcome.js";
import { PythonRuntimeBridge } from "../../../dist/frontends/python/python-runtime-bridge.js";

const fixtures = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist", import.meta.url)));
let distributionUrl;
before(async () => { distributionUrl = await fixtures.start(); });
after(async () => { await fixtures.close(); });

async function failedGradients(controls = 1, repetitions = 1, maximumOwners) {
  const faults = [], handles = [];
  const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant: "scalar",
    ...(maximumOwners === undefined ? {} : { updateLimits: { owners: maximumOwners } }),
    beforeCopyPublication() { const fault = new Error("writer " + faults.length); faults.push(fault); throw fault; } });
  const own = handle => { handles.push(handle); return handle; };
  const requested = [];
  let root;
  for (let index = 0; index < controls; index++) {
    const input = own(session.tensor([2], { requiresGrad: true })); requested.push(input);
    const branch = own(input.add(own(session.tensor([3]))));
    const copiedInput = own(session.tensor([5])), copiedSource = own(copiedInput.add(copiedInput));
    session.noGrad(() => branch.copy_(copiedSource));
    root = root === undefined ? branch : own(root.add(branch));
  }
  const seed = own(session.tensor([7]));
  const gradients = session.grad(root, Array.from({ length: repetitions }, () => requested[0]), seed).map(own);
  await prepareRuntimeSession(session);
  try { await completeRuntimeSession(session); }
  catch (error) { assert.ok(faults.some(fault => causes(error, fault))); }
  return { session, handles, gradients, seed, faults };
}

function causes(error, expected) {
  if (error === expected) return true;
  return error?.cause !== undefined && causes(error.cause, expected)
    || Array.isArray(error?.errors) && error.errors.some(value => causes(value, expected));
}

function owners(session) {
  const semantic = getTestRuntimeSemanticOwnership(session), value = getTestRuntimeOwnership(session);
  return semantic.identityReferences + value.valueReferences + value.derivativeReferences
    + value.controlReferences + session.diagnostics().liveRequestLeases + value.undeliveredEffects;
}

async function retire(scenario) {
  for (const handle of scenario.handles.reverse()) handle.close();
  // Unobserved fault delivery remains the session's ordinary responsibility.
  try { await scenario.session.close(); }
  catch (error) { assert.ok(scenario.faults.some(fault => causes(error, fault))); }
  for (const [name, value] of Object.entries(getTestRuntimeOwnership(scenario.session))) assert.equal(value, 0, name);
}

for (const controls of [1, 2]) {
  test(`gradient completion cleans a partially retained compact capture (controls=${controls})`, async context => {
    const scenario = await failedGradients(controls);
    const before = getTestRuntimeOwnership(scenario.session);
    const fault = new Error("controlled retain after effect"), retain = WriterOutcomeLedger.prototype.retain;
    const replacement = context.mock.method(WriterOutcomeLedger.prototype, "retain", function (outcome) {
      retain.call(this, outcome); throw fault;
    });
    try {
      assert.throws(() => completeGradientExposure(scenario.session, scenario.gradients[0]), error => error === fault);
      assert.deepEqual(getTestRuntimeOwnership(scenario.session), before, "temporary controls leaked after retain failed");
    } finally { replacement.mock.restore(); await retire(scenario); }
  });
}

test("gradient completion attempts every release and preserves writer plus cleanup causes", async context => {
  const scenario = await failedGradients(2);
  const before = getTestRuntimeOwnership(scenario.session).controlReferences;
  const faults = [], release = WriterOutcomeLedger.prototype.release;
  const replacement = context.mock.method(WriterOutcomeLedger.prototype, "release", function (outcome) {
    release.call(this, outcome);
    const fault = new Error("controlled release " + faults.length); faults.push(fault); throw fault;
  });
  try {
    let caught;
    try { completeGradientExposure(scenario.session, scenario.gradients[0]); } catch (error) { caught = error; }
    assert.ok(causes(caught, scenario.faults[0]));
    assert.equal(faults.length, 2);
    assert.ok(faults.every(fault => causes(caught, fault)));
    assert.equal(getTestRuntimeOwnership(scenario.session).controlReferences, before);
  } finally { replacement.mock.restore(); await retire(scenario); }
});

test("gradient control completion uses ordinary capacity before retaining or delivering failures", async () => {
  const maximumOwners = 128, scenario = await failedGradients(1, 1, maximumOwners);
  try {
    while (owners(scenario.session) + 2 <= maximumOwners) scenario.handles.push(scenario.session.tensor([]));
    if (owners(scenario.session) === maximumOwners - 1) scenario.gradients[0].grad = scenario.seed;
    assert.equal(owners(scenario.session), maximumOwners, "the compact capture itself crosses capacity");
    const before = getTestRuntimeOwnership(scenario.session);
    assert.throws(() => completeGradientExposure(scenario.session, scenario.gradients[0]), { code: "RESOURCE_EXHAUSTED" });
    assert.deepEqual(getTestRuntimeOwnership(scenario.session), before);
    assert.equal(gradientExposureNeedsCompletion(scenario.gradients[0], scenario.seed), true);
    assert.equal(gradientExposureNeedsCompletion(scenario.gradients[0], scenario.gradients[0]), false);
    const bridge = new PythonRuntimeBridge(scenario.session);
    assert.throws(() => bridge.completeGradient(scenario.gradients[0]), { code: "PYTHON_SYNC_CONTEXT_REQUIRED" });
  } finally { await retire(scenario); }
});

test("matching incoming gradients share numbers while JS slots and close leases remain independent", async () => {
  const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant: "scalar" });
  const handles = [], own = value => { handles.push(value); return value; };
  try {
    const x = own(session.tensor([2,3], { requiresGrad: true })), y = own(session.tensor([4,5], { requiresGrad: true }));
    const output = own(x.add(y)), seed = own(session.tensor([7,9]));
    const [a,b,repeated] = session.grad(output, [x,y,x], seed).map(own);
    assert.equal(new Set([a,b,repeated,seed]).size, 4);
    a.grad = b;
    assert.equal(a.grad, b); assert.equal(b.grad, null); assert.equal(repeated.grad, null); assert.equal(seed.grad, null);
    a.grad = null;
    const zero = own(session.tensor([0,0]));
    session.noGrad(() => a.copy_(zero));
    a.close();
    assert.deepEqual([...await b.toArray()], [0,0]);
    assert.deepEqual([...await repeated.toArray()], [0,0]);
    assert.deepEqual([...await seed.toArray()], [0,0]);
    const bridge = new PythonRuntimeBridge(session);
    assert.equal(bridge.exposureKey(b), bridge.exposureKey(seed));
    assert.equal(bridge.resultNeedsCompletion(b, seed), false);
  } finally { for (const handle of handles.reverse()) handle.close(); await session.close(); }
  for (const value of Object.values(getTestRuntimeOwnership(session))) assert.equal(value, 0);
});

for (const shape of [[], [0], [2], [1,2], [2,0]]) {
  test(`explicit no-grad seed view preserves copy guards and base lifetime (${shape})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant: "scalar" });
    const size = shape.reduce((count, axis) => count * axis, 1), handles = [];
    const own = value => { handles.push(value); return value; };
    try {
      const x = own(session.tensor(new Float32Array(size).fill(2), { shape, requiresGrad: true }));
      const y = own(session.tensor(new Float32Array(size).fill(3), { shape, requiresGrad: true }));
      const original = own(session.tensor(new Float32Array(size).fill(7), { shape }));
      const seed = own(session.noGrad(() => original.view(shape)));
      original.close();
      const output = own(x.add(y)), gradients = session.grad(output, [x,y,x], seed).map(own);
      const source = own(session.tensor(new Float32Array(size).fill(4), { shape, requiresGrad: true }));
      assert.throws(() => seed.copy_(source), { code: "INPLACE_VIEW" });
      for (const gradient of gradients) assert.throws(() => gradient.copy_(source), { code: "INPLACE_VIEW" });
      seed.close();
      const zeros = own(session.tensor(new Float32Array(size), { shape }));
      session.noGrad(() => gradients[0].copy_(zeros));
      assert.deepEqual([...await gradients[1].toArray()], new Array(size).fill(0));
      assert.equal(gradients[1].requiresGrad, false);
    } finally { for (const handle of handles.reverse()) handle.close(); await session.close(); }
    for (const value of Object.values(getTestRuntimeOwnership(session))) assert.equal(value, 0);
  });
}
