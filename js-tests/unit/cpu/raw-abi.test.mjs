import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasSimdInstructions } from "./helpers/wasm-instructions.mjs";

const distributionRoot = fileURLToPath(new URL("../../../dist/", import.meta.url));

test("the raw ABI rejects invalid ranges and output aliasing", async () => {
  const bytes = await readFile(join(distributionRoot, "wasm/kernels-scalar.wasm"));
  const memory = new WebAssembly.Memory({ initial: 32, maximum: 1024 });
  const { instance } = await WebAssembly.instantiate(bytes, { env: { memory } });
  const arenaBase = instance.exports.tabgrad_arena_base() >>> 0;

  assert.equal(instance.exports.tabgrad_add_f32(arenaBase + 2, arenaBase + 16, arenaBase + 32, 1), 1);
  assert.equal(
    instance.exports.tabgrad_add_f32(
      memory.buffer.byteLength - 4,
      arenaBase + 16,
      arenaBase + 32,
      2,
    ),
    2,
  );
  assert.equal(instance.exports.tabgrad_add_f32(arenaBase, arenaBase + 16, arenaBase, 1), 3);
});

test("the build keeps SIMD instructions out of the scalar module", async () => {
  const scalar = await readFile(join(distributionRoot, "wasm/kernels-scalar.wasm"));
  const simd = await readFile(join(distributionRoot, "wasm/kernels-simd128.wasm"));

  assert.equal(hasSimdInstructions(scalar), false);
  assert.equal(hasSimdInstructions(simd), true);
});

test("raw integer argmax checks the full mixed-width extent before writing any index", async () => {
  const bytes = await readFile(join(distributionRoot, "wasm/kernels-scalar.wasm"));
  const memory = new WebAssembly.Memory({ initial: 32, maximum: 1024 });
  const { instance } = await WebAssembly.instantiate(bytes, { env: { memory } });
  const api = instance.exports, input = api.tabgrad_arena_base(), output = input + 64;
  const inputValues = new BigInt64Array(memory.buffer, input, 4);
  const outputValues = new BigInt64Array(memory.buffer, output, 2);
  inputValues.set([9007199254740992n, 9007199254740993n, -4294967296n, -4294967297n]);
  outputValues.fill(-1n);
  for (const [args, reason] of [
    [[input, output + 4, 2, 2, 1], 1],
    [[memory.buffer.byteLength - 8, output, 2, 2, 1], 2],
    [[input, input + 8, 2, 2, 1], 3],
    [[input, output, 2, 2, 3], 4],
  ]) assert.equal(api.tabgrad_argmax_i64(...args), reason);
  assert.deepEqual(outputValues, BigInt64Array.of(-1n, -1n));
  assert.equal(api.tabgrad_argmax_i64(input, output, 2, 2, 1), 0);
  assert.deepEqual(outputValues, BigInt64Array.of(1n, 0n));
});

test("SIMD inspection distinguishes code prefixes from constants and custom-section bytes", () => {
  const header = [0, 97, 115, 109, 1, 0, 0, 0];
  const declaration = [1, 4, 1, 96, 0, 0, 3, 2, 1, 0];
  // i32.const2147483645 has LEB bytes fd ff ff ff07, then drop/end.
  const scalar = new Uint8Array([...header, ...declaration, 10, 11, 1, 9, 0, 65, 253, 255, 255, 255, 7, 26, 11,
    0, 3, 1, 120, 253]);
  const simd = new Uint8Array([...header, ...declaration, 10, 23, 1, 21, 0, 253, 12, ...Array(16).fill(0), 26, 11]);
  assert.equal(scalar.includes(0xfd), true);
  assert.equal(hasSimdInstructions(scalar), false);
  assert.equal(hasSimdInstructions(simd), true);
  assert.throws(() => hasSimdInstructions(scalar.slice(0, -1)), WebAssembly.CompileError);
});

for (const variant of ["scalar", "simd128"]) {
  test(`the matched CPU import permits smaller session limits and rejects a larger maximum (${variant})`, async () => {
    const manifest = JSON.parse(await readFile(join(distributionRoot, "manifest.json"), "utf8"));
    assert.equal(manifest.moduleVersion, 15);
    assert.deepEqual(manifest.memory, { initialPages: 32, maximumPages: 4096, alignment: 16 });
    const module = await WebAssembly.compile(await readFile(join(distributionRoot, `wasm/kernels-${variant}.wasm`)));
    for (const maximum of [32, 2048, 4096]) {
      const memory = new WebAssembly.Memory({ initial: 32, maximum });
      const instance = await WebAssembly.instantiate(module, { env: { memory } });
      assert.equal(instance.exports.tabgrad_abi_version(), 1);
      assert.equal(memory.buffer.byteLength, 2 * 1024 * 1024);
    }
    await assert.rejects(WebAssembly.instantiate(module, {
      env: { memory: new WebAssembly.Memory({ initial: 32, maximum: 4097 }) },
    }), WebAssembly.LinkError);
    await assert.rejects(WebAssembly.instantiate(module, {
      env: { memory: new WebAssembly.Memory({ initial: 31, maximum: 4096 }) },
    }), WebAssembly.LinkError);
  });
}
