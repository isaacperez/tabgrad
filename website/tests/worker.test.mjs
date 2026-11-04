import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

test("worker diagnostics preserve the message when a browser stack omits it", async () => {
  const source = await readFile(new URL("../src/playground/executor.worker.js", import.meta.url), "utf8");
  const diagnostic = runInNewContext(source + "\ndescribe(input)", {
    addEventListener() {},
    input: { name: "TypeError", message: "the actionable error", stack: "calculate@worker.js:1:1" },
  });
  assert.match(diagnostic, /TypeError: the actionable error/);
  assert.match(diagnostic, /calculate@worker\.js:1:1/);
});
