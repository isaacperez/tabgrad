import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";
import { createTestRuntimeSession, getTestRuntimeOwnership, getTestRuntimeSemanticOwnership, getTestTensorVersion } from "../../../dist/testing.js";
import { registerOptimizerLease } from "../../../dist/runtime/runtime.js";
import { WebAssemblyCpuBackend } from "../../../dist/backends/cpu/cpu-backend.js";

const fixtures = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist", import.meta.url)));
let distributionUrl;
before(async () => { distributionUrl = await fixtures.start(); });
after(async () => { await fixtures.close(); });
const ALPHA = 0xbf000000;

function causes(error) {
  return error instanceof AggregateError ? error.errors.flatMap(causes) : [error];
}

for (const forceVariant of ["scalar", "simd128"]) {
  const createSession = (extra = {}) => createTestRuntimeSession({
    manifestUrl: new URL("manifest.json", distributionUrl), forceVariant, ...extra,
  });

  test(`capture roots survive exposure/association removal and cyclic collection (${forceVariant})`, async () => {
    const session = createSession();
    try {
      const p = session.tensor([2]); const g = session.tensor([3]); const cycle = session.tensor([7]);
      p.grad = g; g.grad = cycle; cycle.grad = g;
      const lease = registerOptimizerLease(session, [[p]]);
      let expired;
      assert.equal(lease.withGroup(0, (scope) => {
        expired = scope;
        assert.equal(scope.hasGradient(0), true);
        assert.equal(scope.capture(0), true);
        g.close(); cycle.close(); p.grad = null;
        const owners = getTestRuntimeSemanticOwnership(session);
        assert.equal(owners.optimizerCaptureOccurrences, 1);
        assert.equal(owners.optimizerCaptureScopes, 1);
        assert.equal(owners.gradientAssociations, 2, "captured cycle remains reachable");
        scope.apply(ALPHA);
        return 42;
      }), 42);
      assert.throws(() => expired.capture(0), TypeError);
      assert.throws(() => expired.apply(ALPHA), TypeError);
      assert.deepEqual(Array.from(await p.toArray()), [0.5]);
      const owners = getTestRuntimeSemanticOwnership(session);
      assert.equal(owners.optimizerCaptureOccurrences, 0);
      assert.equal(owners.optimizerCaptureScopes, 0);
      assert.equal(owners.gradientAssociations, 0);
      lease.close(); p.close();
    } finally { await session.close(); }
    assert.equal(session.diagnostics().liveTensorValues, 0);
    assert.equal(session.diagnostics().liveAllocationBytes, 0);
  });

  test(`nested capture scopes retain duplicate occurrence identities (${forceVariant})`, async () => {
    const session = createSession();
    try {
      const p = session.tensor([2]); const old = session.tensor([3]); const replacement = session.tensor([9]);
      p.grad = old;
      const lease = registerOptimizerLease(session, [[p, p]]);
      lease.withGroup(0, (outer) => {
        outer.capture(0); p.grad = replacement; old.close(); outer.capture(1);
        lease.withGroup(0, (inner) => {
          inner.capture(0);
          assert.equal(getTestRuntimeSemanticOwnership(session).optimizerCaptureOccurrences, 3);
          inner.apply(ALPHA);
        });
        assert.equal(getTestRuntimeSemanticOwnership(session).optimizerCaptureOccurrences, 2);
        outer.apply(ALPHA);
      });
      assert.deepEqual(Array.from(await p.toArray()), [-8.5]);
      assert.equal(getTestTensorVersion(p), 3);
      assert.equal(getTestRuntimeSemanticOwnership(session).optimizerCaptureOccurrences, 0);
      lease.close(); p.close(); replacement.close();
    } finally { await session.close(); }
  });

  test(`capacity failure rolls back the whole invocation and invalidates its view (${forceVariant})`, async () => {
    const session = createSession({ updateLimits: { owners: 10 } });
    try {
      const p = session.tensor([2]); const g = session.tensor([3]); p.grad = g;
      const lease = registerOptimizerLease(session, [[p]]);
      const baseline = getTestRuntimeSemanticOwnership(session).identityReferences;
      let expired; let acquired = 0;
      assert.throws(() => lease.withGroup(0, (scope) => {
        expired = scope;
        for (let index = 0; index < 10; index += 1) { scope.capture(0); acquired += 1; }
      }), { code: "RESOURCE_EXHAUSTED" });
      assert.ok(acquired > 0 && acquired < 10);
      assert.throws(() => expired.hasGradient(0), TypeError);
      const owners = getTestRuntimeSemanticOwnership(session);
      assert.equal(owners.identityReferences, baseline);
      assert.equal(owners.optimizerCaptureOccurrences, 0);
      assert.equal(owners.optimizerCaptureScopes, 0);
      assert.equal(getTestTensorVersion(p), 0);
      lease.close(); p.close(); g.close();
    } finally { await session.close(); }
  });

  for (const closing of ["optimizer", "session"]) {
    test(`capture revocation rejects new admission after ${closing} close (${forceVariant})`, async () => {
      const session = createSession(); let joined;
      try {
        const p = session.tensor([2]); const g = session.tensor([3]); p.grad = g;
        const lease = registerOptimizerLease(session, [[p]]);
        const original = new Error("caller exception");
        assert.throws(() => lease.withGroup(0, (scope) => {
          scope.capture(0);
          if (closing === "session") joined = session.close(); else lease.close();
          for (const operation of [() => scope.capture(0), () => scope.apply(ALPHA)]) {
            assert.throws(operation, { code: closing === "session" ? "CLOSED_SESSION" : "CLOSED_OPTIMIZER" });
          }
          throw original;
        }), (error) => error === original);
        if (joined) await joined;
        else { assert.equal(getTestTensorVersion(p), 0); p.close(); g.close(); }
        assert.equal(getTestRuntimeSemanticOwnership(session).optimizerCaptureOccurrences, 0);
        assert.equal(getTestRuntimeSemanticOwnership(session).optimizerCaptureScopes, 0);
      } finally { await session.close(); }
    });
  }

  test(`exceptional scope exit retains accepted writes and original error (${forceVariant})`, async () => {
    const session = createSession();
    try {
      const p = session.tensor([2]); const g = session.tensor([3]); p.grad = g;
      const lease = registerOptimizerLease(session, [[p]]); const original = new Error("after update"); let expired;
      assert.throws(() => lease.withGroup(0, (scope) => {
        expired = scope; scope.capture(0); g.close(); p.grad = null; scope.apply(ALPHA); throw original;
      }), (error) => error === original);
      assert.throws(() => expired.apply(ALPHA), TypeError);
      assert.deepEqual(Array.from(await p.toArray()), [0.5]);
      assert.equal(getTestTensorVersion(p), 1);
      assert.equal(getTestRuntimeOwnership(session).pendingCopies, 0);
      assert.equal(getTestRuntimeSemanticOwnership(session).optimizerCaptureOccurrences, 0);
      lease.close(); p.close();
    } finally { await session.close(); }
  });

  test(`scope retirement attempts independent releases and preserves all causes (${forceVariant})`, async () => {
    const session = createSession(); const release = WebAssemblyCpuBackend.prototype.release;
    try {
      const p = session.tensor([2]); const q = session.tensor([4]);
      const left = session.tensor([3]); const right = session.tensor([5]);
      const first = left.add(left); const second = right.add(right);
      await first.toArray(); await second.toArray(); left.close(); right.close();
      p.grad = first; q.grad = second;
      const lease = registerOptimizerLease(session, [[p, q]]);
      const original = new Error("primary callback"); const faults = [new Error("first capture release"), new Error("second capture release")]; let calls = 0;
      WebAssemblyCpuBackend.prototype.release = function (allocation) { release.call(this, allocation); throw faults[calls++]; };
      assert.throws(() => lease.withGroup(0, (scope) => {
        scope.capture(0); scope.capture(1);
        first.close(); second.close(); p.grad = null; q.grad = null;
        throw original;
      }), (error) => {
        assert.deepEqual(causes(error), [original, ...faults]); return true;
      });
      assert.equal(calls, 2);
      assert.equal(getTestRuntimeSemanticOwnership(session).optimizerCaptureOccurrences, 0);
      assert.equal(getTestRuntimeSemanticOwnership(session).optimizerCaptureScopes, 0);
      WebAssemblyCpuBackend.prototype.release = release;
      lease.close(); p.close(); q.close();
    } finally { WebAssemblyCpuBackend.prototype.release = release; await session.close(); }
  });
}
