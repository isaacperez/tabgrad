import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";
import { createTestRuntimeSession, getTestRuntimeSemanticOwnership, getTestTensorVersion } from "../../../dist/testing.js";
import { registerOptimizerLease } from "../../../dist/runtime/runtime.js";

const fixtures = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist", import.meta.url)));
let distributionUrl;
before(async () => { distributionUrl = await fixtures.start(); });
after(async () => { await fixtures.close(); });

for (const forceVariant of ["scalar", "simd128"]) {
  const createSession = () => createTestRuntimeSession({
    manifestUrl: new URL("manifest.json", distributionUrl), forceVariant,
  });

  test(`group reset uses current associations and repeated occurrences (${forceVariant})`, async () => {
    const session = createSession();
    try {
      const p = session.tensor([2]); const q = session.tensor([4]);
      const old = session.tensor([3]); const replacement = session.tensor([9]);
      p.grad = old; q.grad = replacement;
      const lease = registerOptimizerLease(session, [[p, p], [q]]);
      lease.assertOpen(); p.grad = replacement;
      lease.zeroGradGroup(0, false);
      assert.equal(p.grad, replacement);
      assert.equal(getTestTensorVersion(replacement), 2);
      assert.deepEqual(Array.from(await old.toArray()), [3]);
      assert.deepEqual(Array.from(await replacement.toArray()), [0]);
      lease.zeroGradGroup(1, true);
      assert.equal(q.grad, null); assert.equal(p.grad, replacement);
      for (const index of [-1, 0.5, 2, NaN]) assert.throws(() => lease.zeroGradGroup(index, false), TypeError);
      lease.close(); p.close(); q.close(); old.close(); replacement.close();
      assert.equal(getTestRuntimeSemanticOwnership(session).optimizerOccurrences, 0);
      assert.equal(getTestRuntimeSemanticOwnership(session).optimizerRegistrations, 0);
    } finally { await session.close(); }
    assert.equal(session.diagnostics().liveTensorValues, 0);
    assert.equal(session.diagnostics().liveAllocationBytes, 0);
  });

  test(`group reset admits live targets while all-group entry remains global (${forceVariant})`, async () => {
    const session = createSession();
    try {
      const p = session.tensor([2]); const q = session.tensor([4]);
      const first = session.tensor([3]); const later = session.tensor([5]);
      p.grad = first; q.grad = later;
      const lease = registerOptimizerLease(session, [[p], [q], []]);
      lease.assertOpen(); q.close();
      assert.throws(() => lease.zeroGrad(false), { code: "CLOSED_TENSOR" });
      assert.equal(getTestTensorVersion(first), 0);
      lease.zeroGradGroup(0, false);
      assert.equal(getTestTensorVersion(first), 1);
      assert.throws(() => lease.zeroGradGroup(1, false), { code: "CLOSED_TENSOR" });
      assert.equal(getTestTensorVersion(later), 0);
      lease.close();
      assert.throws(() => lease.zeroGradGroup(2, false), { code: "CLOSED_OPTIMIZER" });
      p.close(); first.close(); later.close();
      await session.close();
      assert.throws(() => lease.zeroGradGroup(2, false), { code: "CLOSED_SESSION" });
    } finally { await session.close(); }
    assert.equal(session.diagnostics().liveTensorValues, 0);
    assert.equal(session.diagnostics().liveAllocationBytes, 0);
  });
}
