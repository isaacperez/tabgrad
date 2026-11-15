import assert from "node:assert/strict";
import { test } from "node:test";
import { DerivativeHistory } from "../../../../dist/runtime/autograd/derivative-history.js";
import { DerivativeResources } from "../../../../dist/runtime/autograd/derivative-resources.js";
import { planDerivativeResources } from "../../../../dist/runtime/autograd/derivative-resource-plan.js";
import { pointwiseGeometry } from "../../../../dist/execution/broadcast-geometry.js";
import { pointwiseDerivative, hasCanonicalPointwiseControls } from "../../../../dist/runtime/autograd/pointwise-derivative.js";
import { MUL_DERIVATIVE, POINTWISE_PASS_DERIVATIVE, MATMUL_DERIVATIVE, SUM_DERIVATIVE,
  IDENTITY_DERIVATIVE, hasCanonicalDerivativeControls } from "../../../../dist/runtime/autograd/derivative-recipes.js";

const captures = Object.freeze({ receivingOwners: 12, restorationOwners: 16 });

for (const invalid of ["missing", "null", "plain", "mutable", "accessor"]) {
  test(`history rejects a ${invalid} resource binding before acquiring pins`, () => {
    let retained = 0, reads = 0;
    const history = new DerivativeHistory(() => { retained++; }, () => {});
    const leaf = history.leaf([1]);
    const recipe = { savedOperands: () => [0], apply: () => ({}) };
    if (invalid === "null") recipe.resources = null;
    if (invalid === "plain" || invalid === "mutable") recipe.resources = { arity: 1, localOwners: 4, localBackings: 1 };
    if (invalid === "accessor") Object.defineProperty(recipe, "resources", { get() { reads++; return {}; } });
    if (invalid !== "mutable") Object.freeze(recipe);
    const before = history.diagnostics(), references = history.references;
    assert.throws(() => history.record([1], recipe, [leaf], ["saved"]), { code: "UNSUPPORTED_GRADIENT" });
    assert.equal(retained, 0);
    assert.equal(reads, 0, "resource admission must not call accessors");
    assert.equal(history.references, references);
    assert.deepEqual(history.diagnostics(), before);
    history.release(leaf);
  });
}

test("resource profiles reject unsupported counts and cannot be forged by prototype", () => {
  for (const counts of [[0, 4, 1], [1, 0, 1], [1, 4, -1], [1.5, 4, 1], [1, Infinity, 1], [1, 4, NaN]]) {
    assert.throws(() => new DerivativeResources(...counts), { code: "UNSUPPORTED_GRADIENT" });
  }
  const profile = new DerivativeResources(1, 4, 1);
  assert.ok(Object.isFrozen(profile));
  assert.throws(() => { profile.localOwners = 0; }, TypeError);
  const history = new DerivativeHistory(() => {}, () => {}), leaf = history.leaf([1]);
  for (const resources of [new DerivativeResources(2, 4, 1), Object.freeze(Object.create(DerivativeResources.prototype))]) {
    assert.throws(() => history.record([1], Object.freeze({ resources, savedOperands: () => [], apply: () => ({}) }), [leaf], []),
      { code: "UNSUPPORTED_GRADIENT" });
    assert.equal(history.references, 1);
  }
  history.release(leaf);
});

function currentPlan(recipe, shapes, outputShape, { pointwise = false, repeat = false, selected = null } = {}) {
  const history = new DerivativeHistory(() => {}, () => {});
  const leaves = shapes.map(shape => history.leaf(shape));
  const inputs = repeat ? shapes.map(() => leaves[0]) : leaves;
  const bound = pointwise ? pointwiseDerivative(recipe, pointwiseGeometry(shapes), recipe === POINTWISE_PASS_DERIVATIVE) : recipe;
  const root = history.record(outputShape, bound, inputs, shapes);
  return { history, root, leaves, plan: history.plan(root, selected === null ? [...new Set(inputs)] : selected.map(i => inputs[i])) };
}

// Expected totals are the previous policy, including excess outside its byte max.
for (const scenario of [
  { name: "binary", recipe: MUL_DERIVATIVE, shapes: [[3], [3]], output: [3], effects: 2, owners: 60, bytes: 180 },
  { name: "repeated", recipe: MUL_DERIVATIVE, shapes: [[3], [3]], output: [3], repeat: true, effects: 1, owners: 40, bytes: 120 },
  { name: "pruned", recipe: MUL_DERIVATIVE, shapes: [[3], [3]], output: [3], selected: [0], effects: 1, owners: 40, bytes: 120 },
  { name: "broadcast product", recipe: MUL_DERIVATIVE, pointwise: true, shapes: [[2, 3], [3]], output: [2, 3], effects: 2, owners: 88, bytes: 324 },
  { name: "broadcast pass", recipe: POINTWISE_PASS_DERIVATIVE, pointwise: true, shapes: [[2, 3], [3]], output: [2, 3], effects: 2, owners: 88, bytes: 300 },
  { name: "two receptions", recipe: MUL_DERIVATIVE, pointwise: true, shapes: [[2, 1], [1, 3]], output: [2, 3], effects: 2, owners: 84, bytes: 268 },
  { name: "pruned reception", recipe: MUL_DERIVATIVE, pointwise: true, shapes: [[2, 1], [1, 3]], output: [2, 3], selected: [0], effects: 1, owners: 52, bytes: 184 },
  { name: "empty source with nonempty receiver", recipe: MUL_DERIVATIVE, pointwise: true, shapes: [[0, 3], [1, 3]], output: [0, 3], effects: 2, owners: 72, bytes: 60 },
  { name: "matrix", recipe: MATMUL_DERIVATIVE, shapes: [[2, 3], [3, 4]], output: [2, 4], effects: 2, owners: 60, bytes: 520 },
  { name: "sum", recipe: SUM_DERIVATIVE, shapes: [[32]], output: [], effects: 1, owners: 40, bytes: 660 },
  { name: "view", recipe: IDENTITY_DERIVATIVE, shapes: [[6]], output: [2, 3], effects: 1, owners: 40, bytes: 240 },
]) test(`current reservations remain exact: ${scenario.name}`, () => {
  const f = currentPlan(scenario.recipe, scenario.shapes, scenario.output, scenario);
  assert.deepEqual(planDerivativeResources(f.plan, scenario.effects, captures), { ownerSlots: scenario.owners, backingBytes: scenario.bytes });
  f.history.release(f.root);
  for (const leaf of f.leaves) f.history.release(leaf);
  assert.deepEqual(f.history.diagnostics(), { liveDerivativeNodes: 0, liveSavedValues: 0 });
});

// Two borrowed saved exposures (2 each) and two binary products (4 each),
// with both output-domain backings charged and no retirement credit.
function compoundRecipe() {
  return Object.freeze({ resources: new DerivativeResources(3, 12, 2),
    savedOperands: position => [(position + 1) % 3, (position + 2) % 3],
    apply(incoming, saved, _shape, operations) {
      const first = operations.borrow(saved[0]);
      let second, product;
      try {
        second = operations.borrow(saved[1]);
        product = operations.mul(incoming, first);
        return operations.mul(product, second);
      } finally {
        if (product !== undefined) operations.close(product);
        if (second !== undefined) operations.close(second);
        operations.close(first);
      }
    } });
}

test("repeated ternary contributions charge their declared construction and actual combines", () => {
  const f = currentPlan(compoundRecipe(), [[2], [2], [2]], [2], { repeat: true });
  assert.deepEqual(planDerivativeResources(f.plan, 1, captures), { ownerSlots: 52, backingBytes: 104 });
  assert.ok(52 > 20 * f.plan.order.length, "the old binary floor is not the only proof");
  f.history.release(f.root);
  for (const leaf of f.leaves) f.history.release(leaf);
});

test("a compound family charges both output-domain products before asymmetric reception", () => {
  const f = currentPlan(compoundRecipe(), [[2, 3], [3], []], [2, 3], { pointwise: true });
  // Sixteen selected-node elements give base320; excesses are24,48,48.
  assert.deepEqual(planDerivativeResources(f.plan, 3, captures), { ownerSlots: 136, backingBytes: 440 });
  f.history.release(f.root);
  for (const leaf of f.leaves) f.history.release(leaf);
});

for (const failProduct of [0, 2]) test(`private compound execution retires temporaries (failure=${failProduct})`, () => {
  const active = new Set(), saved = { data: [2, 3] }, seed = { data: [1, 1] };
  let borrows = 0, products = 0;
  const owned = data => { const value = { data }; active.add(value); return value; };
  const failure = new Error("controlled second product");
  const operations = {
    borrow: value => { borrows++; return owned(value.data); },
    mul: (left, right) => { if (++products === failProduct) throw failure; return owned(left.data.map((x, i) => Math.fround(x * right.data[i]))); },
    add: (left, right) => owned(left.data.map((x, i) => Math.fround(x + right.data[i]))),
    view: value => owned(value.data), close: value => { assert.ok(active.delete(value), "one owning exposure retires once"); },
  };
  const history = new DerivativeHistory(() => {}, () => {}), leaf = history.leaf([2]);
  const root = history.record([2], compoundRecipe(), [leaf, leaf, leaf], [saved, saved, saved]);
  const plan = history.plan(root, [leaf]);
  if (failProduct) {
    assert.throws(() => history.execute(plan, seed, operations), error => error === failure);
    assert.equal(root.consumed, false);
  } else {
    const results = history.execute(plan, seed, operations);
    assert.deepEqual(results[0].data, [12, 27]);
    assert.equal(borrows, 6); assert.equal(products, 6);
    for (const result of results) operations.close(result);
    assert.equal(root.consumed, true);
  }
  assert.equal(active.size, 0);
  history.release(root); history.release(leaf);
  assert.deepEqual(history.diagnostics(), { liveDerivativeNodes: 0, liveSavedValues: 0 });
});

test("unsafe demand rejects without consuming saved state", () => {
  const recipe = Object.freeze({ ...compoundRecipe(), resources: new DerivativeResources(3, Number.MAX_SAFE_INTEGER, 2) });
  const f = currentPlan(recipe, [[2], [2], [2]], [2], { repeat: true });
  const before = f.history.diagnostics();
  assert.throws(() => planDerivativeResources(f.plan, 1, captures), { code: "RESOURCE_EXHAUSTED" });
  assert.equal(f.root.consumed, false); assert.deepEqual(f.history.diagnostics(), before);
  f.history.release(f.root);
  for (const leaf of f.leaves) f.history.release(leaf);
});

test("neither profile numbers nor copied family metadata grant CPU writer isolation", () => {
  assert.equal(hasCanonicalDerivativeControls(MUL_DERIVATIVE), true);
  const known = pointwiseDerivative(MUL_DERIVATIVE, pointwiseGeometry([[2], [2]]));
  assert.equal(hasCanonicalPointwiseControls(known), true);
  const unknown = Object.freeze({ ...MUL_DERIVATIVE, apply: () => ({}) });
  assert.equal(hasCanonicalDerivativeControls(unknown), false);
  assert.equal(hasCanonicalPointwiseControls(pointwiseDerivative(unknown, pointwiseGeometry([[2], [2]]))), false);
  assert.equal(hasCanonicalPointwiseControls(Object.freeze({ ...known, apply: unknown.apply })), false);
  assert.ok(Object.isFrozen(Object.getPrototypeOf(known)));
});
