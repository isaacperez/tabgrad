import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import * as tabgrad from "../../dist/index.js";

const { RuntimeSession, Tensor } = tabgrad;

test("the JavaScript package entry point exposes only the supported runtime surface", () => {
  assert.deepEqual(
    {
      exports: Object.keys(tabgrad).sort(),
      runtimeSessionConstructor: Object.getOwnPropertyNames(RuntimeSession).sort(),
      runtimeSessionPrototype: Object.getOwnPropertyNames(
        RuntimeSession.prototype,
      ).sort(),
      tensorConstructor: Object.getOwnPropertyNames(Tensor).sort(),
      tensorPrototype: Object.getOwnPropertyNames(Tensor.prototype).sort(),
    },
    {
      exports: ["RuntimeSession", "TabgradError", "Tensor", "createRuntimeSession"],
      runtimeSessionConstructor: ["length", "name", "prototype"],
      runtimeSessionPrototype: ["close", "constructor", "diagnostics", "tensor"],
      tensorConstructor: ["length", "name", "prototype"],
      tensorPrototype: [
        "add",
        "close",
        "constructor",
        "device",
        "dtype",
        "shape",
        "toArray",
      ],
    },
  );
});

test("JavaScript cannot construct a tensor handle outside a runtime session", () => {
  assert.throws(
    () => Reflect.construct(Tensor, []),
    (error) => error instanceof tabgrad.TabgradError
      && error.code === "INVALID_TENSOR",
  );
});

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
    "getTestResidentProgramReferenceCount",
  ]) {
    assert.doesNotMatch(declarations, new RegExp(internalName));
  }
});
