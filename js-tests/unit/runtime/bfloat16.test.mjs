import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRuntimeSession } from "../../../dist/index.js";
import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";

test("bfloat16 matrix, broadcasting and sum keep intermediates resident", async () => {
  const server = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist/", import.meta.url)));
  const session = createRuntimeSession({ manifestUrl: new URL("manifest.json", await server.start()) });
  try {
    const dtype = "bfloat16";
    const left = session.tensor([2, 3], { dtype, shape: [2, 1] });
    const right = session.tensor([1, 2, -1], { dtype, shape: [1, 3] });
    const scale = session.tensor([1, 2, -1], { dtype });
    const bias = session.tensor([1, 0, 2], { dtype });
    const product = left.matmul(right);
    const scaled = product.mul(scale);
    const shifted = scaled.add(bias);
    const scalar = shifted.sum();
    assert.equal(product.dtype, dtype);
    assert.deepEqual(product.shape, [2, 3]);
    for (const handle of [left, right, scale, bias, product, scaled, shifted]) handle.close();
    assert.equal(scalar.dtype, dtype);
    assert.deepEqual(scalar.shape, []);
    assert.equal(scalar.requiresGrad, false);
    assert.deepEqual([...(await scalar.toArray())], [36]);
    assert.equal(session.diagnostics().hostToWasmBytes, 22);
    assert.equal(session.diagnostics().wasmToHostBytes, 2);
    scalar.close();
    assert.equal(session.diagnostics().liveTensorHandles, 0);
  } finally { await session.close(); await server.close(); }
});

for (const variant of ["scalar", "simd128"]) {
  test(`bfloat16 raw ${variant} kernels preserve the rounding boundaries`, async () => {
    const bytes = await readFile(new URL(`../../../dist/wasm/kernels-${variant}.wasm`, import.meta.url));
    const memory = new WebAssembly.Memory({ initial: 32, maximum: 1024 });
    const { instance } = await WebAssembly.instantiate(bytes, { env: { memory } });
    const { tabgrad_sum_bf16: sum, tabgrad_matmul_bf16: matmul, tabgrad_arena_base: arena } = instance.exports;
    assert.equal(typeof sum, "function");
    const input = arena() + 2;
    const output = input + 65536;
    const words = new Uint16Array(memory.buffer);
    for (const [label, values, expected] of [
      ["tiny term between maximum values", [0x7f7f, 1, 0xff7f], 1],
      ["sticky term breaks midpoint", [0x3f80, 0x3b80, 1], 0x3f81],
      ["finite overflow", [0x7f7f, 0x7f7f], 0x7f80],
      ["opposite infinities", [0x7f80, 0xff80], 0x7fc0],
      ["negative zeros", [0x8000, 0x8000], 0],
    ]) {
      words.set(values, input / 2);
      words[output / 2 + 1] = 0xbeef;
      assert.equal(sum(input, output, values.length), 0, label);
      assert.equal(words[output / 2], expected, label);
      assert.equal(words[output / 2 + 1], 0xbeef, label);
    }
    assert.equal(sum(memory.buffer.byteLength, output, 0), 0);
    assert.equal(words[output / 2], 0);
    assert.equal(sum(input + 1, output, 1), 1);
    assert.equal(sum(input, memory.buffer.byteLength, 0), 2);
    assert.equal(sum(input, input + 2, 2), 3);

    // Five columns exercise the SIMD block and scalar tail with the same
    // rounding-sensitive dot product. The output starts on a two-byte offset.
    const left = [0x1e00, 0x9a80, 0x1a00];
    const column = [0x1ec0, 0x1a00, 0x1a00];
    const right = input + 32;
    const matrixOutput = output + 2;
    words.set(left, input / 2);
    for (const flags of [0, 1, 2, 3]) {
      const weights = flags & 2 ? Array.from({ length: 5 }, () => column).flat()
        : column.flatMap(word => new Array(5).fill(word));
      words.set(weights, right / 2);
      words[matrixOutput / 2 + 5] = 0xbeef;
      assert.equal(matmul(input, right, matrixOutput, 1, 3, 5, flags), 0);
      assert.deepEqual(Array.from(words.slice(matrixOutput / 2, matrixOutput / 2 + 6)), [1, 1, 1, 1, 1, 0xbeef]);
    }
    assert.equal(matmul(input, right, input + 2, 1, 3, 5, 0), 3);
    assert.equal(matmul(input, right, matrixOutput, 1, 3, 5, 4), 4);
  });
}
