import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("the public declarations do not expose runtime-to-backend plumbing", async () => {
  const declarations = await readFile(
    new URL("../../dist/runtime.d.ts", import.meta.url),
    "utf8",
  );

  for (const internalName of [
    "BackendDiagnostics",
    "TensorState",
    "add(left",
    "assertOpen",
    "cpu-backend",
    "createRuntimeSessionForTesting",
    "observe(state",
    "releaseHandle",
  ]) {
    assert.doesNotMatch(declarations, new RegExp(internalName.replace("(", "\\(")));
  }
});

test("the package entry point does not export executable or failure internals", async () => {
  const declarations = await readFile(
    new URL("../../dist/index.d.ts", import.meta.url),
    "utf8",
  );

  for (const internalName of [
    "ExecutableProgram",
    "InternalExecutionFailureContext",
    "inspectExecutionFailureContext",
    "retainExecutionFailureContext",
  ]) {
    assert.doesNotMatch(declarations, new RegExp(internalName));
  }
});
