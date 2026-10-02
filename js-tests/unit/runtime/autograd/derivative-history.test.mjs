import assert from "node:assert/strict";
import { test } from "node:test";
import { DerivativeHistory } from "../../../../dist/runtime/autograd/derivative-history.js";

test("consumption retires every saved owner and marks histories consumed even when release fails", () => {
  const released = [];
  const history = new DerivativeHistory(() => undefined, (value) => {
    released.push(value);
    throw new Error(`controlled saved release ${value}`);
  });
  const leaf = history.leaf([1]);
  const recipe = {
    savedOperands: () => [0],
    apply: () => ({}),
  };
  const inner = history.record([1], recipe, [leaf], ["inner"]);
  const outer = history.record([1], recipe, [inner], ["outer"]);
  const closed = new Set();
  const operations = {
    view: () => ({}),
    close: (value) => {
      assert.equal(closed.has(value), false, "each constructed handle retires exactly once");
      closed.add(value);
    },
  };
  assert.throws(() => history.execute(history.plan(outer, [leaf]), {}, operations));
  assert.deepEqual(released, ["outer", "inner"]);
  assert.equal(history.diagnostics().liveSavedValues, 0);
  assert.equal(inner.consumed, true);
  assert.equal(outer.consumed, true);
  assert.throws(() => history.plan(outer, [leaf]), { code: "CONSUMED_HISTORY" });
  history.release(outer); history.release(inner); history.release(leaf);
  assert.deepEqual(history.diagnostics(), { liveDerivativeNodes: 0, liveSavedValues: 0 });
  assert.deepEqual(released, ["outer", "inner"], "released pins must not be replayed after consumption failure");
});

test("consumption failure preserves its cause while retiring every temporary and result handle", () => {
  const savedFailure = new Error("controlled saved cleanup failure");
  const temporaryFailure = new Error("controlled temporary cleanup failure");
  const resultFailures = [new Error("controlled first result cleanup failure"), new Error("controlled second result cleanup failure")];
  const history = new DerivativeHistory(() => undefined, () => { throw savedFailure; });
  const leaf = history.leaf([1]);
  const temporary = { kind: "temporary" };
  const output = history.record([1], { savedOperands: () => [0], apply: () => temporary }, [leaf], ["saved"]);
  const results = [];
  const closed = [];
  const operations = {
    view: () => { const result = { kind: "result", index: results.length }; results.push(result); return result; },
    close: (value) => {
      assert.equal(closed.includes(value), false);
      closed.push(value);
      throw value === temporary ? temporaryFailure : resultFailures[value.index];
    },
  };
  assert.throws(() => history.execute(history.plan(output, [leaf, leaf]), {}, operations), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], savedFailure);
    assert.ok(error.errors.includes(temporaryFailure));
    for (const failure of resultFailures) assert.ok(error.errors.includes(failure));
    return true;
  });
  assert.equal(closed.length, 3);
  assert.ok(closed.includes(temporary));
  for (const result of results) assert.ok(closed.includes(result));
  assert.equal(output.consumed, true);
  assert.equal(history.diagnostics().liveSavedValues, 0);
  history.release(output); history.release(leaf);
});
