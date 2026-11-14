import assert from "node:assert/strict";
import { test } from "node:test";
import { MUL_DERIVATIVE, MATMUL_DERIVATIVE } from "../../../../dist/runtime/autograd/derivative-recipes.js";

for (const [name, recipe] of [["multiplication", MUL_DERIVATIVE], ["matrix", MATMUL_DERIVATIVE]]) {
  for (const failure of ["none", "calculation", "borrow cleanup", "both cleanup", "calculation and cleanup"]) {
    test(`${name} transfers or retires its borrowed derivative result (${failure})`, () => {
      const borrowed = {}, produced = {}, closed = [], events = [];
      const calculation = new Error("calculation failed"), retirement = new Error("borrow retirement failed"), resultRetirement = new Error("result retirement failed");
      const calculate = () => {
        events.push("calculate");
        if (failure.startsWith("calculation")) throw calculation;
        return produced;
      };
      const operations = {
        borrow: () => { events.push("borrow"); return borrowed; }, mul: calculate, matmul: calculate,
        close: value => {
          closed.push(value);
          if (value === borrowed && ["borrow cleanup", "both cleanup", "calculation and cleanup"].includes(failure)) throw retirement;
          if (value === produced && failure === "both cleanup") throw resultRetirement;
        },
      };
      const run = () => recipe.apply({}, [{}], [1], operations, 0);
      if (failure === "none") {
        assert.equal(run(), produced);
        assert.deepEqual(closed, [borrowed]);
      } else {
        const expected = failure === "calculation" ? [calculation] : failure === "calculation and cleanup" ? [calculation, retirement]
          : failure === "both cleanup" ? [retirement, resultRetirement] : [retirement];
        assert.throws(run, error => {
          if (expected.length === 1) return error === expected[0];
          assert.ok(error instanceof AggregateError);
          assert.deepEqual(error.errors, expected);
          return true;
        });
        assert.deepEqual(closed, failure.startsWith("calculation") ? [borrowed] : [borrowed, produced]);
      }
      assert.deepEqual(events, ["borrow", "calculate"]);
    });
  }
}
