import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import * as tabgrad from "../../dist/index.js";

const { RuntimeSession, Tensor } = tabgrad;

test("Python binding declarations typecheck without stripped internal or Node-only types", () => {
  const program = ts.createProgram({
    rootNames: [fileURLToPath(new URL("../../dist/python.d.ts", import.meta.url))],
    options: {
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      types: [],
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    },
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")), []);
});

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
    "inspectTensorAncestryForTesting",
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
    "getTestTensorAncestry",
  ]) {
    assert.doesNotMatch(declarations, new RegExp(internalName));
  }
});
