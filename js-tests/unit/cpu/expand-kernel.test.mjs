import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

for (const variant of ["scalar", "simd128"]) {
  test(`scalar expansion ${variant} validates ranges and fills tails and empty outputs`, async () => {
    const bytes = await readFile(new URL(`../../../dist/wasm/kernels-${variant}.wasm`, import.meta.url));
    const memory = new WebAssembly.Memory({ initial: 32, maximum: 1024 });
    const { instance } = await WebAssembly.instantiate(bytes, { env: { memory } });
    const { tabgrad_expand_f32: expand, tabgrad_arena_base: arena } = instance.exports;
    assert.equal(typeof expand, "function");
    assert.equal(instance.exports.tabgrad_capabilities() & 8, 8);
    const base = arena();
    const data = new Float32Array(memory.buffer);
    for (const length of [0, 1, 3, 4, 5, 17]) {
      data[base / 4] = -2.5;
      assert.equal(expand(base, base + 32, length), 0);
      assert.deepEqual([...data.slice(base / 4 + 8, base / 4 + 8 + length)], Array(length).fill(-2.5));
    }
    assert.equal(expand(base + 1, base + 32, 1), 1);
    assert.equal(expand(base, base + 33, 1), 1);
    assert.equal(expand(base - 4, base + 32, 1), 2);
    assert.equal(expand(memory.buffer.byteLength, base + 32, 1), 2);
    assert.equal(expand(base, memory.buffer.byteLength, 1), 2);
    assert.equal(expand(base, base + 32, 0xffffffff), 2);
    assert.equal(expand(base, base, 1), 3);
    assert.equal(expand(base + 4, base, 2), 3);
    assert.equal(expand(base, memory.buffer.byteLength, 0), 0);
  });
}
