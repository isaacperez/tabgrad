import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecutableProgram } from "../../../dist/execution/executable-program.js";

function program(kind, shapes, device = "cpu") {
  const provenance = { operation: kind, source: "test" };
  const values = shapes.map((shape, slot) => ({ slot, storageSlot: slot, dtype: "float32", device,
    layout: "contiguous", shape, source: slot === shapes.length - 1 ? "computed" : "binding", provenance }));
  return new ExecutableProgram(values, [{ kind, inputs: shapes.slice(0, -1).map((_, slot) => slot), output: shapes.length - 1, provenance }], shapes.length - 1);
}

for (const kind of ["add-f32", "mul-f32"]) test(`${kind} reconstruction admits complete broadcast geometry, never equal-size substitutions`, () => {
  const valid = program(kind, [[2, 1], [3], [2, 3]]), clone = structuredClone(valid);
  assert.deepEqual(new ExecutableProgram(clone.values, clone.computations, clone.result).storageUseCounts, [1, 1, 0]);
  for (const shapes of [[[2], [3], [3]], [[2, 1], [3], [3, 2]], [[0, 3], [1, 2], [0, 3]], [[2, 1], [3], [6]]]) {
    assert.throws(() => program(kind, shapes), TypeError);
  }
  for (const slot of [0, 1, 2]) for (const [field, value] of [["device", "other"], ["dtype", "float64"], ["layout", "strided"], ["storageSlot", 99]]) {
    const values = clone.values.map(value => ({ ...value })); values[slot][field] = value;
    assert.throws(() => new ExecutableProgram(values, clone.computations, 2), TypeError);
  }
  for (const inputs of [[], [0], [0, 1, 0], [0, 99]]) assert.throws(() => new ExecutableProgram(clone.values, [{ ...clone.computations[0], inputs }], 2), TypeError);
  const aliases = program(kind, [[2, 3], [2, 3], [2, 3]]), values = structuredClone(aliases.values);
  values[1].source = "alias"; values[1].storageSlot = 0;
  assert.doesNotThrow(() => new ExecutableProgram(values, aliases.computations, 2));
  values[1].shape = [1];
  assert.throws(() => new ExecutableProgram(values, aliases.computations, 2), TypeError);
  assert.doesNotThrow(() => program(kind, [[0, Number.MAX_SAFE_INTEGER], [1], [0, Number.MAX_SAFE_INTEGER]]));
});

test("receiving reconstruction requires keep-dimension shapes and independent output storage", () => {
  for (const shapes of [[[2, 3], [1, 3]], [[1, 2], [1, 2]], [[0, 3], [1, 3]], [[0, Number.MAX_SAFE_INTEGER], [1, 1]], [[], []]]) {
    assert.doesNotThrow(() => program("reduce-f32", shapes));
  }
  for (const shapes of [[[2, 3], [3]], [[2, 3], [1, 6]], [[1, 3], [2, 3]], [[0, 3], [2, 3]]]) {
    assert.throws(() => program("reduce-f32", shapes), TypeError);
  }
  const valid = program("reduce-f32", [[1, 2], [1, 2]]), values = structuredClone(valid.values);
  values[1].storageSlot = 0; values[1].source = "alias";
  assert.throws(() => new ExecutableProgram(values, valid.computations, 1), TypeError);
});

test("broadcast reconstruction captures metadata before validation effects", () => {
  const valid = program("add-f32", [[2, 1], [3], [2, 3]]), values = valid.values.map(value => ({ ...value }));
  let reads = 0;
  Object.defineProperty(values[0], "shape", { enumerable: true, get() { reads++; return reads === 1 ? [2, 1] : [99]; } });
  const result = new ExecutableProgram(values, valid.computations, 2);
  assert.equal(reads, 1);
  assert.deepEqual(result.values[0].shape, [2, 1]);
});
