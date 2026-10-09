import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { checkSGDCase, isDirectSGDCase } from "../../browser/helpers/sgd-cases.mjs";
import { checkSGDHostGuards, checkSGDFaults, checkSGDFixedOwners } from "../../browser/helpers/sgd-lifetime.mjs";
import { WebAssemblyCpuBackend } from "../../../dist/backends/cpu/cpu-backend.js";
import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";
import { createRuntimeSession } from "../../../dist/index.js";
import { createTestRuntimeSession, getTestTensorVersion, getTestRuntimeOwnership, getTestRuntimeSemanticOwnership } from "../../../dist/testing.js";

const fixtures = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist", import.meta.url)));
let distributionUrl;
before(async () => { distributionUrl = await fixtures.start(); });
after(async () => { await fixtures.close(); });
const oracle = JSON.parse(await readFile(new URL("../../fixtures/python-tensor-oracle.json", import.meta.url), "utf8"));

test("SGD construction capture does not retain a frontend optimizer cycle", () => {
  const result = execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", `
import { readFile } from 'node:fs/promises';
import { createRuntimeSession } from './dist/index.js';
import { getTestRuntimeSemanticOwnership } from './dist/testing.js';
globalThis.fetch = async url => new Response(await readFile(url));
const session = createRuntimeSession();
let parameter = session.tensor([2]); let optimizer = session.sgd([parameter]);
parameter.optimizerCycle = optimizer;
const weak = new WeakRef(optimizer);
parameter = null; optimizer = null;
let collected = false;
const witness = new FinalizationRegistry(() => { collected = true; });
let witnessTarget = {};
witness.register(witnessTarget, null); witnessTarget = null;
// WeakRef construction keeps its target alive through the current job.
await new Promise(resolve => setImmediate(resolve));
while (!collected) { globalThis.gc(); await new Promise(resolve => setImmediate(resolve)); }
await new Promise(resolve => setImmediate(resolve));
const owners = getTestRuntimeSemanticOwnership(session);
console.log(JSON.stringify({ alive: weak.deref() !== undefined, exposures: owners.publicExposures,
  registrations: owners.optimizerRegistrations, occurrences: owners.optimizerOccurrences }));
await session.close();
`], { encoding: "utf8", timeout: 30_000 });
  assert.deepEqual(JSON.parse(result), { alive: false, exposures: 0, registrations: 0, occurrences: 0 });
});

for (const grouped of [false, true]) for (const hole of [0, 1, 2, "all", "undefined"]) {
  test(`SGD registration rejects ${grouped ? "grouped" : "flat"} parameter holes at ${hole} without roots`, async () => {
    const session = createRuntimeSession();
    const p = session.tensor([2]); const q = session.tensor([3]);
    const priorGroup = grouped ? session.tensor([4]) : null;
    const parameters = hole === "all" ? new Array(1) : [p, q];
    if (typeof hole === "number") {
      parameters.splice(hole, 0, undefined);
      delete parameters[hole];
    }
    if (hole === "undefined") parameters.splice(1, 0, undefined);
    const groups = grouped ? [{ params: [priorGroup] }, { params: parameters }] : parameters;
    const beforeOwners = getTestRuntimeOwnership(session);
    const beforeSemantic = getTestRuntimeSemanticOwnership(session);
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        assert.throws(() => session.sgd(groups), { code: "INVALID_TENSOR" });
        assert.deepEqual(getTestRuntimeOwnership(session), beforeOwners);
        assert.deepEqual(getTestRuntimeSemanticOwnership(session), beforeSemantic);
      }
    } finally {
      p.close(); q.close(); priorGroup?.close(); await session.close();
    }
    assert.ok(Object.values(getTestRuntimeOwnership(session)).every(value => value === 0));
    assert.equal(getTestRuntimeSemanticOwnership(session).identityReferences, 0);
  });
}

for (const grouped of [false, true]) for (const effect of ["none", "close-parameter", "close-session", "throw-after-close", "invalid-after-close"]) {
  test(`SGD registration preserves ${effect} indexed access in ${grouped ? "later" : "one"} group`, async () => {
    const session = createRuntimeSession();
    const p = session.tensor([2]); const q = session.tensor([3]);
    const parameters = grouped ? [q] : [p, q];
    const index = grouped ? 0 : 1;
    const sentinel = new Error("SGD parameter getter sentinel");
    const accesses = [];
    let closing;
    Object.defineProperty(parameters, index, { get() {
      accesses.push(index);
      if (effect !== "none") p.close();
      if (effect === "close-session") closing ??= session.close();
      if (effect === "throw-after-close") throw sentinel;
      return q;
    } });
    if (effect === "invalid-after-close") parameters.push(undefined);
    const groups = grouped ? [{ params: [p] }, { params: parameters }] : parameters;
    try {
      if (effect === "none") {
        const optimizer = session.sgd(groups);
        assert.deepEqual(accesses, [index, index, index]);
        assert.equal(getTestRuntimeSemanticOwnership(session).optimizerOccurrences, 2);
        optimizer.step(); optimizer.close();
      } else {
        const expected = effect === "throw-after-close" ? error => error === sentinel
          : { code: effect === "invalid-after-close" ? "INVALID_TENSOR" : "CLOSED_TENSOR" };
        assert.throws(() => session.sgd(groups), expected);
        assert.deepEqual(accesses, [index]);
        assert.equal(getTestRuntimeSemanticOwnership(session).optimizerOccurrences, 0);
      }
    } finally {
      p.close(); q.close(); await (closing ?? session.close());
    }
    assert.ok(Object.values(getTestRuntimeOwnership(session)).every(value => value === 0));
    assert.equal(getTestRuntimeSemanticOwnership(session).identityReferences, 0);
  });
}

for (const forceVariant of ["scalar", "simd128"]) {
  const createSession = (extra = {}) => createTestRuntimeSession({
    manifestUrl: new URL("manifest.json", distributionUrl), forceVariant, ...extra,
  });

  for (const presentation of ["changing-index", "iterator", "repeated-iterator", "multiple-groups"]) {
    test(`SGD publishes indexed-admitted parameters for ${presentation} (${forceVariant})`, async (context) => {
      const session = createSession();
      const p = session.tensor([2]); const q = session.tensor([10]);
      const r = session.tensor([4]); const prior = session.tensor([7]);
      const pGradient = session.tensor([3]); const qGradient = session.tensor([5]);
      const rGradient = session.tensor([1]); const priorGradient = session.tensor([2]);
      p.grad = pGradient; q.grad = qGradient; r.grad = rGradient; prior.grad = priorGradient;
      const repeated = presentation === "repeated-iterator";
      const admitted = presentation === "changing-index" ? [p] : repeated ? [p, p] : [p, r];
      const parameters = [...admitted];
      const accesses = [];
      if (presentation === "changing-index") {
        Object.defineProperty(parameters, 0, { get() {
          accesses.push("index");
          return accesses.length === 1 ? p : q;
        } });
      } else {
        parameters[Symbol.iterator] = function* () {
          accesses.push("iterator");
          yield q; yield repeated ? q : r;
        };
      }
      const group = { params: parameters, lr: 0.5, marker: "original group" };
      const groups = presentation === "multiple-groups" ? [{ params: [prior], lr: 0.5 }, group] : [group];
      const warnings = [];
      context.mock.method(console, "warn", (message) => warnings.push(message));
      let optimizer;
      try {
        optimizer = session.sgd(groups);
        assert.equal(optimizer.paramGroups.at(-1), group);
        assert.equal(group.marker, "original group");
        assert.notEqual(group.params, parameters);
        assert.equal(group.params.length, admitted.length);
        for (let index = 0; index < admitted.length; index += 1) assert.equal(group.params[index], admitted[index]);
        assert.deepEqual(accesses, presentation === "changing-index" ? ["index", "index", "index"] : ["iterator", "iterator"]);
        assert.equal(warnings.length, repeated ? 1 : 0);
        assert.equal(getTestRuntimeSemanticOwnership(session).optimizerOccurrences, admitted.length + (groups.length - 1));
        optimizer.step();
        assert.deepEqual(Array.from(await p.toArray()), [repeated ? -1 : 0.5]);
        assert.deepEqual(Array.from(await q.toArray()), [10]);
        assert.deepEqual(Array.from(await r.toArray()), [admitted.includes(r) ? 3.5 : 4]);
        assert.deepEqual(Array.from(await prior.toArray()), [groups.length === 2 ? 6 : 7]);
        assert.equal(getTestTensorVersion(p), repeated ? 2 : 1);
        assert.equal(getTestTensorVersion(q), 0);
        optimizer.zeroGrad();
        assert.equal(p.grad, null);
        if (admitted.includes(r)) assert.equal(r.grad, null);
        assert.equal(q.grad, qGradient);
        p.close();
        assert.throws(() => optimizer.step(), { code: "CLOSED_TENSOR" });
      } finally {
        optimizer?.close();
        for (const tensor of [p, q, r, prior, pGradient, qGradient, rGradient, priorGradient]) tensor.close();
        await session.close();
      }
      assert.ok(Object.values(getTestRuntimeOwnership(session)).every(value => value === 0));
      assert.equal(getTestRuntimeSemanticOwnership(session).identityReferences, 0);
      assert.equal(getTestRuntimeSemanticOwnership(session).optimizerRegistrations, 0);
    });
  }

  test(`SGD preserves a later iterator exception and retires registration (${forceVariant})`, async () => {
    const session = createSession(); const p = session.tensor([2]); const q = session.tensor([10]);
    const parameters = [p]; const sentinel = new Error("later SGD iteration"); let iterations = 0;
    parameters[Symbol.iterator] = function* () {
      iterations += 1;
      if (iterations === 2) throw sentinel;
      yield q;
    };
    const beforeOwners = getTestRuntimeOwnership(session);
    const beforeSemantic = getTestRuntimeSemanticOwnership(session);
    try {
      assert.throws(() => session.sgd([{ params: parameters }]), error => error === sentinel);
      assert.equal(iterations, 2);
      assert.deepEqual(getTestRuntimeOwnership(session), beforeOwners);
      assert.deepEqual(getTestRuntimeSemanticOwnership(session), beforeSemantic);
    } finally { p.close(); q.close(); await session.close(); }
  });

  test(`the public JavaScript SGD example executes unchanged (${forceVariant})`, async (context) => {
    const reference = await readFile(new URL("../../../docs/reference/sgd.md", import.meta.url), "utf8");
    const source = reference.match(/```javascript\n([\s\S]*?)\n```/)[1];
    const logs = []; context.mock.method(console, "log", (value) => logs.push(value));
    const session = createSession();
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    try { await new AsyncFunction("session", source)(session); }
    finally { await session.close(); }
    assert.deepEqual(logs, [[1.125, 1.6875]]);
  });

  for (const fixture of oracle.sgdCases.filter(isDirectSGDCase)) {
    test(`native SGD ${fixture.name} (${forceVariant})`, async () => {
      const session = createSession();
      try { await checkSGDCase(session, fixture, getTestTensorVersion); }
      finally { await session.close(); }
      assert.equal(session.diagnostics().liveTensorValues, 0);
      assert.equal(session.diagnostics().liveDerivativeNodes, 0);
      assert.equal(session.diagnostics().liveAllocationBytes, 0);
    });
  }

  test(`SGD rejects closure parameter restructuring (${forceVariant})`, async () => {
    const session = createSession();
    try {
      const p = session.tensor([2]); const q = session.tensor([4]); p.grad = session.tensor([3]);
      const group = { params: [p], lr: 0.5 }; const optimizer = session.sgd([group]);
      assert.throws(() => optimizer.step(() => { group.params = [q]; }), { code: "UNSUPPORTED_OPTIMIZER" });
      assert.equal(getTestTensorVersion(p), 0);
      optimizer.close();
    } finally { await session.close(); }
  });

  test(`SGD rejects malformed direct option fields (${forceVariant})`, async () => {
    const session = createSession(); const p = session.tensor([2]);
    try {
      for (const options of [null, { unknown: 1 }, { lr: undefined }, { momentum: undefined }, { foreach: undefined }, { lr: true }, { maximize: 0 }]) {
        assert.throws(() => session.sgd([p], options), TypeError);
      }
    } finally { await session.close(); }
  });

  test(`SGD validates close guards and independently drains failures (${forceVariant})`, async () => {
    await checkSGDHostGuards(createSession, getTestTensorVersion);
    await checkSGDFaults(createSession, getTestTensorVersion, getTestRuntimeOwnership, getTestRuntimeSemanticOwnership, WebAssemblyCpuBackend);
  });

  for (const length of [32, 4096, 65536]) {
    test(`SGD fixed-owner training retains no completed-step work at length ${length} (${forceVariant})`, async () => {
      const session = createSession();
      try { await checkSGDFixedOwners(session, length, getTestRuntimeOwnership, getTestRuntimeSemanticOwnership); }
      finally { await session.close(); }
      assert.equal(session.diagnostics().liveTensorValues, 0);
      assert.equal(session.diagnostics().liveAllocationBytes, 0);
    });
  }

  test(`SGD bounds empty registrations and rejects group replacement (${forceVariant})`, async () => {
    const bounded = createSession({ updateLimits: { owners: 0 } });
    try { assert.throws(() => bounded.sgd([{ params: [] }]), { code: "RESOURCE_EXHAUSTED" }); }
    finally { await bounded.close(); }
    const session = createSession();
    try {
      const p = session.tensor([2]);
      const original = { params: [p] };
      const groups = [original];
      const optimizer = session.sgd(groups);
      groups.push({ params: [] });
      assert.equal(optimizer.paramGroups.length, 1);
      optimizer.paramGroups[0] = { ...original };
      assert.throws(() => optimizer.zeroGrad(), { code: "UNSUPPORTED_OPTIMIZER" });
      optimizer.close();
    } finally { await session.close(); }
  });

  test(`SGD captures coefficients through ordinary programs and preserves aliases (${forceVariant})`, async () => {
    const programs = [];
    const session = createSession({ onProgramFormed: (program) => programs.push(program) });
    try {
      const p = session.tensor([50.29061508178711], { requiresGrad: true });
      const g = session.tensor([502.9061279296875]);
      p.grad = g;
      const group = { params: [p], lr: 0.1, tag: "retained" };
      const parameters = group.params;
      const optimizer = session.sgd([group]);
      assert.equal(optimizer.paramGroups[0], group);
      assert.notEqual(group.params, parameters);
      assert.equal(group.params[0], p);
      assert.equal(optimizer.state.size, 0);
      assert.equal(optimizer.step(), undefined);
      group.lr = 2;
      const value = await p.toArray();
      assert.equal(new Uint32Array(value.buffer, value.byteOffset, 1)[0], 0x35ce9e68);
      assert.equal(p.grad, g);
      assert.equal(getTestTensorVersion(p), 1);
      const computation = programs.flatMap((program) => program.computations).find((entry) => entry.kind === "add-alpha-f32");
      assert.equal(computation.alphaBits, 0xbdcccccd);
      assert.ok(Object.isFrozen(computation));
      optimizer.close();
      assert.deepEqual([...await g.toArray()], [502.9061279296875]);
    } finally { await session.close(); }
  });

  test(`SGD numerical resets detach only the gradient identity (${forceVariant})`, async () => {
    const session = createSession();
    try {
      const p = session.tensor([2], { requiresGrad: true });
      const source = session.tensor([3], { requiresGrad: true });
      const gradient = source.mul(source);
      const alias = gradient.view([1]);
      const saved = gradient.mul(source);
      p.grad = gradient;
      const optimizer = session.sgd([p]);
      optimizer.zeroGrad(false);
      assert.equal(p.grad, gradient);
      assert.equal(gradient.requiresGrad, false);
      assert.equal(alias.requiresGrad, true);
      assert.deepEqual([...await gradient.toArray()], [0]);
      assert.deepEqual([...await alias.toArray()], [0]);
      assert.throws(() => saved.backward(), { code: "SAVED_DETACHED" });
      optimizer.zeroGrad();
      assert.equal(p.grad, null);
      assert.deepEqual([...await gradient.toArray()], [0]);
      optimizer.close();
    } finally { await session.close(); }
  });

  test(`SGD uses sequential aliased values and one semantic root per occurrence (${forceVariant})`, async () => {
    const session = createSession();
    try {
      const p = session.tensor([2], { requiresGrad: true });
      const q = session.tensor([4], { requiresGrad: true });
      p.grad = q; q.grad = p;
      const optimizer = session.sgd([p, q], { lr: 0.5 });
      assert.equal(getTestRuntimeSemanticOwnership(session).optimizerOccurrences, 2);
      optimizer.step();
      assert.deepEqual([...await p.toArray()], [0]);
      assert.deepEqual([...await q.toArray()], [4]);
      p.close(); q.close();
      assert.throws(() => optimizer.zeroGrad(), { code: "CLOSED_TENSOR" });
      assert.equal(getTestRuntimeSemanticOwnership(session).optimizerOccurrences, 2);
      optimizer.close();
      assert.equal(getTestRuntimeSemanticOwnership(session).identities, 0);
      assert.equal(getTestRuntimeOwnership(session).backingBytes, 0);
    } finally { await session.close(); }
  });

  test(`SGD closure scope is synchronous and revalidates close guards (${forceVariant})`, async () => {
    const session = createSession();
    try {
      const p = session.tensor([2], { requiresGrad: true });
      p.grad = session.tensor([3]);
      const optimizer = session.sgd([p]);
      const promise = Promise.resolve(17);
      session.noGrad(() => {
        assert.equal(optimizer.step(() => {
          const loss = p.mul(p);
          assert.equal(loss.requiresGrad, true);
          loss.close();
          return promise;
        }), promise);
        const untracked = p.mul(p);
        assert.equal(untracked.requiresGrad, false);
        untracked.close();
      });
      const version = getTestTensorVersion(p);
      const error = new Error("closure sentinel");
      assert.throws(() => optimizer.step(() => { throw error; }), (caught) => caught === error);
      assert.equal(getTestTensorVersion(p), version);
      assert.throws(() => optimizer.step(() => { optimizer.close(); }), { code: "CLOSED_OPTIMIZER" });
      assert.equal(getTestTensorVersion(p), version);
    } finally { await session.close(); }
  });
}
