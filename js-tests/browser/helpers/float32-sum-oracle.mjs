// Independent arbitrary-precision mathematical oracle; no WGSL limb algorithm.
export function exactTotal(bits) {
  let total = 0n;
  let flags = 0;
  for (const word of bits) {
    const exponent = (word >>> 23) & 255;
    const fraction = word & 0x7fffff;
    if (exponent === 255) {
      flags |= fraction ? 1 : (word >>> 31 ? 4 : 2);
      continue;
    }
    const coefficient = BigInt(fraction + (exponent ? 2 ** 23 : 0))
      * 2n ** BigInt(exponent ? exponent - 1 : 0);
    total += word >>> 31 ? -coefficient : coefficient;
  }
  if ((flags & 1) || (flags & 6) === 6) return { bits: 0x7fc00000, flags, totalUnits: null };
  if (flags & 2) return { bits: 0x7f800000, flags, totalUnits: null };
  if (flags & 4) return { bits: 0xff800000, flags, totalUnits: null };
  if (total === 0n) return { bits: 0, flags, totalUnits: "0" };
  const sign = total < 0n ? 0x80000000 : 0;
  const magnitude = total < 0n ? -total : total;
  // Quotient/remainder chooses nearest-even independently of carry limbs,
  // guard words and sticky-bit extraction in the shader.
  const power = magnitude.toString(2).length - 1;
  const spacing = 2n ** BigInt(Math.max(0, power - 23));
  let quotient = magnitude / spacing;
  const remainder = magnitude % spacing;
  if (remainder * 2n > spacing || (remainder * 2n === spacing && quotient % 2n === 1n)) quotient++;
  const rounded = quotient * spacing;
  const roundedPower = rounded.toString(2).length - 1;
  let result;
  if (roundedPower >= 277) result = (sign | 0x7f800000) >>> 0;
  else if (rounded < 0x800000n) result = (sign | Number(rounded)) >>> 0;
  else {
    const finalSpacing = 2n ** BigInt(roundedPower - 23);
    const fraction = Number(rounded / finalSpacing - 0x800000n);
    result = (sign | ((roundedPower - 22) << 23) | fraction) >>> 0;
  }
  return { bits: result, flags, totalUnits: total.toString() };
}

export function exactCases() {
  const result = [
    [], [0], [0x80000000], [1], [0x80000001], [0x7fffff, 1], [0x7fffff, 0x7fffff],
    [0x3f800000, 0x33800000], [0x3f800001, 0x33800000], [0x3f800000, 0x33800000, 1],
    [0xbf800000, 0xb3800000, 0x80000001], [0x7f7fffff, 0x72800000],
    [0x7f7fffff, 0x73000000], [0xff7fffff, 0xf3000000],
    [0x7f7fffff, 0x7f7fffff, 0xff7fffff, 0xff7fffff],
    [0x7f800000, 0xff7fffff, 0xff7fffff], [0x7f800000, 0xff800000],
    [0xff800000, 0x7f7fffff, 0x7f7fffff],
    [0x7f800001, 0x3f800000], [0xffc12345, 0x7f800000],
    [0x4c000000, 0x3f800000, 0xcc000000, 0x3f800000],
  ];
  // Carries and cancellation span the exact coefficient lattice.
  const powers = [1, 0x800000, ...Array.from({ length: 253 }, (_, index) => (index + 2) << 23)];
  result.push(powers, powers.map((word) => (word ^ 0x80000000) >>> 0),
    [...powers, ...powers.map((word) => (word ^ 0x80000000) >>> 0), 1]);
  for (const length of [2, 3, 63, 64, 65, 127, 128, 129, 255, 256, 257, 16383, 16384, 16385]) {
    result.push(Array(length).fill(0x80000000));
    result.push(Array.from({ length }, (_, index) => index % 2 ? 0x80000001 : 1));
    let seed = 155;
    result.push(Array.from({ length }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    }));
    result.push(Array.from({ length }, (_, index) => index % 4 < 2 ? 0x7f7fffff : 0xff7fffff));
    let finiteSeed = 155;
    const finite = Array.from({ length }, () => {
      finiteSeed = (Math.imul(finiteSeed, 1664525) + 1013904223) >>> 0;
      return ((finiteSeed >>> 23) & 255) === 255 ? (finiteSeed & 0xff7fffff) >>> 0 : finiteSeed;
    });
    result.push(finite);
    const paired = [];
    for (let index = 0; index + 1 < length; index += 2) {
      paired.push(finite[index], (finite[index] ^ 0x80000000) >>> 0);
    }
    if (length % 2) paired.push(0x3f800000);
    result.push(paired);
  }
  // Halfway across all 32 guard-word offsets and both signs/significand parities.
  for (let exponent = 25; exponent <= 56; exponent++) {
    const tiny = (exponent - 24) << 23;
    result.push([exponent << 23, tiny], [(exponent << 23) | 1, tiny],
      [(exponent << 23) ^ 0x80000000, tiny ^ 0x80000000]);
  }
  result.push([...Array(16384).fill(0x7f7fffff), ...Array(16384).fill(0xff7fffff), 1]);
  return result.map((words) => Uint32Array.from(words));
}
