import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import * as tabgrad from "../../../dist/index.js";

const { RuntimeSession, Tensor } = tabgrad;

test("the static Python entry selects only the supported runtime exports", async () => {
  const python = await import("../../../dist/python.js");
  assert.deepEqual(Object.keys(python).sort(), [
    "PythonWorkerError", "attachPython", "connectPythonWorker",
    "createWebGpuWorker", "servePythonWorker",
  ]);
});

test("Python binding declarations typecheck without stripped internal or Node-only types", () => {
  const program = ts.createProgram({
    rootNames: [fileURLToPath(new URL("../../../dist/python.d.ts", import.meta.url))],
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
      exports: ["RuntimeSession", "TabgradError", "Tensor", "createRuntimeSession", "createWebGpuRuntimeSession"],
      runtimeSessionConstructor: ["length", "name", "prototype"],
      runtimeSessionPrototype: ["close", "constructor", "diagnostics", "grad", "noGrad", "tensor"],
      tensorConstructor: ["length", "name", "prototype"],
      tensorPrototype: [
        "add",
        "close",
        "constructor",
        "device",
        "dtype",
        "mul",
        "requiresGrad",
        "shape",
        "sum",
        "toArray",
        "view",
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
    new URL("../../../dist/runtime/runtime.d.ts", import.meta.url),
    "utf8",
  );
  assert.match(declarations, /get shape\(\): readonly number\[\]/);
  assert.match(declarations, /view\(shape: readonly number\[\]\): Tensor/);
  assert.match(declarations, /sum\(\): Tensor/);
  assert.match(declarations, /mul\(right: Tensor\): Tensor/);
  assert.match(declarations, /get requiresGrad\(\): boolean/);
  assert.match(declarations, /grad\(output: Tensor, inputs: readonly Tensor\[\], gradient\?: Tensor\): Tensor\[\]/);

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
    "enterNoGradScope",
    "getRecordingMode",
    "restoreRecordingMode",
  ]) {
    assert.doesNotMatch(declarations, new RegExp(internalName.replace("(", "\\(")));
  }
});

test("the package entry point does not export executable or failure internals", async () => {
  const declarations = await readFile(
    new URL("../../../dist/index.d.ts", import.meta.url),
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

test("noGrad emitted declarations preserve synchronous and Promise result types", () => {
  const filename = fileURLToPath(new URL("no-grad-consumer.ts", import.meta.url));
  const source = `
import { RuntimeSession } from '../../../dist/index.js';
const session = new RuntimeSession();
const sync: number = session.noGrad(() => 17);
const asynchronous: Promise<number> = session.noGrad(async () => 23);
const nested: Promise<string> = session.noGrad(() => session.noGrad(async () => 'ok'));
const empty: void = session.noGrad(() => {});
// @ts-expect-error A callback is required.
session.noGrad();
// @ts-expect-error The callback must be callable.
session.noGrad(17);
// @ts-expect-error A Promise callback does not synchronously return its value.
const incorrect: number = session.noGrad(async () => 1);
`;
  const options = { strict: true, noEmit: true, skipLibCheck: false, types: [],
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2022.d.ts", "lib.dom.d.ts"] };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, ...rest) => path === filename
    ? ts.createSourceFile(path, source, languageVersion) : original(path, languageVersion, ...rest);
  const program = ts.createProgram({ rootNames: [filename], options, host });
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")), []);
});
