import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Tensor } from "../../dist/index.js";
import { finalizeTensorExposure, prepareRuntimeSession } from "../../dist/runtime/runtime.js";
import { createTestRuntimeSession } from "../../dist/testing.js";
import { RuntimeFixtureServer } from "./runtime-fixture-server.mjs";

assert.equal(typeof globalThis.gc, "function");
const fixtures = new RuntimeFixtureServer(fileURLToPath(new URL("../../dist", import.meta.url)));
const distributionUrl = await fixtures.start();
const originalClose = Tensor.prototype.close;
const rows = [];

function assertReleased(session) {
  for (const key of ["liveTensorHandles", "liveTensorValues", "liveDerivativeNodes",
    "liveSavedValues", "liveRequestLeases", "liveAllocationBytes"]) {
    assert.equal(session.diagnostics()[key], 0, key);
  }
}

async function collectUntil(check, describe) {
  for (let turn = 0; turn < 80; turn += 1) {
    await new Promise(resolve => setImmediate(resolve));
    globalThis.gc();
    await new Promise(resolve => setImmediate(resolve));
    if (check()) return;
  }
  assert.ok(check(), `dropped exposures must finalize after nested differentiation returns: ${JSON.stringify(describe())}`);
}

try {
  for (const forceVariant of ["scalar", "simd128"]) {
    for (const retirement of ["close", "frontend", "session"]) {
      for (const nestedError of [false, true]) {
        const options = { manifestUrl: new URL("manifest.json", distributionUrl), forceVariant };
        const other = createTestRuntimeSession(options);
        const closing = createTestRuntimeSession(options);
        const fault = new Error("controlled failure after real tensor close");
        let stage = "off", outerCalls = 0, innerCalls = 0;
        let parent, child, survivor, innerX, innerLoss;
        let nestedWeak, escapedWeak, parentWeak, childWeak, survivorWeak;
        const session = createTestRuntimeSession({
          ...options,
          onProgramFormed() {
            if (stage !== "outer") return;
            stage = "inner";
            outerCalls += 1;
            parent = other.tensor([31]);
            parentWeak = new WeakRef(parent);
            if (nestedError) {
              assert.throws(() => session.grad(innerLoss, [innerX]), error => error === fault);
            } else {
              let nested = session.grad(innerLoss, [innerX])[0];
              nestedWeak = new WeakRef(nested);
              nested = null;
            }
            assert.equal(innerCalls, 1);
            assert.throws(() => parent.shape, { code: "CLOSED_TENSOR" });
            parent = null;
            if (retirement === "close") child.close();
            else if (retirement === "frontend") finalizeTensorExposure(child);
            else closing.close();
            assert.throws(() => child.shape, { code: "CLOSED_TENSOR" });
            child = null;
            stage = "done";
          },
        });
        try {
          await prepareRuntimeSession(session);
          const x = session.tensor([2], { requiresGrad: true });
          const outerProduct = x.mul(x);
          const loss = outerProduct.sum();
          innerX = session.tensor([3], { requiresGrad: true });
          const innerProduct = innerX.mul(innerX);
          innerLoss = innerProduct.sum();
          const functionalGrad = session.grad;
          assert.throws(() => Reflect.apply(functionalGrad, session, [loss]), TypeError);
          assert.throws(() => Reflect.apply(functionalGrad, session, [loss, [x], undefined, undefined]), TypeError);
          assert.throws(() => Reflect.apply(functionalGrad, {}, [loss, [x]]), TypeError);
          for (const args of [[x, [x]], [x, [x], undefined]]) {
            const result = Reflect.apply(functionalGrad, session, args);
            assert.equal(result.length, 1);
            result[0].close();
          }
          // A controlled public reentrant probe after a real close, never a
          // simulated native finalizer. The child process isolates the override.
          Tensor.prototype.close = function () {
            const result = Reflect.apply(originalClose, this, []);
            if (stage === "inner") {
              stage = "innerDone";
              innerCalls += 1;
              parent.close();
              child = closing.tensor([32]);
              childWeak = new WeakRef(child);
              survivor = other.tensor([34]);
              survivorWeak = new WeakRef(survivor);
              let escaped = other.tensor([33]);
              escapedWeak = new WeakRef(escaped);
              escaped = null;
              if (nestedError) throw fault;
            }
            return result;
          };
          const baseline = session.diagnostics().liveTensorHandles;
          stage = "outer";
          assert.equal(loss.backward(), undefined);
          Tensor.prototype.close = originalClose;
          assert.equal(outerCalls, 1);
          assert.equal(innerCalls, 1);
          assert.equal(stage, "done");
          const gradient = x.grad;
          assert.equal(x.grad, gradient);
          assert.deepEqual([...await gradient.toArray()], [4]);
          gradient.close();
          assert.equal(innerX.grad, null);
          assert.deepEqual([...await survivor.toArray()], [34]);
          survivor.close();
          survivor = null;
          assert.equal(session.diagnostics().liveTensorHandles, baseline + 1);
          assert.equal(other.diagnostics().liveTensorHandles, 1);
          assert.equal(closing.diagnostics().liveTensorHandles, 0);
          // Dereferencing while polling would pin a target for the host job.
          await collectUntil(() => session.diagnostics().liveTensorHandles === baseline
            && other.diagnostics().liveTensorHandles === 0,
          () => ({ forceVariant, retirement, nestedError, baseline,
            session: session.diagnostics().liveTensorHandles, other: other.diagnostics().liveTensorHandles }));
          for (const weak of [nestedWeak, escapedWeak, parentWeak, childWeak, survivorWeak]) {
            if (weak !== undefined) assert.equal(weak.deref(), undefined);
          }
          assert.deepEqual(outerProduct.shape, [1]);
          assert.deepEqual(innerProduct.shape, [1]);
          rows.push({ forceVariant, retirement, nestedError });
        } finally {
          stage = "off";
          Tensor.prototype.close = originalClose;
          await session.close();
          await other.close();
          await closing.close();
          assertReleased(session);
          assertReleased(other);
          assertReleased(closing);
        }
      }
    }
  }
  process.stdout.write(`${JSON.stringify(rows)}\n`);
} finally {
  Tensor.prototype.close = originalClose;
  await fixtures.close();
}
