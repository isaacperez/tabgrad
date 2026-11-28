import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";
import { createTestRuntimeSession } from "../../../dist/testing.js";

const fixtures = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist", import.meta.url)));
let manifest;
before(async () => { manifest = new URL("manifest.json", await fixtures.start()); });
after(async () => { await fixtures.close(); });
const typed = { format: "typed" };

for (const forceVariant of ["scalar", "simd128"]) {
  test(`indexSelect keeps data bits, axis geometry and duplicate order (${forceVariant})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl: manifest, forceVariant });
    try {
      const position = session.tensor([2n, 0n, 2n], { dtype: "int64" });
      const values = session.tensor(Float32Array.of(-0, NaN, 1, 2, 3, 4), { shape: [3, 2] });
      const rows = values.indexSelect(-2, position);
      assert.deepEqual(rows.shape, [3, 2]);
      assert.equal(rows.dtype, "float32");
      assert.equal(rows.requiresGrad, false);
      values.close();
      position.close();
      assert.deepEqual(await rows.toArray(typed), Float32Array.of(3, 4, -0, NaN, 3, 4));

      const narrow = session.tensor(Int32Array.of(-2147483648, 3, 2147483647, -4), { dtype: "int32", shape: [2, 2] });
      const one = session.tensor(Int32Array.of(1), { dtype: "int32", shape: [] });
      const selected = narrow.indexSelect(1, one);
      assert.deepEqual(selected.shape, [2, 1]);
      assert.deepEqual(await selected.toArray(typed), Int32Array.of(3, -4));

      const wide = session.tensor([-(2n ** 63n), 2n ** 53n + 1n, 2n ** 63n - 1n], { dtype: "int64" });
      const max = wide.argmax();
      const picked = wide.indexSelect(0, max);
      assert.deepEqual(picked.shape, [1]);
      assert.deepEqual(await picked.toArray(typed), BigInt64Array.of(2n ** 63n - 1n));
      const zero = session.tensor([0], { dtype: "int32" });
      const scalar = wide.view([3]).indexSelect(0, one).view([]);
      const rankZero = scalar.indexSelect(-1, zero);
      assert.deepEqual(rankZero.shape, []);
      assert.deepEqual(await rankZero.toArray(typed), BigInt64Array.of(2n ** 53n + 1n));
    } finally { await session.close(); }
  });
}

test("indexSelect checks wide logical axes and defers payload failures", async () => {
  const session = createTestRuntimeSession({ manifestUrl: manifest });
  try {
    const wide = session.tensor([], { shape: [0, 2 ** 32 + 2] });
    const okay = session.tensor([4294967297n], { dtype: "int64" });
    const bad = session.tensor([4294967298n], { dtype: "int64" });
    const goodResult = wide.indexSelect(1, okay);
    const badResult = wide.indexSelect(1, bad);
    assert.deepEqual(goodResult.shape, [0, 1]);
    assert.deepEqual(badResult.shape, [0, 1]);
    assert.equal(session.diagnostics().kernelCalls, 0);
    assert.deepEqual(await goodResult.toArray(), new Float32Array());
    await assert.rejects(badResult.toArray(), { code: "INDEX_OUT_OF_BOUNDS" });
    const row = session.tensor([20, 30]);
    for (const value of [-1n, 4294967297n, 2n]) {
      const idx = session.tensor([0n, value], { dtype: "int64" });
      const output = row.indexSelect(0, idx);
      assert.deepEqual(output.shape, [2]);
      await assert.rejects(output.toArray(), { code: "INDEX_OUT_OF_BOUNDS" });
    }
    assert.deepEqual(await row.toArray(), Float32Array.of(20, 30));
    assert.throws(() => row.indexSelect(0, row), { code: "UNSUPPORTED_DTYPE" });
    assert.throws(() => row.indexSelect(1, okay), { code: "INVALID_SHAPE" });
    const empty = session.tensor([], { dtype: "int32" });
    assert.deepEqual(await row.indexSelect(0, empty).toArray(), new Float32Array());
    assert.throws(() => wide.indexSelect(0, okay), { code: "INDEX_OUT_OF_BOUNDS" });
    const trainable = session.tensor([2, 3], { requiresGrad: true });
    const position = session.tensor([1], { dtype: "int32" });
    assert.throws(() => trainable.indexSelect(0, position), { code: "UNSUPPORTED_GRADIENT" });
    const withoutGrad = session.noGrad(() => trainable.indexSelect(0, position));
    assert.deepEqual(await withoutGrad.toArray(), Float32Array.of(3));
  } finally { await session.close(); }
});

test("a failed selection cannot publish a copy or invalidate independent readers", async () => {
  const { completeRuntimeSession } = await import("../../../dist/runtime/runtime.js");
  let publications = 0;
  const session = createTestRuntimeSession({ manifestUrl: manifest, beforeCopyPublication: () => { publications++; } });
  try {
    const source = session.tensor([20, 30]);
    const destination = session.tensor([10, 11]);
    const alias = destination.view([2]);
    const earlier = session.tensor([5, 6]);
    earlier.copy_(source);
    const bad = session.tensor([0n, 4294967297n], { dtype: "int64" });
    const rejected = source.indexSelect(0, bad);
    assert.strictEqual(destination.copy_(rejected), destination);
    await assert.rejects(completeRuntimeSession(session), { code: "INDEX_OUT_OF_BOUNDS" });
    assert.equal(publications, 1);
    assert.deepEqual(await earlier.toArray(), Float32Array.of(20, 30));
    await assert.rejects(alias.toArray(), { code: "INDEX_OUT_OF_BOUNDS" });
    await completeRuntimeSession(session);
    assert.throws(() => destination.copy_(source), { code: "MUTATION_FAILED" });
    assert.deepEqual(await source.toArray(), Float32Array.of(20, 30));
  } finally { await session.close(); }
});
