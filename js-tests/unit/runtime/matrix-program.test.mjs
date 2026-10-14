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
    [[0, 3], [4, 2], [0, 2]], [[-1, 0], [0, 1], [-1, 1]], [[2, 3], [3, 4], [8]],
    [[Number.MAX_SAFE_INTEGER, 0], [0, 2], [Number.MAX_SAFE_INTEGER, 2]]]) {
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

test("matrix value capture reads each source metadata property once", () => {
  for (const field of ["shape", "device", "storageSlot"]) {
    const original = matrixProgram(), values = original.values.map(value => ({ ...value }));
    const slot = field === "device" ? 2 : 0;
    let reads = 0;
    Object.defineProperty(values[slot], field, { enumerable: true, get() {
      reads++;
      if (field === "shape") return reads === 1 ? [2, 3] : [3, 2];
      if (field === "device") return reads === 1 ? "webgpu" : "cpu";
      return reads === 1 ? 0 : 99;
    } });
    const result = new ExecutableProgram(values, original.computations, 2);
    assert.equal(reads, 1);
    assert.equal(result.domain, "webgpu");
  }
});

test("matrix operands and output preserve dtype, layout, slots and distinct storage", () => {
  for (const shapes of [[[2, 3], [3, 4], [2, 4]], [[0, 3], [3, 4], [0, 4]]]) {
    const original = matrixProgram(0, shapes);
    for (const slot of [0, 1, 2]) for (const [field, value] of [["dtype", "float64"], ["layout", "strided"], ["device", "other"], ["slot", 99], ["storageSlot", 99]]) {
      const values = original.values.map(value => ({ ...value })); values[slot][field] = value;
      assert.throws(() => new ExecutableProgram(values, original.computations, 2), TypeError, `${slot}/${field}`);
    }
    for (const inputs of [["0", 1], [0.5, 1], [-1, 1]]) {
      assert.throws(() => new ExecutableProgram(original.values, [{ ...original.computations[0], inputs }], 2), TypeError);
    }
    const values = original.values.map(value => ({ ...value }));
    values[2].source = "alias"; values[2].storageSlot = 0;
    assert.throws(() => new ExecutableProgram(values, original.computations, 2), TypeError);
  }
  const square = matrixProgram(0, [[2, 2], [2, 2], [2, 2]]);
  assert.throws(() => new ExecutableProgram(square.values, [{ ...square.computations[0], output: 0 }], 0), TypeError);
  const alias = square.values.map(value => ({ ...value }));
  alias[1].source = "alias"; alias[1].storageSlot = 0;
  assert.doesNotThrow(() => new ExecutableProgram(alias, square.computations, 2), "readable whole-storage input aliases stay valid");
  alias[0].shape = [1];
  assert.throws(() => new ExecutableProgram(alias, square.computations, 2), TypeError, "an alias cannot invent more readable storage");
  const parent = matrixProgram(), values = parent.values.map(value => ({ ...value }));
  values[0].source = "alias"; values[0].storageSlot = 3;
  values.push({ ...values[1], slot: 3, storageSlot: 3, shape: [6] });
  assert.doesNotThrow(() => new ExecutableProgram(values, parent.computations, 2));
  values[3].source = "unknown";
  assert.throws(() => new ExecutableProgram(values, parent.computations, 2), TypeError);
  values[3].source = "binding";
  values[3].shape = [1];
  assert.throws(() => new ExecutableProgram(values, parent.computations, 2), TypeError,
    "logical matrix shape must cover exactly its canonical storage");
});
