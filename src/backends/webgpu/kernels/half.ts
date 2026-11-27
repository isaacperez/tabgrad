/** Round an unsigned significand by a positive right-shift distance. */
export const BINARY16_ROUND_SHIFT_SOURCE = `
fn half_round_shift(value: u32, distance: u32) -> u32 {
  if distance >= 32u { return 0u; }
  let truncated = value >> distance;
  let remainder = value & ((1u << distance) - 1u);
  let midpoint = 1u << (distance - 1u);
  return truncated + select(0u, 1u, remainder > midpoint || (remainder == midpoint && (truncated & 1u) != 0u));
}
`;

/** Binary16 arithmetic in bounded u32 significands; no optional or relaxed float operations. */
export const BINARY16_ARITHMETIC = `${BINARY16_ROUND_SHIFT_SOURCE}
fn half_shift_jam(value: u32, distance: u32) -> u32 {
  if distance == 0u { return value; }
  if distance >= 32u { return select(0u, 1u, value != 0u); }
  return (value >> distance) | select(0u, 1u, (value << (32u - distance)) != 0u);
}
fn add_binary16(left: u32, right: u32) -> u32 {
  let a = left & 0x7fffu;
  let b = right & 0x7fffu;
  if a > 0x7c00u || b > 0x7c00u { return 0x7e00u; }
  if a == 0x7c00u {
    if b == 0x7c00u && ((left ^ right) & 0x8000u) != 0u { return 0x7e00u; }
    return left;
  }
  if b == 0x7c00u { return right; }
  if a == 0u && b == 0u { return (left & right) & 0x8000u; }
  var large = left;
  var small = right;
  if b > a { large = right; small = left; }
  let sign = large & 0x8000u;
  var exponent = max((large >> 10u) & 31u, 1u);
  let small_exponent = max((small >> 10u) & 31u, 1u);
  var significand = ((large & 1023u) | select(0u, 1024u, (large & 0x7c00u) != 0u)) << 3u;
  let aligned = half_shift_jam(((small & 1023u) | select(0u, 1024u, (small & 0x7c00u) != 0u)) << 3u, exponent - small_exponent);
  if ((large ^ small) & 0x8000u) == 0u {
    significand += aligned;
    if significand >= 16384u { significand = half_shift_jam(significand, 1u); exponent += 1u; }
  } else {
    significand -= aligned;
    if significand == 0u { return 0u; }
    while significand < 8192u && exponent > 1u { significand <<= 1u; exponent -= 1u; }
  }
  let remainder = significand & 7u;
  var rounded = significand >> 3u;
  if remainder > 4u || (remainder == 4u && (rounded & 1u) != 0u) { rounded += 1u; }
  if rounded >= 2048u { rounded >>= 1u; exponent += 1u; }
  if exponent >= 31u { return sign | 0x7c00u; }
  if rounded < 1024u { exponent = 0u; }
  return sign | (exponent << 10u) | (rounded & 1023u);
}
fn multiply_binary16(left: u32, right: u32) -> u32 {
  let a = left & 0x7fffu;
  let b = right & 0x7fffu;
  let sign = (left ^ right) & 0x8000u;
  if a > 0x7c00u || b > 0x7c00u { return 0x7e00u; }
  if a == 0x7c00u || b == 0x7c00u {
    if a == 0u || b == 0u { return 0x7e00u; }
    return sign | 0x7c00u;
  }
  if a == 0u || b == 0u { return sign; }
  var ae = i32(a >> 10u);
  var be = i32(b >> 10u);
  var av = a & 1023u;
  var bv = b & 1023u;
  if ae == 0 {
    let shift = countLeadingZeros(av) - 21u;
    av <<= shift; ae = 1 - i32(shift);
  } else { av |= 1024u; }
  if be == 0 {
    let shift = countLeadingZeros(bv) - 21u;
    bv <<= shift; be = 1 - i32(shift);
  } else { bv |= 1024u; }
  let product = av * bv;
  let extra = select(0u, 1u, product >= 2097152u);
  var exponent = ae + be - 15 + i32(extra);
  let distance = 10u + extra + u32(max(0, 1 - exponent));
  var rounded = half_round_shift(product, distance);
  if exponent <= 0 { exponent = select(0, 1, rounded >= 1024u); }
  if rounded >= 2048u { rounded >>= 1u; exponent += 1; }
  if exponent >= 31 { return sign | 0x7c00u; }
  return sign | (u32(exponent) << 10u) | (rounded & 1023u);
}
`;
