// Conversion is synchronous and cannot call user code; each realm owns this
// private scalar scratch. No allocation or transcendental operation per value.
const scalar = new DataView(new ArrayBuffer(8));

/** Convert the original binary64 Number, without an intervening binary32 round. */
export function encodeBinary16(value: number): number {
  scalar.setFloat64(0, value, true);
  const low = scalar.getUint32(0, true), high = scalar.getUint32(4, true);
  const sign = (high >>> 16) & 0x8000;
  const exponent = (high >>> 20) & 2047;
  const fraction = high & 0xfffff;
  if (exponent === 2047 && (fraction !== 0 || low !== 0)) return 0x7e00;
  if (exponent >= 1039) return sign | 0x7c00;
  if (exponent < 998) return sign;
  // The discarded low32 bits are sticky; the high word supplies guard and
  // parity for one round, including subnormal and overflow boundaries.
  const distance = exponent < 1009 ? 1019 - exponent : 10;
  const significand = fraction | 0x100000;
  let rounded = significand >>> distance;
  const remainder = significand & ((1 << distance) - 1), midpoint = 1 << (distance - 1);
  if (remainder > midpoint || (remainder === midpoint && (low !== 0 || (rounded & 1) !== 0))) rounded += 1;
  return sign | (exponent < 1009 ? rounded : (exponent - 1008) * 1024 + rounded - 1024);
}

/** Exact binary32 observation bits, including binary16's complete subnormal range. */
export function binary16ObservationBits(bits: number): number {
  const sign = (bits & 0x8000) << 16;
  const exponent = (bits >>> 10) & 31;
  const fraction = bits & 1023;
  if (exponent === 31) return sign | 0x7f800000 | (fraction << 13);
  if (exponent !== 0) return sign | ((exponent + 112) << 23) | (fraction << 13);
  if (fraction === 0) return sign;
  const shift = Math.clz32(fraction) - 21;
  return sign | ((113 - shift) << 23) | (((fraction << shift) & 1023) << 13);
}
