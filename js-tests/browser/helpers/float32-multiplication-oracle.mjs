// Independent exact arithmetic in units of 2^-298; no shader limb operations.
export function exactMultiplication(left, right) {
  const a = left & 0x7fffffff;
  const b = right & 0x7fffffff;
  const sign = (left ^ right) & 0x80000000;
  if (a > 0x7f800000 || b > 0x7f800000) return 0x7fc00000;
  if (a === 0x7f800000 || b === 0x7f800000) {
    return a === 0 || b === 0 ? 0x7fc00000 : (sign | 0x7f800000) >>> 0;
  }
  if (a === 0 || b === 0) return sign >>> 0;
  const product = coefficient(a) * coefficient(b);
  let shift = Math.max(149, product.toString(2).length - 24);
  const spacing = 2n ** BigInt(shift);
  let quotient = product / spacing;
  const remainder = product % spacing;
  if (2n * remainder > spacing || (2n * remainder === spacing && quotient % 2n === 1n)) quotient++;
  if (quotient >= 0x1000000n) { quotient /= 2n; shift++; }
  const exponent = quotient < 0x800000n ? 0 : shift - 148;
  if (exponent >= 255) return (sign | 0x7f800000) >>> 0;
  return (sign | (exponent << 23) | (Number(quotient) & 0x7fffff)) >>> 0;
}

function coefficient(magnitude) {
  const exponent = magnitude >>> 23;
  return BigInt((magnitude & 0x7fffff) + (exponent ? 2 ** 23 : 0))
    * 2n ** BigInt(exponent ? exponent - 1 : 0);
}

export function multiplicationPairs() {
  const left = [], right = [];
  function pair(a, b) { left.push(a >>> 0); right.push(b >>> 0); }
  const special = [0, 0x80000000, 1, 0x80000001, 0x7fffff, 0x807fffff,
    0x800000, 0x80800000, 0x3f800000, 0xbf800000, 0x7f7fffff, 0xff7fffff,
    0x7f800000, 0xff800000, 0x7fc00000, 0x7f800001, 0xffc12345];
  for (const a of special) for (const b of special) pair(a, b);
  const fractions = [0, 1, 3, 0x3fffff, 0x400000, 0x7ffffe, 0x7fffff];
  // Each normal input exponent varies independently, not only along a diagonal.
  for (let a = 1; a < 255; a++) for (let b = 1; b < 255; b++) {
    pair((a << 23) | fractions[(a + b) % fractions.length] | ((a & 1) << 31),
      (b << 23) | fractions[(a + 2 * b) % fractions.length] | ((b & 1) << 31));
  }
  // Every subnormal normalization distance, with low and high sticky bits.
  for (let bit = 0; bit < 23; bit++) for (const a of [2 ** bit, 2 ** (bit + 1) - 1]) {
    for (const exponent of [1, 103, 126, 127, 128, 149, 150, 254]) {
      for (const fraction of fractions) { pair(a, (exponent << 23) | fraction); pair((exponent << 23) | fraction, a | 0x80000000); }
    }
  }
  // Underflow shifts cross both 32-bit words, including the half-minimum tie.
  for (let reduction = 1; reduction <= 26; reduction++) for (const fraction of fractions) {
    pair(0x800000 | fraction, (127 - reduction) << 23);
    pair(0x800000 | fraction, ((127 - reduction) << 23) | 1);
  }
  for (const a of [0x3f800001, 0x3f800003]) for (const sign of [0, 0x80000000]) pair(a ^ sign, 0x3fc00000);
  let seed = 260;
  for (let index = 0; index < 8192; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const a = seed;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pair(a, seed);
  }
  return { left: Uint32Array.from(left), right: Uint32Array.from(right) };
}
