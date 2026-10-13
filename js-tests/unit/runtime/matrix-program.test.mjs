import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecutableProgram } from "../../../dist/execution/executable-program.js";
import { OperationRecord } from "../../../dist/runtime/tensor-value.js";

function matrixProgram(flags = 0, shapes = [[2, 3], [3, 4], [2, 4]], inputs = [0, 1]) {
  const provenance = { operation: "matmul", source: "Tensor.matmul" };
  const values = shapes.map((shape, slot) => ({ slot, storageSlot: slot, dtype: "float32",
    device: "webgpu", layout: "contiguous", shape, source: slot === 2 ? "computed" : "binding", provenance }));
  return new ExecutableProgram(values, [{ kind: "matmul-f32", matrixFlags: flags, inputs, output: 2, provenance }], 2);
}

test("matrix orientation is required, captured once and validated even for empty work", () => {
  for (const shapes of [[[2, 3], [3, 4], [2, 4]], [[0, 3], [3, 4], [0, 4]]]) {
    for (const flags of [undefined, null, NaN, Infinity, -1, 0.5, 4, "0"]) {
      // Explicit undefined must not pick the helper's ordinary default.
      const original = matrixProgram(0, shapes);
      const computation = { ...original.computations[0], matrixFlags: flags };
      assert.throws(() => new ExecutableProgram(original.values, [computation], 2), TypeError);
    }
  }
  const original = matrixProgram();
  let reads = 0;
  const computation = { ...original.computations[0], get matrixFlags() { reads++; return reads === 1 ? 0 : 4; } };
  const captured = new ExecutableProgram(original.values, [computation], 2);
  assert.equal(reads, 1);
  assert.equal(captured.computations[0].matrixFlags, 0);
  assert.ok(Object.isFrozen(captured.computations[0]));
  const transported = structuredClone(captured);
  const reconstructed = new ExecutableProgram(transported.values, transported.computations, 2);
  transported.computations[0].matrixFlags = 3;
  assert.equal(reconstructed.computations[0].matrixFlags, 0);
});

test("matrix geometry validates both logical orientations, arity and output independently", () => {
  for (const flags of [0, 1, 2, 3]) {
    const shapes = [flags & 1 ? [3, 2] : [2, 3], flags & 2 ? [4, 3] : [3, 4], [2, 4]];
    assert.deepEqual(matrixProgram(flags, shapes).inputUseCounts, [1, 1, 0]);
    assert.throws(() => matrixProgram(flags, [shapes[0], shapes[1], [4, 2]]), TypeError);
  }
  for (const shapes of [[[2], [2, 1], [1, 1]], [[2, 3], [2, 4], [2, 4]],
    [[0, 3], [4, 2], [0, 2]], [[-1, 0], [0, 1], [-1, 1]], [[2, 3], [3, 4], [8]]]) {
    assert.throws(() => matrixProgram(0, shapes), TypeError);
  }
  for (const inputs of [[], [0], [0, 1, 0], [0, 99]]) assert.throws(() => matrixProgram(0, undefined, inputs), TypeError);
  assert.doesNotThrow(() => matrixProgram(0, [[0, Number.MAX_SAFE_INTEGER], [Number.MAX_SAFE_INTEGER, 0], [0, 0]]));
  const ordinary = matrixProgram();
  assert.throws(() => new ExecutableProgram(ordinary.values,
    [{ ...ordinary.computations[0], kind: "add-f32", matrixFlags: 0 }], 2), TypeError);
});

test("semantic matrix flags are checked before observable operand iteration", () => {
  let iterations = 0;
  const inputs = { *[Symbol.iterator]() { iterations++; } };
  const definition = { name: "matmul", loweredKind: "matmul-f32", provenanceSource: "Tensor.matmul" };
  for (const flags of [undefined, -1, 4, NaN]) {
    assert.throws(() => new OperationRecord(definition, inputs, undefined, flags), TypeError);
    assert.equal(iterations, 0);
  }
  const record = new OperationRecord(definition, inputs, undefined, 2);
  assert.equal(iterations, 1);
  assert.equal(record.matrixFlags, 2);
});
