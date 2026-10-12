import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecutableProgram } from "../../../dist/execution/executable-program.js";
import { OperationRecord } from "../../../dist/runtime/tensor-value.js";

function coefficientProgram(device, length, kind, alphaBits) {
  const provenance = { operation: "SGD.step", source: "SGD.step" };
  const values = [0, 1, 2].map(slot => ({ slot, storageSlot: slot, dtype: "float32", device,
    layout: "contiguous", shape: [length], source: slot === 2 ? "computed" : "binding", provenance }));
  return new ExecutableProgram(values, [{ kind, inputs: [0, 1], output: 2, provenance,
    ...(alphaBits === undefined ? {} : { alphaBits }) }], 2);
}

test("ordinary and reconstructed programs require captured coefficient words even when empty", () => {
  for (const device of ["cpu", "webgpu"]) for (const length of [0, 1, 65]) {
    for (const alpha of [undefined, NaN, Infinity, -1, 0.5, 0x100000000, "0", null]) {
      assert.throws(() => coefficientProgram(device, length, "add-alpha-f32", alpha), {
        name: "TypeError", message: "Coefficient addition requires captured binary32 bits.",
      }, `${device}/${length}/${String(alpha)}`);
    }
    assert.throws(() => coefficientProgram(device, length, "add-f32", 0), {
      name: "TypeError", message: "This operation has no coefficient.",
    });
  }
});

test("captured coefficient words survive immutable program reconstruction", () => {
  for (const alpha of [0, 1, 0x80000000, 0xbdcccccd, 0x7fc00000, 0xffffffff]) {
    const program = coefficientProgram("webgpu", 0, "add-alpha-f32", alpha);
    const transported = structuredClone(program);
    const reconstructed = new ExecutableProgram(transported.values, transported.computations, transported.result);
    transported.computations[0].alphaBits = 0;
    assert.equal(reconstructed.computations[0].alphaBits, alpha);
    assert.ok(Object.isFrozen(reconstructed.computations[0]));
    assert.deepEqual(reconstructed.inputUseCounts, [1, 1, 0]);
  }
});

test("semantic coefficient validation precedes observable operand iteration", () => {
  let iterations = 0;
  const inputs = { *[Symbol.iterator]() { iterations += 1; } };
  const definition = { name: "SGD.step", loweredKind: "add-alpha-f32", provenanceSource: "SGD.step" };
  for (const alpha of [undefined, -1, 0.5, NaN, 0x100000000]) {
    assert.throws(() => new OperationRecord(definition, inputs, alpha), {
      name: "TypeError", message: "Coefficient addition requires captured binary32 bits.",
    });
    assert.equal(iterations, 0);
  }
  const captured = new OperationRecord(definition, inputs, 0xbdcccccd);
  assert.equal(iterations, 1);
  assert.equal(captured.alphaBits, 0xbdcccccd);
  assert.ok(Object.isFrozen(captured));
  assert.throws(() => new OperationRecord({ ...definition, loweredKind: "add-f32" }, inputs, 1), {
    name: "TypeError", message: "This operation has no coefficient.",
  });
  assert.equal(iterations, 1);
});

test("program validation and publication use the same captured coefficient", () => {
  const original = coefficientProgram("webgpu", 1, "add-alpha-f32", 0x3f800000);
  let reads = 0;
  const computation = { ...original.computations[0], get alphaBits() {
    reads += 1;
    return reads === 1 ? 0x3f800000 : -1;
  } };
  const program = new ExecutableProgram(original.values, [computation], original.result);
  assert.equal(program.computations[0].alphaBits, 0x3f800000);
  assert.equal(reads, 1);
});
