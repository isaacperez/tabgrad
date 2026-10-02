import assert from "node:assert/strict";

export function float32FromBits(bits) {
  return bits === "nan" ? NaN : new Float32Array(new Uint32Array([bits]).buffer)[0];
}

function gamma(steps) {
  const product = steps * 2 ** -24;
  assert.ok(product < 1, "fixture exceeds the finite-error comparison domain");
  return product / (1 - product);
}

export function assertSumFixture(actual, fixture) {
  const expected = float32FromBits(fixture.bits);
  if (fixture.comparison === "bounded") {
    const n = fixture.inputBits.length;
    const depth = 37 + Math.ceil(Math.log2(Math.max(1, n / 128)));
    const underflow = n * 2 ** -149;
    const ownBound = gamma(depth) * fixture.absoluteSum + underflow;
    const oracleBound = gamma(n) * fixture.absoluteSum + underflow;
    assert.ok(Number.isFinite(actual), fixture.name);
    assert.ok(Math.abs(actual - fixture.referenceSum) <= ownBound, `${fixture.name}: mathematical reference`);
    assert.ok(Math.abs(actual - expected) <= ownBound + oracleBound, `${fixture.name}: native oracle`);
  } else if (fixture.comparison === "overflow") {
    // Accepted order-dependent outcomes remain explicit, never "any result passes".
    assert.equal(expected, Infinity, `${fixture.name}: pinned native classification`);
    if (fixture.name === "overflow-cancellation") assert.ok(Number.isNaN(actual), fixture.name);
    else assert.equal(actual, Infinity, fixture.name);
  } else {
    assert.equal(actual, expected, fixture.name); // strict equality includes NaN and signed zero
  }
}
