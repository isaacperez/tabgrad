import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { assertSumFixture, float32FromBits } from "./sum-oracle.mjs";

for (const variant of ["scalar", "simd128"]) {
  test(`raw ${variant} sum satisfies the recorded numerical comparison`, async () => {
    const oracle = JSON.parse(await readFile(new URL("../fixtures/python-tensor-oracle.json", import.meta.url), "utf8"));
    const memory = new WebAssembly.Memory({ initial: 32, maximum: 1024 });
    const bytes = await readFile(new URL(`../../dist/wasm/kernels-${variant}.wasm`, import.meta.url));
    const { instance } = await WebAssembly.instantiate(bytes, { env: { memory } });
    const base = instance.exports.tabgrad_arena_base();
    const values = new Float32Array(memory.buffer);
    for (const fixture of oracle.sumCases) {
      values.set(fixture.inputBits.map(float32FromBits), base / 4);
      const output = base + fixture.inputBits.length * 4;
      assert.equal(instance.exports.tabgrad_sum_f32(base, output, fixture.inputBits.length), 0, fixture.name);
      assertSumFixture(values[output / 4], fixture);
    }
  });
  test(`raw ${variant} total sum handles scalar output, empty input and tails`, async () => {
    const bytes = await readFile(new URL(`../../dist/wasm/kernels-${variant}.wasm`, import.meta.url));
    const memory = new WebAssembly.Memory({ initial: 32, maximum: 1024 });
    const { instance } = await WebAssembly.instantiate(bytes, { env: { memory } });
    const { tabgrad_sum_f32: sum, tabgrad_arena_base: arena } = instance.exports;
    assert.equal(typeof sum, "function");
    assert.equal(instance.exports.tabgrad_capabilities() & 2, 2);
    const input = arena();
    const output = input + 8192;
    const values = new Float32Array(memory.buffer);
    for (const length of [0, 1, 2, 3, 4, 5, 15, 16, 17, 255, 256, 257, 1025]) {
      for (let index = 0; index < length; index += 1) values[input / 4 + index] = index % 7 - 3;
      const expected = Array.from({ length }, (_, index) => index % 7 - 3).reduce((a, b) => a + b, 0);
      values[output / 4] = 123;
      values[output / 4 + 1] = 456;
      assert.equal(sum(input, output, length), 0);
      assert.equal(values[output / 4], expected);
      assert.equal(values[output / 4 + 1], 456, "only one output element is written");
    }
    assert.equal(sum(memory.buffer.byteLength, output, 0), 0, "empty input need not be readable");
    assert.equal(values[output / 4], 0);
    assert.equal(sum(input + 2, output, 1), 1);
    assert.equal(sum(input, output + 2, 1), 1);
    assert.equal(sum(input - 4, output, 1), 2);
    assert.equal(sum(memory.buffer.byteLength, output, 1), 2);
    assert.equal(sum(input, memory.buffer.byteLength, 0), 2, "empty reduction still writes a scalar");
    assert.equal(sum(input, output, 0xffff_ffff), 2);
    assert.equal(sum(input, input, 1), 3);
    assert.equal(sum(input, input + 4, 2), 3);
    assert.equal(sum(input + 4, input, 1), 0, "adjacent ranges are disjoint");
    assert.equal(sum(input, input, 0), 0, "an empty range never overlaps");
  });
}
