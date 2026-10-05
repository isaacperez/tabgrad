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
        "backward",
        "close",
        "constructor",
        "copy_",
        "device",
        "dtype",
        "grad",
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
  assert.match(declarations, /copy_\(source: Tensor\): this/);
  assert.match(declarations, /backward\(gradient\?: Tensor, options\?: BackwardOptions\): void/);
  assert.match(declarations, /get grad\(\): Tensor \| null/);
  assert.match(declarations, /set grad\(value: Tensor \| null\)/);
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
    "finalizeTensorExposure",
    "TensorIdentity",
    "RuntimeSemanticOwnership",
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

test("emitted declarations preserve scope result and typed backward contracts", () => {
  const filename = fileURLToPath(new URL("no-grad-consumer.ts", import.meta.url));
  const source = `
import { RuntimeSession, Tensor, type BackwardOptions } from '../../../dist/index.js';
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
const x = session.tensor([2], { requiresGrad: true });
const y = session.tensor([3]);
const options: BackwardOptions = { inputs: [x], retainGraph: false, createGraph: false };
const returned: void = x.backward(y, options);
x.grad = y;
const slot: Tensor | null = x.grad;
x.grad = null;
// @ts-expect-error Gradient assignment requires a tensor or null.
x.grad = 3;
// @ts-expect-error Direct modes are actual booleans.
x.backward(undefined, { retainGraph: 0 });
// @ts-expect-error Direct inputs are arrays.
x.backward(undefined, { inputs: x });
// @ts-expect-error No public retention-hook option exists.
x.backward(undefined, { retain: false });
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
