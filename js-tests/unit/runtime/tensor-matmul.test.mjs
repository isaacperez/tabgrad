import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";
import { createRuntimeSession, Tensor } from "../../../dist/index.js";
import { createTestRuntimeSession } from "../../../dist/testing.js";

const fixtures = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist", import.meta.url)));
let manifestUrl;
before(async () => { manifestUrl = new URL("manifest.json", await fixtures.start()); });
after(() => fixtures.close());

for (const variant of ["scalar", "simd128"]) {
  test(`ordinary matrix forward and both functional VJPs (${variant})`, async () => {
    const programs = [];
    const session = createTestRuntimeSession({ manifestUrl, forceVariant: variant, onProgramFormed: p => programs.push(p) });
    try {
      const a = session.tensor([1, 2, 3, 4, 5, 6], { shape: [2, 3], requiresGrad: true });
      const b = session.tensor([7, 8, 9, 10, 11, 12], { shape: [3, 2], requiresGrad: true });
      const y = a.matmul(b);
      assert.deepEqual(y.shape, [2, 2]);
      assert.equal(session.diagnostics().kernelCalls, 0);
      assert.deepEqual(Array.from(await y.toArray()), [58, 64, 139, 154]);
      const seed = session.tensor([1, 2, 3, 4], { shape: [2, 2] });
      const [da, db] = session.grad(y, [a, b], seed);
      assert.deepEqual(Array.from(await da.toArray()), [23, 29, 35, 53, 67, 81]);
      assert.deepEqual(Array.from(await db.toArray()), [13, 18, 17, 24, 21, 30]);
      assert.equal(a.grad, null); assert.equal(b.grad, null);
      assert.deepEqual(programs.flatMap(p => p.computations).filter(c => c.kind === "matmul-f32").map(c => c.matrixFlags), [0, 2, 1]);
      for (const value of [a, b, y, seed, da, db]) value.close();
    } finally { await session.close(); }
    assert.equal(session.diagnostics().liveTensorValues, 0);
    assert.equal(session.diagnostics().liveSavedValues, 0);
    assert.equal(session.diagnostics().liveAllocationBytes, 0);
  });
}

test("matrix admission rejects malformed calls and contraction without executing or retaining work", async () => {
  const session = createRuntimeSession();
  const other = createRuntimeSession();
  try {
    const a = session.tensor([1, 2], { shape: [1, 2] });
    const b = session.tensor([3, 4], { shape: [2, 1] });
    const wrong = session.tensor([], { shape: [0, 3] });
    const vector = session.tensor([1, 2]);
    const foreign = other.tensor([3, 4], { shape: [2, 1] });
    const before = session.diagnostics();
    for (const args of [[], [b, b], [null], [1]]) assert.throws(() => a.matmul(...args));
    assert.throws(() => Tensor.prototype.matmul.call(null, b), { code: "INVALID_TENSOR" });
    assert.throws(() => a.matmul(wrong), { code: "SHAPE_MISMATCH" });
    assert.throws(() => vector.matmul(b), { code: "INVALID_SHAPE" });
    assert.throws(() => a.matmul(foreign), { code: "DIFFERENT_SESSION" });
    assert.deepEqual(session.diagnostics(), before);
    const discarded = a.matmul(b); discarded.close();
    assert.equal(session.diagnostics().kernelCalls, 0);
  } finally { await session.close(); await other.close(); }
});
