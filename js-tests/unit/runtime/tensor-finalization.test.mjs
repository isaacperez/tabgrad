import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("nested differentiation preserves escaped exposures and all retirement paths on return and throw", async () => {
  const child = fileURLToPath(new URL("../../fixtures/tensor-finalization-child.mjs", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, ["--expose-gc", child], { timeout: 30_000 });
  const rows = JSON.parse(stdout);
  const expected = [];
  for (const forceVariant of ["scalar", "simd128"]) {
    for (const retirement of ["close", "frontend", "session"]) {
      for (const nestedError of [false, true]) expected.push({ forceVariant, retirement, nestedError });
    }
  }
  assert.deepEqual(rows, expected);
});
