import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { checkSGDCase, isDirectSGDCase } from "../../browser/helpers/sgd-cases.mjs";
import { checkSGDHostGuards, checkSGDFaults, checkSGDFixedOwners } from "../../browser/helpers/sgd-lifetime.mjs";
import { WebAssemblyCpuBackend } from "../../../dist/backends/cpu/cpu-backend.js";
import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";
import { createTestRuntimeSession, getTestTensorVersion, getTestRuntimeOwnership, getTestRuntimeSemanticOwnership } from "../../../dist/testing.js";

const fixtures = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist", import.meta.url)));
let distributionUrl;
before(async () => { distributionUrl = await fixtures.start(); });
after(async () => { await fixtures.close(); });
const oracle = JSON.parse(await readFile(new URL("../../fixtures/python-tensor-oracle.json", import.meta.url), "utf8"));

for (const forceVariant of ["scalar", "simd128"]) {
  const createSession = (extra = {}) => createTestRuntimeSession({
    manifestUrl: new URL("manifest.json", distributionUrl), forceVariant, ...extra,
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
