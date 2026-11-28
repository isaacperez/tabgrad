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
