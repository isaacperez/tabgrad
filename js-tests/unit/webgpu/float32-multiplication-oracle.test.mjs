import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { exactMultiplication, multiplicationPairs } from "../../browser/helpers/float32-multiplication-oracle.mjs";
import { equivalentBits } from "../../browser/helpers/float32-addition-oracle.mjs";

function fixtureWord(value) { return value === "nan" ? 0x7fc00000 : value; }

test("exact product oracle retains independent native fixture expectations", async () => {
  const fixture = JSON.parse(await readFile(new URL("../../fixtures/python-tensor-oracle.json", import.meta.url), "utf8"));
  for (const entry of fixture.mulCases) for (let index = 0; index < entry.bits.length; index++) {
    assert.ok(equivalentBits(exactMultiplication(fixtureWord(entry.leftBits[index]), fixtureWord(entry.rightBits[index])), fixtureWord(entry.bits[index])), entry.name);
  }
});

test("exact product oracle resolves ties, signed underflow and normal carry", () => {
  for (const [left, right, expected] of [
    [0x3f800001, 0x3fc00000, 0x3fc00002], [0x3f800003, 0x3fc00000, 0x3fc00004],
    [1, 0x3f000000, 0], [3, 0x3f000000, 2], [0x80000001, 0x3f000000, 0x80000000],
    [0x7fffff, 0x3f800001, 0x800000], [0x7f7fffff, 0x40000000, 0x7f800000],
    [0, 0xff800000, 0x7fc00000], [0x80000000, 0xbf800000, 0],
  ]) assert.equal(exactMultiplication(left, right), expected);
});

test("exact product corpus agrees with independently exact binary64 finite products", () => {
  const pairs = multiplicationPairs();
  const left = new Float32Array(pairs.left.buffer), right = new Float32Array(pairs.right.buffer);
  const output = new Float32Array(1), bits = new Uint32Array(output.buffer);
  for (let index = 0; index < left.length; index++) {
    // Two binary32 significands have at most 48 product bits, within binary64's
    // 53 bits; its exponent range also covers every finite binary32 product.
    output[0] = left[index] * right[index];
    assert.ok(equivalentBits(bits[0], exactMultiplication(pairs.left[index], pairs.right[index])), `pair ${index}`);
  }
});
