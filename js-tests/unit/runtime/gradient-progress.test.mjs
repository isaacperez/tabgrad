import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";
import { createTestRuntimeSession, getTestRuntimeOwnership } from "../../../dist/testing.js";
import { checkGradientProgress } from "../../browser/helpers/gradient-progress-cases.mjs";

const fixtures = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist", import.meta.url)));
const oracle = JSON.parse(await readFile(new URL("../../fixtures/python-tensor-oracle.json", import.meta.url), "utf8"));
let distributionUrl;
before(async () => { distributionUrl = await fixtures.start(); });
after(async () => { await fixtures.close(); });

for (const forceVariant of ["scalar", "simd128"]) {
  for (const observeFailure of [false, true]) {
    test(`partial gradient cleanup preserves a mandatory copy failure (${forceVariant}, observed=${observeFailure})`, async () => {
      const fault = new Error("controlled mandatory publication failure");
      const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant,
        beforeCopyPublication() { throw fault; } });
      const x = session.tensor([2], { shape: [], requiresGrad: true });
      const y = session.tensor([3], { shape: [], requiresGrad: true });
      const bad = x.mul(x);
      const good = y.mul(y);
      const combined = bad.add(good);
      const root = combined.sum();
      session.noGrad(() => x.copy_(x));
      assert.throws(() => session.grad(root, [x, y]), { code: "SAVED_VERSION_MISMATCH" });
      assert.throws(() => session.grad(good, [y]), { code: "CONSUMED_HISTORY" });
      assert.equal(session.diagnostics().liveSavedValues, 2);
      for (const handle of [root, combined, good, bad]) handle.close();
      assert.equal(session.diagnostics().liveSavedValues, 0);
      if (observeFailure) {
        await assert.rejects(x.toArray(), error => error.cause === fault);
        assert.throws(() => session.noGrad(() => x.copy_(y)), { code: "MUTATION_FAILED" });
      }
      x.close(); y.close();
      if (observeFailure) await session.close();
      else await assert.rejects(session.close(), error => error === fault);
      assert.deepEqual(getTestRuntimeOwnership(session), { families: 0, backings: 0, backingBytes: 0,
        valueReferences: 0, derivativeReferences: 0, writerOutcomes: 0, controlReferences: 0,
        pendingCopies: 0, undeliveredEffects: 0 });
      assert.equal(session.diagnostics().liveRequestLeases, 0);
      assert.equal(session.diagnostics().liveAllocationBytes, 0);
      assert.equal(session.diagnostics().liveDerivativeNodes, 0);
    });
  }
  test(`fresh failure/success cycles retain a fixed owner set at 2/16/64 (${forceVariant})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
    const anchor = session.tensor([2], { requiresGrad: true });
    const alias = anchor.view([1, 1]);
    const checkpoints = [];
    try {
      for (let cycle = 1; cycle <= 64; cycle++) {
        for (const name of ["newer-good", "unsaved-good", "view-copy"]) {
          const fixture = oracle.gradientProgressCases.find(value => value.name === name);
          assert.notEqual(fixture, undefined);
          await checkGradientProgress(session, fixture);
        }
        if ([2, 16, 64].includes(cycle)) {
          assert.deepEqual([...await alias.toArray()], [2]);
          const ownership = getTestRuntimeOwnership(session);
          const diagnostics = session.diagnostics();
          assert.equal(ownership.pendingCopies, 0);
          assert.equal(ownership.undeliveredEffects, 0);
          assert.equal(diagnostics.liveRequestLeases, 0);
          checkpoints.push([ownership, diagnostics.liveTensorHandles, diagnostics.liveTensorValues,
            diagnostics.liveDerivativeNodes, diagnostics.liveSavedValues, diagnostics.liveAllocationBytes]);
        }
      }
      assert.deepEqual(checkpoints[1], checkpoints[0]);
      assert.deepEqual(checkpoints[2], checkpoints[0]);
    } finally { await session.close(); }
    assert.deepEqual(getTestRuntimeOwnership(session), { families: 0, backings: 0, backingBytes: 0,
      valueReferences: 0, derivativeReferences: 0, writerOutcomes: 0, controlReferences: 0,
      pendingCopies: 0, undeliveredEffects: 0 });
    assert.equal(session.diagnostics().liveAllocationBytes, 0);
    assert.equal(session.diagnostics().liveDerivativeNodes, 0);
    assert.equal(session.diagnostics().liveSavedValues, 0);
  });
  for (const fixture of oracle.gradientProgressCases) {
    test(`native functional progress: ${fixture.name} (${forceVariant})`, async () => {
      const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
      try { await checkGradientProgress(session, fixture); }
      finally { await session.close(); }
      assert.equal(session.diagnostics().liveTensorHandles, 0);
      assert.equal(session.diagnostics().liveTensorValues, 0);
      assert.equal(session.diagnostics().liveDerivativeNodes, 0);
      assert.equal(session.diagnostics().liveSavedValues, 0);
      assert.equal(session.diagnostics().liveAllocationBytes, 0);
      assert.equal(getTestRuntimeOwnership(session).controlReferences, 0);
    });
  }
}
