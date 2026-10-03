import test from "node:test";
import assert from "node:assert/strict";
import { exactTotal } from "../../browser/helpers/float32-sum-oracle.mjs";

test("exact sum oracle calibrates independently known binary32 boundaries", () => {
  const cases = [
    [[], 0], [[0x80000000], 0], [[1, 0x80000001], 0],
    [[0x7fffff, 1], 0x800000], [[0x3f800000, 0x33800000], 0x3f800000],
    [[0x3f800001, 0x33800000], 0x3f800002],
    [[0x3f800000, 0x33800000, 1], 0x3f800001],
    [[0x7f7fffff, 0x73000000], 0x7f800000],
    [[0x7f7fffff, 0x7f7fffff, 0xff7fffff, 0xff7fffff], 0],
    [[0x7f800000, 0xff7fffff, 0xff7fffff], 0x7f800000],
    [[0x7f800000, 0xff800000], 0x7fc00000],
  ];
  for (const [input, expected] of cases) assert.equal(exactTotal(input).bits, expected);
});
