import assert from "node:assert/strict";
import { test } from "node:test";
import { MATMUL_DERIVATIVE } from "../../../../dist/runtime/autograd/derivative-recipes.js";

test("matrix derivative retires an unpublished result if borrowed operand cleanup fails", () => {
  const incoming = {}, saved = {}, borrowed = {}, result = {}, closed = [];
  const failure = new Error("borrowed exposure release failed");
  const operations = { borrow: value => { assert.equal(value, saved); return borrowed; },
    matmul: (left, right, orientation) => {
      assert.equal(left, incoming); assert.equal(right, borrowed); assert.equal(orientation, "right"); return result;
    }, close: value => { closed.push(value); if (value === borrowed) throw failure; } };
  assert.throws(() => MATMUL_DERIVATIVE.apply(incoming, [saved], [2, 3], operations, 0), error => error === failure);
  assert.deepEqual(closed, [borrowed, result]);
});

test("matrix derivative preserves computation failure alongside independent cleanup failure", () => {
  const computation = new Error("matrix admission failed"), cleanup = new Error("borrowed release failed");
  const borrowed = {}, closed = [];
  const operations = { borrow: () => borrowed, matmul: () => { throw computation; },
    close: value => { closed.push(value); throw cleanup; } };
  assert.throws(() => MATMUL_DERIVATIVE.apply({}, [{}], [], operations, 1), error => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [computation, cleanup]); return true;
  });
  assert.deepEqual(closed, [borrowed]);
});

test("successful matrix derivative publishes only its result and closes only its borrowed exposure", () => {
  for (const position of [0, 1]) {
    const incoming = {}, borrowed = {}, result = {}, closed = [];
    const operations = { borrow: () => borrowed, matmul: (left, right, orientation) => {
      assert.equal(left, position === 0 ? incoming : borrowed);
      assert.equal(right, position === 0 ? borrowed : incoming);
      assert.equal(orientation, position === 0 ? "right" : "left"); return result;
    }, close: value => { closed.push(value); } };
    assert.equal(MATMUL_DERIVATIVE.apply(incoming, [{}], [], operations, position), result);
    assert.deepEqual(closed, [borrowed]);
  }
});
