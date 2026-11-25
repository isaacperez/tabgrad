import assert from "node:assert/strict";
import { test } from "node:test";
import { computationSignature, pointwiseFamily } from "../../../dist/execution/operation-contracts.js";

test("pointwise arithmetic signatures and physical preparation share one shape law", () => {
  const family = computationSignature("add-f32").family;
  for (const kind of ["add-f32", "mul-f32", "add-f16", "mul-f16"]) {
    assert.equal(computationSignature(kind).family, family);
    assert.equal(pointwiseFamily(kind), family);
    assert.equal(computationSignature(kind).types.inputs.length, family.arity);
  }
  for (const kind of ["add-alpha-f32", "sum-f32", "expand-f32", "matmul-f32", "reduce-f32"]) {
    assert.equal(pointwiseFamily(kind), undefined);
  }
  assert.ok(Object.isFrozen(family));
  assert.deepEqual(family.plan([[2, 1], [3]]).shape, [2, 3]);
  assert.throws(() => family.plan([[2], [3]]), TypeError);
});

test("pointwise geometry remains independent of the bound operation arity", () => {
  const { plan } = pointwiseFamily("add-f32");
  assert.deepEqual(plan([[2, 3]]).shape, [2, 3]);
  assert.deepEqual(plan([[2, 1], [3], []]).shape, [2, 3]);
});
