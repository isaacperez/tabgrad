import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const distributionRoot = fileURLToPath(new URL("../../../dist/", import.meta.url));

// The SIMD byte-marker case is a bounded artifact check, not instruction decoding.

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

  assert.equal(scalar.includes(0xfd), false);
  assert.equal(simd.includes(0xfd), true);
});
