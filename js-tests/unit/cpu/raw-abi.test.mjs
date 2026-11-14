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
