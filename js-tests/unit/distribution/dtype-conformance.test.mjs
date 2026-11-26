import assert from "node:assert/strict";
import { test } from "node:test";
import { validateCompactFloatOracle } from "../../../scripts/dtype-conformance.mjs";

test("the compact oracle admits another format and rejects invalid data before browser startup", () => {
  const profile = { dtype: "bfloat16", fractionBits: 7 };
  const oracle = {
    construction: { inputs: [1, "-0"], words: [0x3f80, 0x8000] },
    pointwise: { left: [0x3f80], right: [0x4000], add: [0x4040], mul: [0x4000], mulThenAdd: [0x4040] },
  };
  assert.equal(validateCompactFloatOracle(profile, oracle), oracle);
  assert.throws(() => validateCompactFloatOracle({ ...profile, fractionBits: 6 }, oracle), /observable as float32/);
  assert.throws(() => validateCompactFloatOracle(profile, {
    ...oracle, construction: { ...oracle.construction, inputs: [1, "Infinity"] },
  }), /explicit nonfinite/);
  assert.throws(() => validateCompactFloatOracle(profile, {
    ...oracle, pointwise: { ...oracle.pointwise, mulThenAdd: [] },
  }), /16-bit words/);
  assert.throws(() => validateCompactFloatOracle(profile, {
    ...oracle, pointwise: { ...oracle.pointwise, left: [0x10000] },
  }), /16-bit words/);
});
