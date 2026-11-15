import assert from "node:assert/strict";
import { test } from "node:test";
import { operationShapeContract, assertOperationArity, POINTWISE_SHAPE_POLICY } from "../../../dist/execution/operation-shapes.js";

for (const kind of ["add-f32", "mul-f32"]) {
  test(`${kind} binds its operand count without narrowing the pointwise shape law`, () => {
    const contract = operationShapeContract(kind);
    assert.doesNotThrow(() => assertOperationArity(contract, 2));
    assert.deepEqual(contract.policy.plan([[2, 1], [3]]).shape, [2, 3]);
    for (const count of [0, 1, 3]) assert.throws(() => assertOperationArity(contract, count), TypeError);
    assert.throws(() => contract.policy.plan([[2], [3]]), TypeError);
    assert.ok(Object.isFrozen(contract));
  });
}

test("the same shape law supports a separately bound unary or ternary contract", () => {
  const unary = Object.freeze({ arity: 1, policy: POINTWISE_SHAPE_POLICY });
  const ternary = Object.freeze({ arity: 3, policy: POINTWISE_SHAPE_POLICY });
  assert.doesNotThrow(() => assertOperationArity(unary, 1));
  assert.doesNotThrow(() => assertOperationArity(ternary, 3));
  assert.deepEqual(unary.policy.plan([[2, 3]]).shape, [2, 3]);
  assert.deepEqual(ternary.policy.plan([[2, 1], [3], []]).shape, [2, 3]);
  assert.throws(() => assertOperationArity(unary, 2), TypeError);
  assert.throws(() => assertOperationArity(ternary, 2), TypeError);
  assert.deepEqual(POINTWISE_SHAPE_POLICY.plan([[2, 1], [3], []]).shape, [2, 3]);
});

test("shape registration does not imply unrelated families or inherited object names", () => {
  for (const kind of ["sum-f32", "matmul-f32", "reduce-f32", "toString", "__proto__", "unregistered"]) {
    assert.equal(operationShapeContract(kind), undefined);
  }
});
