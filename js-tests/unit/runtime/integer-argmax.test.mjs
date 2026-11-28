import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";
import { createTestRuntimeSession } from "../../../dist/testing.js";

const fixtures = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist", import.meta.url)));
let manifest;
before(async () => { manifest = new URL("manifest.json", await fixtures.start()); });
after(async () => { await fixtures.close(); });

test("exact integer creation observes independently owned bytes without a number conversion", async () => {
  const session = createTestRuntimeSession({ manifestUrl: manifest });
  try {
    const signed = BigInt64Array.of(-(2n ** 63n), 2n ** 53n, 2n ** 53n + 1n, 2n ** 63n - 1n);
    const expected = signed.slice();
    const value = session.tensor(signed, { dtype: "int64" });
    signed.fill(0n);
    const reshaped = value.view([2, 2]);
    value.close();
    assert.throws(() => reshaped.toArray(), { code: "UNSUPPORTED_DTYPE" });
    assert.equal(session.diagnostics().backendLoads, 0);
    const observation = await reshaped.toArray({ format: "typed" });
    assert.deepEqual(observation, expected);
    observation.fill(1n);
    assert.deepEqual(await reshaped.toArray({ format: "typed" }), expected);
    const integers = session.tensor([-2147483648n, 2147483647, 0], { dtype: "int32" });
    assert.deepEqual(await integers.toArray({ format: "typed" }), Int32Array.of(-2147483648, 2147483647, 0));
    for (const sample of [2 ** 53, 1.2, -(2n ** 63n) - 1n, 2n ** 63n, true]) {
      assert.throws(() => session.tensor([sample], { dtype: "int64" }), { code: "INVALID_DATA" });
    }
    assert.throws(() => session.tensor([2147483648], { dtype: "int32" }), { code: "INVALID_DATA" });
    assert.throws(() => session.tensor([1n], { dtype: "int64", requiresGrad: true }), { code: "UNSUPPORTED_GRADIENT" });
    assert.throws(() => session.tensor([1n]), { code: "INVALID_DATA" });
    reshaped.close();
    integers.close();
    assert.equal(session.diagnostics().liveTensorValues, 0);
  } finally { await session.close(); }
});

for (const forceVariant of ["scalar", "simd128"]) {
  test(`argmax retains axis positions, signed ordering, ties and IEEE values (${forceVariant})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl: manifest, forceVariant });
    try {
      const score = session.tensor([2, -0, 7, 0, 7, -0, 1, 2 ** -149, 4, 8, Infinity, 2, NaN, 3, NaN, NaN],
        { shape: [2, 4, 2], requiresGrad: true });
      const result = score.argmax(-2, true);
      const flat = score.argmax(null, true);
      assert.equal(result.requiresGrad, false);
      assert.equal(result.dtype, "int64");
      assert.deepEqual(result.shape, [2, 1, 2]);
      assert.deepEqual(flat.shape, [1, 1, 1]);
      assert.equal(session.diagnostics().kernelCalls, 0);
      score.close();
      assert.deepEqual(await result.toArray({ format: "typed" }), BigInt64Array.of(1n, 3n, 2n, 3n));
      assert.deepEqual(await flat.toArray({ format: "typed" }), BigInt64Array.of(12n));
      const wide = session.tensor([2n ** 53n, 2n ** 53n + 1n, 2n ** 53n + 1n, -(2n ** 63n), -4294967297n, -4294967296n],
        { dtype: "int64", shape: [2, 3] });
      const wideIndices = wide.argmax(1);
      const scalar = session.tensor([-1], { dtype: "int32", shape: [] });
      const rankZero = scalar.argmax(-1, true);
      assert.deepEqual(rankZero.shape, []);
      assert.deepEqual(await wideIndices.toArray({ format: "typed" }), BigInt64Array.of(1n, 2n));
      assert.deepEqual(await rankZero.toArray({ format: "typed" }), BigInt64Array.of(0n));
      for (const value of [result, flat, wide, wideIndices, scalar, rankZero]) value.close();
      assert.equal(session.diagnostics().liveAllocationBytes, 0);
    } finally { await session.close(); }
  });
}

test("argmax admits a nonempty logical reduction axis in an empty result", async () => {
  const session = createTestRuntimeSession({ manifestUrl: manifest });
  try {
    const empty = session.tensor([], { shape: [0, 2 ** 32 + 2] });
    assert.throws(() => empty.argmax(), { code: "INVALID_SHAPE" });
    assert.throws(() => empty.argmax(0), { code: "INVALID_SHAPE" });
    assert.throws(() => empty.argmax(2), { code: "INVALID_SHAPE" });
    assert.throws(() => empty.argmax(0.5), TypeError);
    assert.throws(() => empty.argmax(1, null), TypeError);
    const result = empty.argmax(-1, true);
    assert.deepEqual(result.shape, [0, 1]);
    assert.deepEqual(await result.toArray({ format: "typed" }), new BigInt64Array());
    assert.equal(session.diagnostics().kernelCalls, 0);
    empty.close();
    result.close();
  } finally { await session.close(); }
});
