import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { matrixCases, assertMatrixWords } from "../../browser/helpers/float32-matrix-oracle.mjs";

const alignedMatrixBufferSpan = bytes => Math.ceil((bytes + 16) / 16) * 16;

for (const variant of ["scalar", "simd128"]) {
  test(`matrix raw kernel preserves sequential FMA in every orientation (${variant})`, async () => {
    const bytes = await readFile(new URL(`../../../dist/wasm/kernels-${variant}.wasm`, import.meta.url));
    const memory = new WebAssembly.Memory({ initial: 32, maximum: 1024 });
    const { instance } = await WebAssembly.instantiate(bytes, { env: { memory } });
    const kernel = instance.exports.tabgrad_matmul_f32;
    assert.equal(typeof kernel, "function");
    assert.ok(instance.exports.tabgrad_capabilities() & 32);
    const base = instance.exports.tabgrad_arena_base() >>> 0;
    for (const c of matrixCases()) {
      const b = base + alignedMatrixBufferSpan(c.left.byteLength), out = b + alignedMatrixBufferSpan(c.right.byteLength);
      new Uint32Array(memory.buffer, base, c.left.length).set(c.left);
      new Uint32Array(memory.buffer, b, c.right.length).set(c.right);
      const output = new Uint32Array(memory.buffer, out, c.expected.length + 4);
      output.fill(0xdeadbeef);
      assert.equal(kernel(base, b, out, ...c.shape, c.flags), 0, c.name);
      assertMatrixWords(output.slice(0, c.expected.length), c.expected, assert);
      assert.deepEqual(Array.from(output.slice(c.expected.length)), new Array(4).fill(0xdeadbeef));
    }
  });

  test(`matrix ABI distinguishes MK, KN, MN, flags and input/output alias (${variant})`, async () => {
    const bytes = await readFile(new URL(`../../../dist/wasm/kernels-${variant}.wasm`, import.meta.url));
    const memory = new WebAssembly.Memory({ initial: 32, maximum: 1024 });
    const { instance } = await WebAssembly.instantiate(bytes, { env: { memory } });
    const call = instance.exports.tabgrad_matmul_f32;
    assert.equal(typeof call, "function");
    const base = instance.exports.tabgrad_arena_base() >>> 0, end = memory.buffer.byteLength;
    assert.equal(call(base + 2, base + 64, base + 128, 2, 3, 4, 0), 1);
    assert.equal(call(end - 4, base + 64, base + 128, 2, 3, 4, 0), 2, "MK range");
    assert.equal(call(base, end - 4, base + 128, 2, 3, 4, 0), 2, "KN range");
    assert.equal(call(base, base + 64, end - 4, 2, 3, 4, 0), 2, "MN range");
    assert.equal(call(base, base + 64, base + 128, 0x10000, 0x10000, 0, 0), 2, "MK overflow even with empty output");
    assert.equal(call(base, base + 64, base + 128, 0, 0x10000, 0x10000, 0), 2, "KN overflow even with empty output");
    assert.equal(call(base, base + 64, base + 128, 0x10000, 0, 0x10000, 0), 2, "MN overflow with empty inputs");
    assert.equal(call(base, base + 64, base, 2, 3, 4, 0), 3);
    assert.equal(call(base, base + 64, base + 64, 2, 3, 4, 0), 3);
    assert.equal(call(base, base, base + 128, 2, 2, 2, 0), 0, "read-only operands may alias");
    assert.equal(call(base, base + 64, base + 128, 0, 0, 0, 4), 4, "empty work still validates flags");
    assert.equal(call(base, base + 64, base + 128, 0, 0xffffffff, 0, 0), 0, "large unused empty axis");
  });
}
