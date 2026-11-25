import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntimeSession } from "../../../dist/index.js";
import { ExecutableProgram } from "../../../dist/execution/executable-program.js";
import { WebAssemblyCpuBackend } from "../../../dist/backends/cpu/cpu-backend.js";
import { CpuArtifactLoader } from "../../../dist/backends/cpu/artifact-loader.js";
import { assertBackendProgram, supportsBackendComputation } from "../../../dist/execution/backend.js";
import { computationSignature } from "../../../dist/execution/operation-contracts.js";
import { fixedTensorTypePolicy, resolveTensorType,
  GRADIENT_STATE_TYPES, DEFAULT_GRADIENT_ASSIGNMENT_TYPES, PERSISTENT_COPY_TYPES } from "../../../dist/execution/operation-types.js";

const provenance = { operation: "type-boundary", source: "test" };

test("tracking eligibility does not reread an already admitted creation dtype", async () => {
  const session = createRuntimeSession();
  let reads = 0;
  try {
    const tensor = session.tensor([1], { requiresGrad: true, get dtype() {
      reads += 1;
      if (reads > 2) throw new Error("Creation dtype was read again");
      return "float32";
    } });
    assert.equal(reads, 2);
    assert.equal(tensor.requiresGrad, true);
    tensor.close();
  } finally { await session.close(); }
});

test("fixed type policies preserve distinct input/result rules and immutable configuration", () => {
  // Private relation labels test the mechanism without registering a public dtype.
  const inputs = ["compact", "wide"];
  const policy = fixedTensorTypePolicy(inputs, "predicate");
  inputs[0] = "changed";
  const values = [{ dtype: "wide" }, { dtype: "compact" }];
  assert.equal(resolveTensorType(policy, values, [1, 0]), "predicate");
  assert.equal(resolveTensorType(policy, values), undefined);
  assert.equal(resolveTensorType(policy, values, [1]), undefined);
  assert.equal(resolveTensorType(policy, values, [1, -1]), undefined);
  assert.equal(resolveTensorType(policy, values, [1, 0.5]), undefined);
  assert.deepEqual(inputs, ["changed", "wide"]);
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.inputs));
});

test("family bindings share actual type rules while coefficient and state domains stay explicit", () => {
  assert.equal(computationSignature("add-f32").types, computationSignature("mul-f32").types);
  assert.equal(computationSignature("add-alpha-f32").types, computationSignature("add-f32").types);
  assert.equal(computationSignature("add-alpha-f32").family.parameters, "coefficient");
  assert.equal(computationSignature("add-f32").family.parameters, "none");
  for (const policy of [GRADIENT_STATE_TYPES, DEFAULT_GRADIENT_ASSIGNMENT_TYPES, PERSISTENT_COPY_TYPES]) {
    assert.equal(resolveTensorType(policy, policy.inputs.map(dtype => ({ dtype }))), "float32");
    assert.equal(resolveTensorType(policy, policy.inputs.map(() => ({ dtype: "float16" }))), undefined);
  }
});

function capturedProgram(kind) {
  const shapes = kind === "sum-f32" ? [[3], []]
    : kind === "expand-f32" ? [[], [3]]
      : kind === "reduce-f32" ? [[2, 3], [1, 3]]
        : [[2, 2], [2, 2], [2, 2]];
  const output = shapes.length - 1;
  return {
    values: shapes.map((shape, slot) => ({ slot, storageSlot: slot, shape,
      dtype: "float32", device: "cpu", layout: "contiguous",
      source: slot === output ? "computed" : "binding", provenance })),
    computations: [{ kind, inputs: shapes.slice(0, -1).map((_, slot) => slot), output, provenance,
      ...(kind === "add-alpha-f32" ? { alphaBits: 0x3f800000 } : {}),
      ...(kind === "matmul-f32" ? { matrixFlags: 0 } : {}) }],
    result: output,
  };
}

for (const kind of ["add-f32", "add-alpha-f32", "mul-f32", "sum-f32", "expand-f32", "matmul-f32", "reduce-f32"]) {
  test(`${kind} reconstruction rejects every invalid input/result type before publication`, () => {
    const original = capturedProgram(kind);
    const valid = new ExecutableProgram(original.values, original.computations, original.result);
    assert.equal(valid.values[valid.result].dtype, "float32");
    for (let slot = 0; slot < original.values.length; slot++) {
      const captured = structuredClone(original);
      captured.values[slot].dtype = "float16";
      assert.throws(() => new ExecutableProgram(captured.values, captured.computations, captured.result), TypeError);
    }
  });
}

test("binding-only reconstruction validates canonical dtype and complete alias metadata", () => {
  const value = { slot: 0, storageSlot: 0, shape: [0], dtype: "float32", device: "cpu",
    layout: "contiguous", source: "binding", provenance };
  for (const dtype of ["bfloat16", "toString", undefined]) {
    assert.throws(() => new ExecutableProgram([{ ...value, dtype }], [], 0), TypeError);
  }
  assert.equal(new ExecutableProgram([{ ...value, dtype: "float16" }], [], 0).values[0].dtype, "float16");
  assert.throws(() => new ExecutableProgram([value, { ...value, slot: 1, source: "alias", dtype: "float16" }], [], 1), TypeError);
  assert.equal(new ExecutableProgram([value], [], 0).values[0].dtype, "float32");
});

test("unknown captured numerical kinds cannot bypass the finite type vocabulary", () => {
  const kinds = ["unregistered-f32", "toString", "__proto__", { toString() { throw new Error("Kind was coerced"); } }];
  for (const kind of kinds) {
    const captured = capturedProgram(kind);
    assert.throws(() => new ExecutableProgram(captured.values, captured.computations, captured.result), {
      name: "TypeError", message: "Unsupported numerical computation.",
    });
  }
});

test("capability admission indexes a frozen advertisement once as catalogue and graph sizes vary independently", () => {
  for (const kindCount of [4, 1024]) {
    for (const nodeCount of [1, 256]) {
      let kindReads = 0;
      const kinds = new Array(kindCount);
      for (let index = 0; index < kindCount; index++) {
        const kind = index === kindCount - 1 ? "add-f32" : `future-${index}`;
        Object.defineProperty(kinds, index, { get() { kindReads++; return kind; } });
      }
      const capabilities = { device: "cpu", computations: Object.freeze(kinds) };
      const captured = capturedProgram("add-f32");
      for (let output = 3; output < nodeCount + 2; output++) {
        captured.values.push({ ...captured.values[2], slot: output, storageSlot: output });
        captured.computations.push({ ...captured.computations[0], inputs: [output - 1, 1], output });
      }
      const program = new ExecutableProgram(captured.values, captured.computations, nodeCount + 1);
      assertBackendProgram(capabilities, program);
      assert.equal(supportsBackendComputation(capabilities, "add-f32"), true);
      assertBackendProgram(capabilities, program);
      assert.equal(kindReads, kindCount);
    }
  }
});

test("mutable capability advertisements are revalidated and cannot admit unregistered kinds", () => {
  const capabilities = { device: "cpu", computations: ["add-f32", "future-kind"] };
  assertBackendProgram(capabilities, capturedProgram("add-f32"));
  for (const kind of ["future-kind", "add-f32"]) {
    capabilities.computations.shift();
    assert.throws(() => assertBackendProgram(capabilities, capturedProgram(kind)), { code: "BACKEND_CAPABILITY_MISMATCH" });
  }
});

test("CPU preparation rejects an unsupported captured kind before artifact loading", async () => {
  const original = CpuArtifactLoader.prototype.load;
  let loads = 0;
  CpuArtifactLoader.prototype.load = function () { loads += 1; throw new Error("Unexpected artifact loading"); };
  const backend = new WebAssemblyCpuBackend(new URL("https://unused.invalid/manifest.json"));
  try {
    await assert.rejects(async () => backend.prepare(capturedProgram("unregistered-f32")), { code: "BACKEND_CAPABILITY_MISMATCH" });
    assert.equal(loads, 0);
    assert.equal(backend.diagnostics().backendLoads, 0);
    assert.equal(backend.diagnostics().hostToWasmCopies, 0);
  } finally { CpuArtifactLoader.prototype.load = original; await backend.close(); }
});

test("CPU type admission cannot mistake absent operands and output for a resolved signature", async () => {
  const original = CpuArtifactLoader.prototype.load;
  let loads = 0;
  CpuArtifactLoader.prototype.load = function () { loads += 1; throw new Error("Unexpected artifact loading"); };
  const backend = new WebAssemblyCpuBackend(new URL("https://unused.invalid/manifest.json"));
  const captured = capturedProgram("add-f32");
  captured.computations[0].inputs = [0, 99];
  captured.computations[0].output = 99;
  try {
    await assert.rejects(async () => backend.prepare(captured), { code: "BACKEND_CAPABILITY_MISMATCH" });
    assert.equal(loads, 0);
  } finally { CpuArtifactLoader.prototype.load = original; await backend.close(); }
});

test("unary reconstruction rejects mixed-device input and result captures", () => {
  for (const kind of ["sum-f32", "expand-f32"]) {
    const captured = capturedProgram(kind);
    captured.values[captured.result].device = "webgpu";
    assert.throws(() => new ExecutableProgram(captured.values, captured.computations, captured.result), TypeError);
  }
});

test("CPU eligibility rejects a GPU program before loading a CPU artifact", async () => {
  const original = CpuArtifactLoader.prototype.load;
  let loads = 0;
  CpuArtifactLoader.prototype.load = function () { loads += 1; throw new Error("Unexpected artifact loading"); };
  const backend = new WebAssemblyCpuBackend(new URL("https://unused.invalid/manifest.json"));
  const captured = capturedProgram("sum-f32");
  for (const value of captured.values) value.device = "webgpu";
  const program = new ExecutableProgram(captured.values, captured.computations, captured.result);
  try {
    await assert.rejects(async () => backend.prepare(program), { code: "BACKEND_CAPABILITY_MISMATCH" });
    assert.equal(loads, 0);
  } finally { CpuArtifactLoader.prototype.load = original; await backend.close(); }
});
