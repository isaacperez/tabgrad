import assert from "node:assert/strict";
import { test } from "node:test";
import { coefficientSentinels, exactCoefficientAddition } from "../../browser/helpers/float32-coefficient-oracle.mjs";

const bits = value => new Uint32Array(new Float32Array([value]).buffer)[0];

test("exact coefficient oracle retains independently derived and native cancellation expectations", () => {
  for (const [p, g, a, expected] of coefficientSentinels) assert.equal(exactCoefficientAddition(p, g, a), expected);
  assert.equal(exactCoefficientAddition(bits(50.29061508178711), bits(502.9061279296875), bits(-0.1)), 0x35ce9e68);
});

test("exact coefficient exceptional arithmetic preserves zero signs and nonfinite categories", () => {
  for (const [p, g, a, expected] of [
    [0x80000000, 0, 0xbf800000, 0x80000000], [0, 0, 0xbf800000, 0],
    [0x3f800000, 0x7f800000, 0, 0x7fc00000],
    [0xff800000, 0x7f800000, 0x3f800000, 0x7fc00000],
    [0x7f800000, 0x7f7fffff, 0x7f7fffff, 0x7f800000],
  ]) assert.equal(exactCoefficientAddition(p, g, a), expected);
});
