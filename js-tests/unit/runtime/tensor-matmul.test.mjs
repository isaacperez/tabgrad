import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";
import { createRuntimeSession, Tensor } from "../../../dist/index.js";
import { inspectExecutionFailureContext } from "../../../dist/shared/errors.js";
import { createTestRuntimeSession } from "../../../dist/testing.js";
import { getTestRuntimeOwnership, getTestRuntimeSemanticOwnership } from "../../../dist/testing.js";
import { completeRuntimeSession } from "../../../dist/runtime/runtime.js";
import { checkMatrixCases, checkMatrixTraining, checkMatrixPending } from "../../browser/helpers/matrix-cases.mjs";

const fixtures = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist", import.meta.url)));
let manifestUrl;
before(async () => { manifestUrl = new URL("manifest.json", await fixtures.start()); });
after(() => fixtures.close());

function matrixOwnership(session) {
  return { ...getTestRuntimeOwnership(session),
    ...Object.fromEntries(Object.entries(getTestRuntimeSemanticOwnership(session)).filter(([key]) => !key.startsWith("collector"))) };
}

for (const variant of ["scalar", "simd128"]) {
  test(`matrix numerical VJPs and repeated resident training (${variant})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl, forceVariant: variant });
    try {
      const results = await checkMatrixCases(session);
      assert.ok(results.cases > 0 && results.comparedWords > 0);
      await checkMatrixTraining(session, completeRuntimeSession, matrixOwnership);
      await checkMatrixPending(session, completeRuntimeSession, matrixOwnership);
    } finally { await session.close(); }
    assert.equal(session.diagnostics().liveAllocationBytes, 0);
  });
  test(`empty matrix execution counts actual ABI calls (${variant})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl, forceVariant: variant });
    try {
      for (const [leftShape, rightShape] of [[[0, 3], [3, 2]], [[0, 0x100000001], [0x100000001, 0]]]) {
        const a = session.tensor(new Float32Array(leftShape[0] * leftShape[1]), { shape: leftShape });
        const b = session.tensor(new Float32Array(rightShape[0] * rightShape[1]), { shape: rightShape });
        const y = a.matmul(b);
        const before = session.diagnostics().kernelCalls;
        assert.deepEqual([...await y.toArray()], []);
        assert.equal(session.diagnostics().kernelCalls, before, "no raw matrix export is called for empty output");
        for (const value of [a, b, y]) value.close();
      }
    } finally { await session.close(); }
    assert.equal(session.diagnostics().liveAllocationBytes, 0);
  });
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

test("matrix output capacity rejects unsafe products of valid empty inputs", async () => {
  const session = createRuntimeSession();
  try {
    for (const dimension of [0x10000, Number.MAX_SAFE_INTEGER]) {
      const a = session.tensor([], { shape: [dimension, 0] });
      const b = session.tensor([], { shape: [0, dimension === Number.MAX_SAFE_INTEGER ? 2 : dimension] });
      const before = session.diagnostics();
      assert.throws(() => a.matmul(b), { code: "RESOURCE_EXHAUSTED" });
      assert.deepEqual(session.diagnostics(), before, "capacity rejection must not publish or capture work");
      a.close(); b.close();
    }
  } finally { await session.close(); }
});

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

for (const kernelBehavior of ["status", "trap"]) {
  test(`matrix ${kernelBehavior} preserves producer provenance, rollback and quarantine`, async () => {
    const failingManifest = fixtures.installFixture(`matrix-${kernelBehavior}`, { kernelBehavior });
    const session = createTestRuntimeSession({ manifestUrl: failingManifest, forceVariant: "scalar" });
    const a = session.tensor([2], { shape: [1, 1] }), y = a.matmul(a), loss = y.sum();
    try {
      await assert.rejects(loss.toArray(), error => {
        const context = inspectExecutionFailureContext(error);
        assert.equal(context.operation, "matmul"); assert.equal(context.provenance.source, "Tensor.matmul");
        assert.notEqual(context.programValueSlot, context.program.result);
        assert.equal(error.code, kernelBehavior === "trap" ? "BACKEND_TRAP" : "BACKEND_STATUS_ERROR");
        return true;
      });
      assert.equal(session.diagnostics().liveRequestLeases, 0);
      assert.equal(session.diagnostics().liveAllocationBytes, 0);
      if (kernelBehavior === "trap") {
        const retry = a.matmul(a);
        try { await assert.rejects(retry.toArray(), { code: "BACKEND_TRAP" }); }
        finally { retry.close(); }
      }
    } finally { a.close(); y.close(); loss.close(); await session.close(); }
    assert.equal(session.diagnostics().liveSavedValues, 0);
  });
}
