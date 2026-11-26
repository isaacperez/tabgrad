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
  for (const fractionBits of [6, 12]) {
    assert.throws(() => validateCompactFloatOracle({ ...profile, fractionBits }, oracle), /7–11 fraction bits/);
  }
  for (const invalid of ["Infinity", -0]) {
    assert.throws(() => validateCompactFloatOracle(profile, {
      ...oracle, construction: { ...oracle.construction, inputs: [1, invalid] },
    }), /explicit nonfinite or signed-zero tokens/);
  }
  assert.throws(() => validateCompactFloatOracle(profile, {
    ...oracle, pointwise: { ...oracle.pointwise, mulThenAdd: [] },
  }), /16-bit words/);
  assert.throws(() => validateCompactFloatOracle(profile, {
    ...oracle, pointwise: { ...oracle.pointwise, left: [0x10000] },
  }), /16-bit words/);
});
