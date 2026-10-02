/** Independent exact integer oracle, in units of the smallest binary32 subnormal. */
export function exactAddition(left, right) {
  const a = left & 0x7fffffff, b = right & 0x7fffffff;
  if (a > 0x7f800000 || b > 0x7f800000) return 0x7fc00000;
  if (a === 0x7f800000 || b === 0x7f800000) {
    if (a === b && (left >>> 31) !== (right >>> 31)) return 0x7fc00000;
    return a === 0x7f800000 ? left : right;
  }
  if (a === 0 && b === 0) return (left & right & 0x80000000) >>> 0;
  const exact = integerValue(left) + integerValue(right);
  if (exact === 0n) return 0;
  const sign = exact < 0n ? 0x80000000 : 0;
  const absolute = exact < 0n ? -exact : exact;
  let shift = Math.max(0, absolute.toString(2).length - 24);
  let rounded = absolute >> BigInt(shift);
  if (shift !== 0) {
    const residual = absolute - (rounded << BigInt(shift));
    const half = 1n << BigInt(shift - 1);
    if (residual > half || (residual === half && (rounded & 1n) !== 0n)) rounded += 1n;
  }
  if (rounded >= 0x1000000n) { rounded >>= 1n; shift += 1; }
  if (shift >= 254) return (sign | 0x7f800000) >>> 0;
  const exponent = rounded < 0x800000n ? 0 : shift + 1;
  return (sign | (exponent << 23) | (Number(rounded) & 0x7fffff)) >>> 0;
}

function integerValue(bits) {
  const exponent = (bits >>> 23) & 255;
  const fraction = bits & 0x7fffff;
  const unsigned = BigInt(fraction | (exponent === 0 ? 0 : 0x800000)) << BigInt(Math.max(0, exponent - 1));
  return bits >>> 31 ? -unsigned : unsigned;
}

export function equivalentBits(actual, expected) {
  return actual === expected || ((actual & 0x7fffffff) > 0x7f800000 && (expected & 0x7fffffff) > 0x7f800000);
}

export function numericalPairs() {
  const special = [0, 0x80000000, 1, 0x80000001, 0x7fffff, 0x807fffff, 0x800000,
    0x80800000, 0x3f800000, 0xbf800000, 0x7f7fffff, 0xff7fffff, 0x7f800000, 0xff800000,
    0x7fc00000, 0x7f800001, 0xffc12345];
  const pairs = special.flatMap((a) => special.map((b) => [a, b]));
  for (let exponent = 1; exponent < 255; exponent += 1) {
    const value = exponent << 23;
    for (const fraction of [0, 1, 2, 0x7ffffe, 0x7fffff]) {
      const a = value | fraction;
      pairs.push([a, a ^ 0x80000000], [a, (a - 1) ^ 0x80000000], [a, a + 1]);
      if (exponent > 24) pairs.push([a, (exponent - 24) << 23]);
    }
  }
  let state = 0x106;
  for (let index = 0; index < 4096; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const left = state;
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    pairs.push([left, state]);
  }
  return { left: Uint32Array.from(pairs, (pair) => pair[0]), right: Uint32Array.from(pairs, (pair) => pair[1]) };
}
