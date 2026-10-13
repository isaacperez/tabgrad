import { WEBGPU_SIGNIFICAND_PRODUCT_SOURCE } from "./significand-product.js";

/** Exact binary32 addend plus two factors, rounded once nearest/ties-even. */
export const WEBGPU_FUSED_MULTIPLY_ADD_SOURCE = `${WEBGPU_SIGNIFICAND_PRODUCT_SOURCE}
// Magnitudes have a leading bit at 61. The exact product leaves 14/15 low
// zeros and a parameter leaves 38. Alignment with discarded bits cannot cause
// deep cancellation; jam retains the residual needed to break midpoint ties.
fn left_magnitude(v: vec2<u32>, distance: u32) -> vec2<u32> {
  if distance == 0u { return v; }
  if distance < 32u { return vec2<u32>(v.x << distance, (v.y << distance) | (v.x >> (32u - distance))); }
  if distance == 32u { return vec2<u32>(0u, v.x); }
  return vec2<u32>(0u, v.x << (distance - 32u));
}

fn jam_magnitude(v: vec2<u32>, distance: u32) -> vec2<u32> {
  if distance == 0u { return v; }
  if distance >= 64u { return vec2<u32>(select(0u, 1u, (v.x | v.y) != 0u), 0u); }
  if distance < 32u {
    return vec2<u32>((v.x >> distance) | (v.y << (32u - distance))
      | select(0u, 1u, (v.x << (32u - distance)) != 0u), v.y >> distance);
  }
  if distance == 32u { return vec2<u32>(v.y | select(0u, 1u, v.x != 0u), 0u); }
  let shift = distance - 32u;
  return vec2<u32>((v.y >> shift) | select(0u, 1u, v.x != 0u || (v.y << (32u - shift)) != 0u), 0u);
}

fn add_magnitudes(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> {
  let low = a.x + b.x;
  return vec2<u32>(low, a.y + b.y + select(0u, 1u, low < a.x));
}

fn subtract_magnitudes(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> {
  return vec2<u32>(a.x - b.x, a.y - b.y - select(0u, 1u, a.x < b.x));
}

struct NormalBinary32 { significand: u32, exponent: i32, }

fn normalize_binary32(word: u32) -> NormalBinary32 {
  let exponent = (word >> 23u) & 255u;
  var significand = word & 0x7fffffu;
  if exponent != 0u { return NormalBinary32(significand | 0x800000u, i32(exponent) - 127); }
  if significand == 0u { return NormalBinary32(0u, -126); }
  let shift = countLeadingZeros(significand) - 8u;
  return NormalBinary32(significand << shift, -126 - i32(shift));
}

// Final distances are >=38. Underflow extends that same rounding distance;
// it never rounds first to a normal intermediate and then to a subnormal.
fn round_magnitude(v: vec2<u32>, distance: u32) -> u32 {
  if distance > 64u { return 0u; }
  if distance == 64u {
    return select(0u, 1u, v.y > 0x80000000u || (v.y == 0x80000000u && v.x != 0u));
  }
  let shift = distance - 32u;
  let quotient = v.y >> shift;
  let remainder = v.y & ((1u << shift) - 1u);
  let half = 1u << (shift - 1u);
  return quotient + select(0u, 1u, remainder > half
    || (remainder == half && (v.x != 0u || (quotient & 1u) != 0u)));
}

fn finite_fused_multiply_add(p: u32, g: u32, alpha: u32) -> u32 {
  let parameter = normalize_binary32(p);
  let gradient = normalize_binary32(g);
  let coefficient = normalize_binary32(alpha);
  let product = significand_product(gradient.significand, coefficient.significand);
  let extra = select(0u, 1u, product.y >= 0x8000u);
  let product_exponent = gradient.exponent + coefficient.exponent + i32(extra);
  var exponent = max(product_exponent, parameter.exponent);
  if parameter.significand == 0u { exponent = product_exponent; }
  let parameter_magnitude = jam_magnitude(left_magnitude(vec2<u32>(parameter.significand, 0u), 38u),
    u32(max(0, exponent - parameter.exponent)));
  let product_magnitude = jam_magnitude(left_magnitude(product, 15u - extra),
    u32(max(0, exponent - product_exponent)));
  let parameter_sign = p & 0x80000000u;
  let product_sign = (g ^ alpha) & 0x80000000u;
  var sign = parameter_sign;
  var magnitude: vec2<u32>;
  if parameter_sign == product_sign {
    magnitude = add_magnitudes(parameter_magnitude, product_magnitude);
    if magnitude.y >= 0x40000000u { magnitude = jam_magnitude(magnitude, 1u); exponent++; }
  } else {
    if parameter_magnitude.y > product_magnitude.y
      || (parameter_magnitude.y == product_magnitude.y && parameter_magnitude.x >= product_magnitude.x) {
      magnitude = subtract_magnitudes(parameter_magnitude, product_magnitude);
    } else {
      magnitude = subtract_magnitudes(product_magnitude, parameter_magnitude);
      sign = product_sign;
    }
    if (magnitude.x | magnitude.y) == 0u { return 0u; }
    var top: u32;
    if magnitude.y != 0u { top = 63u - countLeadingZeros(magnitude.y); }
    else { top = 31u - countLeadingZeros(magnitude.x); }
    let shift = 61u - top;
    magnitude = left_magnitude(magnitude, shift); exponent -= i32(shift);
  }
  var rounded = round_magnitude(magnitude, 38u + u32(max(0, -126 - exponent)));
  if rounded >= 0x1000000u { rounded >>= 1u; exponent++; }
  if exponent >= 128 { return sign | 0x7f800000u; }
  var field = u32(max(0, exponent + 127));
  if exponent < -126 { field = select(0u, 1u, rounded >= 0x800000u); }
  return sign | (field << 23u) | (rounded & 0x7fffffu);
}

fn fused_multiply_add_binary32(p: u32, g: u32, alpha: u32) -> u32 {
  let pm = p & 0x7fffffffu;
  let gm = g & 0x7fffffffu;
  let am = alpha & 0x7fffffffu;
  let sign = (g ^ alpha) & 0x80000000u;
  if pm > 0x7f800000u || gm > 0x7f800000u || am > 0x7f800000u { return 0x7fc00000u; }
  if gm == 0x7f800000u || am == 0x7f800000u {
    if gm == 0u || am == 0u || (pm == 0x7f800000u && ((p ^ sign) & 0x80000000u) != 0u) { return 0x7fc00000u; }
    return sign | 0x7f800000u;
  }
  if pm == 0x7f800000u { return p; }
  if gm == 0u || am == 0u {
    if pm == 0u { return p & sign; }
    return p;
  }
  return finite_fused_multiply_add(p, g, alpha);
}

`;
