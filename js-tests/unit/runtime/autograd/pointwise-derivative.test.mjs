import assert from "node:assert/strict";
import { test } from "node:test";
import { pointwiseGeometry, broadcastGeometry } from "../../../../dist/execution/broadcast-geometry.js";
import { pointwiseDerivative } from "../../../../dist/runtime/autograd/pointwise-derivative.js";

function fixture({ wrongLocal = false, failReceive = false, wrongReceiver = false, failClose = false } = {}) {
  const closed = [], incoming = { shape: [2, 3], name: "borrowed seed" };
  const operations = {
    shape: value => value.shape,
    pass: value => ({ shape: value.shape, name: "local alias" }),
    receive: (_value, projection) => {
      if (failReceive) throw new Error("reduce failed");
      return { shape: wrongReceiver ? [1, 3] : projection.originalShape, name: "received" };
    },
    close: value => { closed.push(value.name); if (failClose) throw new Error("close failed"); },
  };
  const local = { savedOperands: () => [], apply: () => ({ shape: wrongLocal ? [6] : [2, 3], name: "local" }) };
  return { closed, incoming, operations, recipe: pointwiseDerivative(local, pointwiseGeometry([[2, 3], [3]])) };
}

test("pointwise reception checks full shapes and retires unreturned intermediates", () => {
  for (const options of [{}, { wrongLocal: true }, { failReceive: true }, { wrongReceiver: true }, { failReceive: true, failClose: true }]) {
    const f = fixture(options);
    if (Object.keys(options).length === 0) assert.deepEqual(f.recipe.apply(f.incoming, [], [3], f.operations, 1).shape, [3]);
    else assert.throws(() => f.recipe.apply(f.incoming, [], [3], f.operations, 1));
    assert.ok(f.closed.includes("local"));
    assert.ok(!f.closed.includes("borrowed seed"));
    if (options.wrongReceiver) assert.ok(f.closed.includes("received"));
  }
});

test("pointwise reduction failure preserves its primary error before local cleanup failure", () => {
  const seed = { shape: [2, 3] }, local = { shape: [2, 3] }, closed = [];
  const reduction = new Error("reduction"), cleanup = new Error("local cleanup");
  const recipe = pointwiseDerivative({ savedOperands: () => [], apply: () => local }, pointwiseGeometry([[2, 3], [3]]));
  assert.throws(() => recipe.apply(seed, [], [3], {
    shape: value => value.shape,
    receive: () => { throw reduction; },
    close: value => { closed.push(value); throw cleanup; },
  }, 1), error => error instanceof AggregateError && error.errors.length === 2
    && error.errors[0] === reduction && error.errors[1] === cleanup);
  assert.deepEqual(closed, [local]);
});

for (const failResultClose of [false, true]) test(`a received result retires if local cleanup fails (result cleanup fails=${failResultClose})`, () => {
  const seed = { shape: [2, 3] }, local = { shape: [2, 3] }, result = { shape: [3] }, closed = [];
  const localFailure = new Error("local cleanup"), resultFailure = new Error("result cleanup");
  const recipe = pointwiseDerivative({ savedOperands: () => [], apply: () => local }, pointwiseGeometry([[2, 3], [3]]));
  assert.throws(() => recipe.apply(seed, [], [3], {
    shape: value => value.shape,
    receive: () => result,
    close: value => {
      closed.push(value);
      if (value === local) throw localFailure;
      if (failResultClose) throw resultFailure;
    },
  }, 1), error => failResultClose ? error instanceof AggregateError && error.errors.length === 2
    && error.errors[0] === localFailure && error.errors[1] === resultFailure : error === localFailure);
  assert.deepEqual(closed, [local, result]);
});

for (const returning of ["local", "receiver"]) test(`pointwise ${returning} cannot transfer the borrowed seed`, () => {
  const seed = { shape: [2, 3] }, local = { shape: [2, 3] }, closed = [];
  const recipe = pointwiseDerivative({ savedOperands: () => [], apply: () => returning === "local" ? seed : local }, pointwiseGeometry([[2, 3], [3]]));
  assert.throws(() => recipe.apply(seed, [], [3], {
    shape: value => value.shape, receive: () => seed, close: value => { closed.push(value); },
  }, 1), { code: "INVALID_TENSOR" });
  assert.deepEqual(closed, returning === "local" ? [] : [local]);
});

test("a local pass uses output shape and exact reception preserves its owned identity", () => {
  const geometry = pointwiseGeometry([[2, 3], [2, 3]]), incoming = { shape: [2, 3] }, local = { ...incoming };
  let closed = 0, receives = 0;
  const recipe = pointwiseDerivative({ savedOperands: () => [], apply(value, _saved, shape, operations) {
    assert.equal(value, incoming); assert.deepEqual(shape, [2, 3]); return operations.pass(value, shape);
  } }, geometry, true);
  const result = recipe.apply(incoming, [], [2, 3], { shape: value => value.shape,
    pass: () => local, receive: () => { receives++; }, close: () => { closed++; } }, 0);
  assert.equal(result, local);
  assert.equal(receives, 0);
  assert.equal(closed, 0);
});

test("a test-only third-arity/channel family reuses the same local/receiving adapter", () => {
  const geometry = broadcastGeometry(3, [
    { shape: [2, 3, 4], axes: [0, 1, 2] }, { shape: [3], axes: [1] }, { shape: [], axes: [] },
  ]);
  const seen = [], recipe = pointwiseDerivative({ savedOperands: position => [position], apply: () => ({ shape: [2, 3, 4] }) }, geometry);
  assert.deepEqual(recipe.savedOperands(2), [2]);
  const result = recipe.apply({ shape: [2, 3, 4] }, [], [3], { shape: value => value.shape, close: () => {}, receive: (_value, projection) => {
    seen.push(projection); return { shape: projection.originalShape };
  } }, 1);
  assert.deepEqual(result.shape, [3]);
  assert.deepEqual(seen[0].shape, [1, 3, 1]);
  assert.equal(seen[0].terms, 8);
});
