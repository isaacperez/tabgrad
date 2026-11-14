import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { pointwiseGeometry, receivingGeometry } from "../../../dist/execution/broadcast-geometry.js";
import { receivingPacket } from "../../../dist/backends/cpu/broadcast-packet.js";

for (const variant of ["scalar", "simd128"]) {
  test(`raw ${variant} broadcast kernels validate independent spans and incremental geometry`, async () => {
    const memory = new WebAssembly.Memory({ initial: 32, maximum: 1024 });
    const { instance } = await WebAssembly.instantiate(await readFile(new URL(`../../../dist/wasm/kernels-${variant}.wasm`, import.meta.url)), { env: { memory } });
    const api = instance.exports, base = api.tabgrad_arena_base(), packet = base + 256;
    const floats = new Float32Array(memory.buffer), words = new Uint32Array(memory.buffer);
    assert.equal(typeof api.tabgrad_broadcast_add_f32, "function");
    assert.equal(typeof api.tabgrad_broadcast_mul_f32, "function");
    floats.set([2, 3], base / 4); floats.set([4, 5, 6], base / 4 + 16);
    // rank, arity, output count, actual input counts, (dimension, strides...), counters.
    const geometry = [2, 2, 6, 2, 3, 2, 1, 0, 3, 0, 1, 0, 0];
    words.set(geometry, packet / 4);
    for (const [name, expected] of [["add", [6, 7, 8, 7, 8, 9]], ["mul", [8, 10, 12, 12, 15, 18]]]) {
      const operation = api[`tabgrad_broadcast_${name}_f32`];
      assert.equal(operation(base, base + 64, base + 128, packet, geometry.length), 0);
      assert.deepEqual([...floats.slice(base / 4 + 32, base / 4 + 38)], expected);
      assert.equal(operation(base, base + 64, base, packet, geometry.length), 3);
      assert.equal(operation(base, base + 64, base + 128, packet + 2, geometry.length), 1);
      assert.equal(operation(base, base + 64, base + 128, memory.buffer.byteLength - 4, geometry.length), 2);
      assert.equal(operation(base, base + 64, packet, packet, geometry.length), 3);
      for (const [offset, value] of [[0, 0xffff_ffff], [1, 3], [2, 7], [3, 1], [6, 99], [8, 0]]) {
        words.set(geometry, packet / 4); words[packet / 4 + offset] = value;
        assert.notEqual(operation(base, base + 64, base + 128, packet, geometry.length), 0, `${name}/${offset}`);
      }
      words.set(geometry, packet / 4);
    }
  });

  test(`raw ${variant} receiving groups preserve the sum tree and reject malformed packets`, async () => {
    const memory = new WebAssembly.Memory({ initial: 32, maximum: 1024 });
    const { instance } = await WebAssembly.instantiate(await readFile(new URL(`../../../dist/wasm/kernels-${variant}.wasm`, import.meta.url)), { env: { memory } });
    const api = instance.exports, base = api.tabgrad_arena_base(), output = base + 8192, packet = base + 16384;
    const floats = new Float32Array(memory.buffer), words = new Uint32Array(memory.buffer);
    assert.equal(typeof api.tabgrad_receive_f32, "function");
    for (const terms of [1, 3, 4, 5, 127, 128, 129, 257]) {
      const values = Array.from({ length: terms }, (_, i) => i % 4 === 0 ? 2 ** 30 : i % 4 === 2 ? -(2 ** 30) : 1);
      floats.set(values, base / 4);
      floats.set(values, base / 4 + terms);
      // Two receiver groups, each selecting its contiguous subsequence.
      const geometry = [terms * 2, 2, terms, 1, 1, 2, terms, terms, 1];
      words.set(geometry, packet / 4);
      assert.equal(api.tabgrad_receive_f32(base, output, packet, geometry.length), 0);
      assert.equal(api.tabgrad_sum_f32(base, output + 16, terms), 0);
      assert.deepEqual([...new Uint32Array(memory.buffer, output, 2)], Array(2).fill(new Uint32Array(memory.buffer, output + 16, 1)[0]));
      assert.equal(api.tabgrad_receive_f32(base, base, packet, geometry.length), 3);
      words[packet / 4 + 2] = terms + 1;
      assert.notEqual(api.tabgrad_receive_f32(base, output, packet, geometry.length), 0);
    }
    words.set([0, 3, 0, 0, 0], packet / 4);
    floats.fill(-1, output / 4, output / 4 + 3);
    assert.equal(api.tabgrad_receive_f32(memory.buffer.byteLength, output, packet, 5), 0);
    assert.deepEqual([...new Uint32Array(memory.buffer, output, 3)], [0, 0, 0]);
    words.set([0, 0, 0, 0, 0], packet / 4);
    assert.equal(api.tabgrad_receive_f32(memory.buffer.byteLength, packet + 4, packet, 5), 0, "empty output overlaps no packet bytes");
    words.set([0, 3, 0, 0, 0], packet / 4);
    floats.fill(-1, output / 4, output / 4 + 3);
    assert.equal(api.tabgrad_receive_f32(output + 4, output, packet, 5), 0, "an empty input inside output occupies no bytes");
    assert.deepEqual([...new Uint32Array(memory.buffer, output, 3)], [0, 0, 0]);
  });

  test(`raw ${variant} interleaved receiving groups cross the sum split without scanning other groups`, async () => {
    const memory = new WebAssembly.Memory({ initial: 32, maximum: 1024 });
    const { instance } = await WebAssembly.instantiate(await readFile(new URL(`../../../dist/wasm/kernels-${variant}.wasm`, import.meta.url)), { env: { memory } });
    const api = instance.exports, base = api.tabgrad_arena_base(), count = 2 * 3 * 129 * 5;
    const output = base + count * 4, dense = output + 64, denseResult = dense + 258 * 4, packet = denseResult + 16;
    const floats = new Float32Array(memory.buffer), words = new Uint32Array(memory.buffer);
    const geometry = receivingGeometry(pointwiseGeometry([[2, 3, 129, 5], [1, 3, 1, 5]]), 1);
    const parameters = receivingPacket(geometry, memory.buffer.byteLength);
    floats.set(Float32Array.from({ length: count }, (_, i) => i % 4 === 0 ? 2 ** 30 : i % 4 === 2 ? -(2 ** 30) : 1), base / 4);
    words.set(parameters, packet / 4);
    assert.equal(api.tabgrad_receive_f32(base, output, packet, parameters.length), 0);
    for (let channel = 0; channel < 3; channel++) for (let column = 0; column < 5; column++) {
      let position = 0;
      for (let batch = 0; batch < 2; batch++) for (let row = 0; row < 129; row++) {
        floats[dense / 4 + position++] = floats[base / 4 + ((batch * 3 + channel) * 129 + row) * 5 + column];
      }
      assert.equal(position, 258);
      assert.equal(api.tabgrad_sum_f32(dense, denseResult, position), 0);
      assert.equal(words[output / 4 + channel * 5 + column], words[denseResult / 4]);
    }
    // Counts still agree, but these axes no longer partition the source.
    words[packet / 4 + 6] = 1;
    const before = words.slice(output / 4, output / 4 + 15);
    assert.equal(api.tabgrad_receive_f32(base, output, packet, parameters.length), 4);
    assert.deepEqual(words.slice(output / 4, output / 4 + 15), before);
  });
}
