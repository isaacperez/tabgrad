import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { coefficientSentinels } from "../../browser/helpers/float32-coefficient-oracle.mjs";

const bits = (value) => new Uint32Array(new Float32Array([value]).buffer)[0];

for (const variant of ["scalar", "simd128"]) {
  test(`coefficient addition preserves one rounding and validates ranges (${variant})`, async () => {
    const bytes = await readFile(new URL(`../../../dist/wasm/kernels-${variant}.wasm`, import.meta.url));
    const memory = new WebAssembly.Memory({ initial: 32, maximum: 1024 });
    const { instance } = await WebAssembly.instantiate(bytes, { env: { memory } });
    const kernel = instance.exports.tabgrad_add_alpha_f32;
    assert.equal(typeof kernel, "function");
    const base = instance.exports.tabgrad_arena_base() >>> 0;
    const input = new Uint32Array(memory.buffer, base, 8);
    const gradient = new Uint32Array(memory.buffer, base + 32, 8);
    const output = new Uint32Array(memory.buffer, base + 64, 8);
    for (const [p, g, alpha, expected] of coefficientSentinels) {
      input.fill(p); gradient.fill(g);
      for (const length of [1, 4, 5, 6, 7, 8]) {
        output.fill(0xdeadbeef);
        assert.equal(kernel(base, base + 32, base + 64, length, alpha), 0);
        assert.deepEqual(Array.from(output.slice(0, length)), new Array(length).fill(expected));
        assert.deepEqual(Array.from(output.slice(length)), new Array(8 - length).fill(0xdeadbeef));
      }
    }
    input.fill(bits(1)); gradient.fill(0x7f800000);
    assert.equal(kernel(base, base + 32, base + 64, 7, 0), 0);
    assert.ok(new Float32Array(output.buffer, output.byteOffset, 7).every(Number.isNaN));
    assert.equal(kernel(base, base + 32, base + 64, 0, 0), 0);
    assert.equal(kernel(base + 2, base + 32, base + 64, 1, 0), 1);
    assert.equal(kernel(memory.buffer.byteLength - 4, base + 32, base + 64, 2, 0), 2);
    assert.equal(kernel(base, base + 32, base, 1, 0), 3);
  });
}
