import assert from "node:assert/strict";
import { test } from "node:test";
import { broadcastGeometry, pointwiseGeometry, receivingGeometry } from "../../../dist/execution/broadcast-geometry.js";

function project(index, dimensions, strides) {
  let offset = 0;
  for (let axis = dimensions.length - 1; axis >= 0; axis--) {
    offset += (index % dimensions[axis]) * strides[axis];
    index = Math.floor(index / dimensions[axis]);
  }
  return offset;
}

test("pointwise geometry admits scalar, singleton, unequal-rank and empty domains", () => {
  for (const [shapes, output] of [
    [[[], []], []], [[[2, 1], [3]], [2, 3]], [[[1, 3, 1], [2, 1, 4]], [2, 3, 4]],
    [[[0, 3], [1, 3]], [0, 3]], [[[0, Number.MAX_SAFE_INTEGER], [1, 1]], [0, Number.MAX_SAFE_INTEGER]],
  ]) {
    const plan = pointwiseGeometry(shapes);
    assert.deepEqual(plan.shape, output);
    assert.ok(Object.isFrozen(plan));
    assert.ok(Object.isFrozen(plan.operands[0].shape));
  }
  for (const shapes of [[[0, 3], [1, 2]], [[2], [3]], [[-1], [1]], [[NaN], [1]], [[2 ** 40, 1], [1, 2 ** 40]]]) {
    assert.throws(() => pointwiseGeometry(shapes), TypeError);
  }
  const shapes = [[2, 1], [1, 3]], plan = pointwiseGeometry(shapes);
  shapes[0][0] = 99;
  assert.deepEqual(plan.operands[0].shape, [2, 1]);
});

test("coalesced projections visit the right operands without an expanded index table", () => {
  for (const shapes of [[[2, 1, 3], [1, 4, 1]], [[1, 1, 4], [3, 1, 4]], [[2, 3], []], [[1], [2, 3]]]) {
    const plan = pointwiseGeometry(shapes);
    for (let operand = 0; operand < shapes.length; operand++) {
      for (let index = 0; index < plan.elements; index++) {
        assert.equal(project(index, plan.execution.dimensions, plan.execution.strides[operand]),
          project(index, plan.shape, plan.operands[operand].strides));
      }
    }
    assert.ok(plan.execution.dimensions.length <= plan.shape.length);
    assert.equal(plan.execution.strides.length, shapes.length);
  }
  const dense = pointwiseGeometry([[2, 3, 4], [2, 3, 4]]);
  assert.deepEqual(dense.execution.dimensions, [24]);
  assert.deepEqual(dense.execution.strides, [[1], [1]]);
});

test("receiving groups partition source positions in increasing row-major order", () => {
  const plan = pointwiseGeometry([[2, 3, 4], [1, 3, 1]]), receive = receivingGeometry(plan, 1);
  assert.deepEqual(receive.shape, [1, 3, 1]);
  assert.equal(receive.groups, 3);
  assert.equal(receive.terms, 8);
  const all = [];
  for (let group = 0; group < receive.groups; group++) {
    const base = project(group, receive.groupDimensions, receive.groupStrides);
    const indices = Array.from({ length: receive.terms }, (_, term) => base + project(term, receive.termDimensions, receive.termStrides));
    assert.deepEqual(indices, indices.toSorted((a, b) => a - b));
    all.push(...indices);
    if (group === 1) assert.deepEqual(indices, [4, 5, 6, 7, 16, 17, 18, 19]);
  }
  assert.deepEqual(all.toSorted((a, b) => a - b), Array.from({ length: 24 }, (_, index) => index));
  assert.equal(receivingGeometry(pointwiseGeometry([[1, 2], [2]]), 1).exact, false, "a removed leading singleton is a real reduction");
  assert.equal(receivingGeometry(pointwiseGeometry([[2], [2]]), 1).exact, true);
  const empty = receivingGeometry(pointwiseGeometry([[0, 3], [1, 3]]), 1);
  assert.equal(empty.groups, 3);
  assert.equal(empty.terms, 0);
  const contiguous = receivingGeometry(pointwiseGeometry([[2, 3, 4], []]), 1);
  assert.deepEqual(contiguous.termDimensions, [24], "contiguous receiving axes do not require repeated radix decoding");
  assert.deepEqual(contiguous.termStrides, [1]);
});

test("a family selects domains while the common engine supports different arity and channel alignment", () => {
  // A third pointwise operation can supply three shapes without changing the engine.
  const ternary = pointwiseGeometry([[2, 1], [3], []]);
  assert.deepEqual(ternary.shape, [2, 3]);
  assert.equal(ternary.operands.length, 3);
  // The family owns axis selection; the engine owns compatibility and inverse groups.
  const channel = broadcastGeometry(3, [{ shape: [2, 3, 4], axes: [0, 1, 2] }, { shape: [3], axes: [1] }]);
  const receiver = receivingGeometry(channel, 1);
  assert.deepEqual(receiver.originalShape, [3]);
  assert.deepEqual(receiver.shape, [1, 3, 1]);
  assert.equal(receiver.groups, 3);
  assert.equal(receiver.terms, 8);
  assert.deepEqual(channel.operands[1].strides, [0, 1, 0]);
  for (const axes of [[2, 1], [0, 0], [-1, 1], [0, 3]]) {
    assert.throws(() => broadcastGeometry(3, [{ shape: [2, 3], axes }]), TypeError);
  }
});
