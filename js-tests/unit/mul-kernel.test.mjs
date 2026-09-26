import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { float32FromBits } from "./sum-oracle.mjs";

for (const variant of ["scalar", "simd128"]) {
  test(`raw ${variant} multiplication agrees with native float32 bit fixtures`, async () => {
    const oracle = JSON.parse(await readFile(new URL("../fixtures/python-tensor-oracle.json", import.meta.url), "utf8"));
    const memory = new WebAssembly.Memory({ initial: 32, maximum: 1024 });
    const bytes = await readFile(new URL(`../../dist/wasm/kernels-${variant}.wasm`, import.meta.url));
    const { instance } = await WebAssembly.instantiate(bytes, { env: { memory } });
    const base = instance.exports.tabgrad_arena_base() + 4;
    const values = new Float32Array(memory.buffer);
    for (const fixture of oracle.mulCases) {
      values.set(fixture.leftBits.map(float32FromBits), base / 4);
      values.set(fixture.rightBits.map(float32FromBits), base / 4 + 32);
      assert.equal(instance.exports.tabgrad_mul_f32(base, base + 128, base + 256, fixture.bits.length), 0);
      assert.deepEqual([...values.slice(base / 4 + 64, base / 4 + 64 + fixture.bits.length)],
        fixture.bits.map(float32FromBits), fixture.name);
    }
  });
  test(`raw ${variant} multiplication validates ranges and handles aliases and tails`, async () => {
    const bytes = await readFile(new URL(`../../dist/wasm/kernels-${variant}.wasm`, import.meta.url));
    const memory = new WebAssembly.Memory({ initial: 32, maximum: 1024 });
    const { instance } = await WebAssembly.instantiate(bytes, { env: { memory } });
    const { tabgrad_mul_f32: mul, tabgrad_arena_base: arena } = instance.exports;
    assert.equal(typeof mul, "function");
    assert.equal(instance.exports.tabgrad_capabilities() & 4, 4);
    const left = arena() + 4;
    const right = left + 128;
    const output = right + 128;
    const values = new Float32Array(memory.buffer);
    for (const length of [0, 1, 2, 3, 4, 5, 7, 8, 9, 17]) {
      const expected = [];
      for (let index = 0; index < length; index += 1) {
        values[left / 4 + index] = index - 3;
        values[right / 4 + index] = index + 1;
        expected.push((index - 3) * (index + 1));
      }
      values[output / 4 + length] = 123;
      assert.equal(mul(left, right, output, length), 0);
      assert.deepEqual([...values.slice(output / 4, output / 4 + length)], expected);
      assert.equal(values[output / 4 + length], 123);
      assert.equal(mul(left, left, output, length), 0, "repeated input ranges are legal");
      assert.deepEqual([...values.slice(output / 4, output / 4 + length)],
        Array.from({ length }, (_, i) => (i - 3) ** 2));
    }
    const end = memory.buffer.byteLength;
    assert.equal(mul(end, end, end, 0), 0);
    for (const offsets of [[left + 2, right, output], [left, right + 2, output], [left, right, output + 2]]) {
      assert.equal(mul(...offsets, 1), 1);
    }
    for (const offsets of [[arena() - 4, right, output], [left, end, output], [left, right, end]]) {
      assert.equal(mul(...offsets, 1), 2);
    }
    assert.equal(mul(left, right, output, 0xffff_ffff), 2);
    assert.equal(mul(0xffff_fffc, right, output, 2), 2);
    assert.equal(mul(left, right, left, 1), 3);
    assert.equal(mul(left, right, right + 4, 2), 3);
    assert.equal(mul(left, left + 4, output, 4), 0, "overlapping inputs are legal");
    assert.equal(mul(left, left, left + 4, 1), 0, "adjacent output is legal");
  });
}
