import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { pointwiseGeometry } from "../../../dist/execution/broadcast-geometry.js";
import { pointwisePacket } from "../../../dist/backends/cpu/broadcast-packet.js";

for (const variant of ["scalar", "simd128"]) {
  test(`${variant} half raw spans are two-byte aligned, bounded and disjoint`, async () => {
    const memory = new WebAssembly.Memory({ initial: 32, maximum: 4096 });
    const { instance } = await WebAssembly.instantiate(await readFile(new URL(`../../../dist/wasm/kernels-${variant}.wasm`, import.meta.url)), { env: { memory } });
    const api = instance.exports;
    assert.equal(typeof api.tabgrad_add_f16, "function");
    assert.equal(typeof api.tabgrad_mul_f16, "function");
    const base = api.tabgrad_arena_base(), left = base + 2, right = base + 32, output = base + 64;
    const words = new Uint16Array(memory.buffer);
    words.set([0x3c00, 0xc000, 0x0001], left / 2);
    words.set([0x4000, 0x4200, 0x3800], right / 2);
    assert.equal(api.tabgrad_add_f16(left, right, output, 3), 0);
    assert.deepEqual([...words.subarray(output / 2, output / 2 + 3)], [0x4200, 0x3c00, 0x3800]);
    assert.equal(api.tabgrad_mul_f16(left, right, output, 3), 0);
    assert.deepEqual([...words.subarray(output / 2, output / 2 + 3)], [0x4000, 0xc600, 0]);
    for (const kernel of [api.tabgrad_add_f16, api.tabgrad_mul_f16]) {
      assert.equal(kernel(left + 1, right, output, 3), 1);
      assert.equal(kernel(left, right, output + 1, 3), 1);
      assert.equal(kernel(left, right, left + 2, 3), 3);
      assert.equal(kernel(left, right, memory.buffer.byteLength - 2, 2), 2);
      assert.equal(kernel(left, right, output, 0xffffffff), 2);
      assert.equal(kernel(memory.buffer.byteLength, memory.buffer.byteLength, memory.buffer.byteLength, 0), 0);
    }
  });
  test(`${variant} half broadcasts reuse checked geometry with two-byte payload ranges`, async () => {
    const memory = new WebAssembly.Memory({ initial: 32, maximum: 4096 });
    const { instance } = await WebAssembly.instantiate(await readFile(new URL(`../../../dist/wasm/kernels-${variant}.wasm`, import.meta.url)), { env: { memory } });
    const api = instance.exports;
    assert.equal(typeof api.tabgrad_broadcast_add_f16, "function");
    const base = api.tabgrad_arena_base(), right = base + 32, output = base + 64, packet = base + 128;
    const words = new Uint16Array(memory.buffer);
    words.set([0x3c00, 0x4000, 0x4200, 0x4400, 0x4500, 0x4600], base / 2);
    words.set([0x3c00, 0x4000, 0x4200], right / 2);
    const parameters = pointwisePacket(pointwiseGeometry([[2, 3], [3]]), memory.buffer.byteLength);
    new Uint32Array(memory.buffer, packet, parameters.length).set(parameters);
    assert.equal(api.tabgrad_broadcast_add_f16(base, right, output, packet, parameters.length), 0);
    assert.deepEqual([...words.subarray(output / 2, output / 2 + 6)], [0x4000, 0x4400, 0x4600, 0x4500, 0x4700, 0x4880]);
    assert.equal(api.tabgrad_broadcast_add_f16(base, right, output, packet + 2, parameters.length), 1);
    new Uint32Array(memory.buffer, packet, parameters.length)[3] = 5;
    const before = words.slice(output / 2, output / 2 + 6);
    assert.equal(api.tabgrad_broadcast_add_f16(base, right, output, packet, parameters.length), 4);
    assert.deepEqual(words.slice(output / 2, output / 2 + 6), before);
  });
}
