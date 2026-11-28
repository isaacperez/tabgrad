import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestRuntimeSession } from "../../../dist/testing.js";
import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";

const fixtures = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist", import.meta.url)));
let manifestUrl;
before(async () => { manifestUrl = new URL("manifest.json", await fixtures.start()); });
after(async () => { await fixtures.close(); });

test("explicit boolean tensors retain compact owned bytes and an ordinary view lifetime", async () => {
  const session = createTestRuntimeSession({ manifestUrl });
  try {
    const source = [true, false, -0, Number.MIN_VALUE, NaN, -Infinity];
    const tensor = session.tensor(source, { dtype: "bool" });
    const view = tensor.view([2, 3]);
    tensor.close();
    source.fill(false);
    assert.equal(view.dtype, "bool");
    assert.deepEqual(view.shape, [2, 3]);
    const typed = await view.toArray({ format: "typed" });
    assert.deepEqual(typed, Uint8Array.of(1, 0, 0, 1, 1, 1));
    typed.fill(0);
    assert.deepEqual(await view.toArray(), Float32Array.of(1, 0, 0, 1, 1, 1));
    assert.throws(() => session.tensor([true], { dtype: "bool", requiresGrad: true }), {
      code: "UNSUPPORTED_GRADIENT",
    });
    assert.throws(() => session.tensor(["true"], { dtype: "bool" }), { code: "INVALID_DATA" });
    view.close();
    assert.equal(session.diagnostics().liveTensorValues, 0);
  } finally { await session.close(); }
});

for (const forceVariant of ["scalar", "simd128"]) {
  test(`gt preserves float32 ordering and captures broadcast operands without recording (${forceVariant})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl, forceVariant });
    try {
      const tiny = 2 ** -149;
      const left = session.tensor([NaN, -0, tiny, -tiny, Infinity], { shape: [1, 5], requiresGrad: true });
      const right = session.tensor([0, -2 * tiny], { shape: [2, 1] });
      const output = left.gt(right);
      assert.deepEqual(output.shape, [2, 5]);
      assert.equal(output.dtype, "bool");
      assert.equal(output.requiresGrad, false);
      assert.throws(() => output.toArray({ format: "other" }), TypeError);
      assert.equal(session.diagnostics().kernelCalls, 0);
      left.close();
      right.close();
      assert.deepEqual(await output.toArray({ format: "typed" }), Uint8Array.of(0, 0, 1, 0, 1, 0, 1, 1, 1, 1));
      const diagnostics = session.diagnostics();
      assert.equal(diagnostics.hostToWasmBytes, 28);
      assert.equal(diagnostics.wasmToHostBytes, 10);
      assert.equal(diagnostics.kernelCalls, 1);
      output.close();
      assert.equal(session.diagnostics().liveAllocationBytes, 0);
    } finally { await session.close(); }
  });
}

test("gt admits rank-zero and empty values and rejects unregistered signatures", async () => {
  const session = createTestRuntimeSession({ manifestUrl });
  try {
    const scalar = session.tensor([3], { shape: [] });
    const rankZero = scalar.gt(scalar);
    assert.deepEqual(rankZero.shape, []);
    assert.deepEqual(await rankZero.toArray({ format: "typed" }), Uint8Array.of(0));
    const empty = session.tensor([], { shape: [2, 0, 3] });
    const emptyMask = empty.gt(scalar);
    assert.deepEqual(emptyMask.shape, [2, 0, 3]);
    assert.deepEqual(await emptyMask.toArray({ format: "typed" }), new Uint8Array());
    const half = session.tensor([1], { dtype: "float16" });
    assert.throws(() => scalar.gt(half), { code: "UNSUPPORTED_DTYPE" });
    for (const value of [scalar, rankZero, empty, emptyMask, half]) value.close();
  } finally { await session.close(); }
});

for (const forceVariant of ["scalar", "simd128"]) {
  test(`where shares three-way broadcasting and preserves selected bits (${forceVariant})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl, forceVariant });
    try {
      const score = session.tensor([1], { shape: [] });
      const limits = session.tensor([0, 2], { shape: [1, 2, 1] });
      const mask = score.gt(limits);
      const yes = session.tensor([5, 6, 7], { shape: [1, 1, 3] });
      const no = session.tensor([-0, NaN], { shape: [2, 1, 1] });
      const selected = session.where(mask, yes, no);
      assert.equal(selected.dtype, "float32");
      assert.deepEqual(selected.shape, [2, 2, 3]);
      assert.equal(session.diagnostics().kernelCalls, 0);
      for (const value of [score, limits, mask, yes, no]) value.close();
      assert.deepEqual(await selected.toArray(), Float32Array.of(5, 6, 7, -0, -0, -0, 5, 6, 7, NaN, NaN, NaN));
      const diagnostics = session.diagnostics();
      assert.equal(diagnostics.hostToWasmBytes, 32);
      assert.equal(diagnostics.wasmToHostBytes, 48);
      assert.equal(diagnostics.kernelCalls, 2);
      selected.close();
      assert.equal(session.diagnostics().liveAllocationBytes, 0);
    } finally { await session.close(); }
  });
}

test("where captures the mask and accumulates gradients from repeated branches", async () => {
  const session = createTestRuntimeSession({ manifestUrl });
  try {
    const x = session.tensor([1, 2], { shape: [1, 2], requiresGrad: true });
    const mask = session.tensor([true, false, true], { shape: [3, 1], dtype: "bool" });
    const y = session.where(mask, x, x), sum = y.sum();
    mask.close();
    session.noGrad(() => {
      const replacement = session.tensor([9, 9], { shape: [1, 2] });
      x.copy_(replacement);
      replacement.close();
    });
    assert.deepEqual(await y.toArray(), Float32Array.of(1, 2, 1, 2, 1, 2));
    const [gradient] = session.grad(sum, [x]);
    assert.deepEqual(gradient.shape, [1, 2]);
    assert.deepEqual(await gradient.toArray(), Float32Array.of(3, 3));
    for (const value of [gradient, sum, y, x]) value.close();
    assert.equal(session.diagnostics().liveSavedValues, 0);
    assert.equal(session.diagnostics().liveAllocationBytes, 0);
  } finally { await session.close(); }
});

test("where routes selected signed zeros and isolates unselected NaN seeds", async () => {
  const session = createTestRuntimeSession({ manifestUrl });
  try {
    const x = session.tensor([1, 2], { requiresGrad: true });
    const y = session.tensor([3, 4], { requiresGrad: true });
    const condition = session.tensor([true, false], { dtype: "bool" });
    const result = session.where(condition, x, y), seed = session.tensor([-0, NaN]);
    const [left, right] = session.grad(result, [x, y], seed);
    assert.deepEqual(await left.toArray(), Float32Array.of(-0, 0));
    assert.deepEqual(await right.toArray(), Float32Array.of(0, NaN));
    const invalid = session.tensor([false, false, true], { dtype: "bool" });
    const before = session.diagnostics();
    assert.throws(() => session.where(x, x, y), { code: "UNSUPPORTED_DTYPE" });
    assert.throws(() => session.where(invalid, x, y), { code: "SHAPE_MISMATCH" });
    assert.deepEqual(session.diagnostics(), before);
    for (const value of [invalid, left, right, result, seed, condition, x, y]) value.close();
    assert.equal(session.diagnostics().liveAllocationBytes, 0);
  } finally { await session.close(); }
});

test("where keeps a comparison snapshot and restores a rank-only broadcast branch", async () => {
  const session = createTestRuntimeSession({ manifestUrl });
  try {
    const score = session.tensor([1, -1], { shape: [1, 2] });
    const zero = session.tensor([0], { shape: [] });
    const mask = score.gt(zero);
    const left = session.tensor([10, 20], { requiresGrad: true });
    const right = session.tensor([30, 40], { shape: [1, 2], requiresGrad: true });
    const result = session.where(mask, left, right);
    mask.close();
    const changed = session.tensor([-1, 1], { shape: [1, 2] });
    session.noGrad(() => score.copy_(changed));
    const seed = session.tensor([2, 3], { shape: [1, 2] });
    const [dx, dy] = session.grad(result, [left, right], seed);
    assert.deepEqual(await result.toArray(), Float32Array.of(10, 40));
    assert.deepEqual(dx.shape, [2]);
    assert.deepEqual(dy.shape, [1, 2]);
    assert.deepEqual(await dx.toArray(), Float32Array.of(2, 0));
    assert.deepEqual(await dy.toArray(), Float32Array.of(0, 3));
    for (const value of [dx, dy, seed, result, left, right, score, zero, changed]) value.close();
    assert.equal(session.diagnostics().liveSavedValues, 0);
    assert.equal(session.diagnostics().liveAllocationBytes, 0);
  } finally { await session.close(); }
});
