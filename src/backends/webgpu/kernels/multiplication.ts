import { WEBGPU_SIGNIFICAND_PRODUCT_SOURCE } from "./significand-product.js";

/** One element per invocation; the host uses this same launch width. */
export const WEBGPU_MULTIPLICATION_WORKGROUP_SIZE = 64;

/** A full 24-by-24-bit product, rounded once without WGSL float relaxation. */
export const WEBGPU_MULTIPLICATION_SOURCE = `${WEBGPU_SIGNIFICAND_PRODUCT_SOURCE}
// Distances are at least 23. Normal and subnormal outputs use one rounding
// step, including all discarded bits, rather than rounding twice on underflow.
fn round_product(product: vec2<u32>, distance: u32) -> u32 {
  if distance > 48u { return 0u; }
  var rounded: u32;
  var above_half: bool;
  var exactly_half: bool;
  if distance < 32u {
    rounded = (product.x >> distance) | (product.y << (32u - distance));
    let remainder = product.x & ((1u << distance) - 1u);
    let half = 1u << (distance - 1u);
    above_half = remainder > half;
    exactly_half = remainder == half;
  } else if distance == 32u {
    rounded = product.y;
    above_half = product.x > 0x80000000u;
    exactly_half = product.x == 0x80000000u;
  } else {
    let high_distance = distance - 32u;
    rounded = product.y >> high_distance;
    let remainder = product.y & ((1u << high_distance) - 1u);
    let half = 1u << (high_distance - 1u);
    above_half = remainder > half || (remainder == half && product.x != 0u);
    exactly_half = remainder == half && product.x == 0u;
  }
  return rounded + select(0u, 1u, above_half || (exactly_half && (rounded & 1u) != 0u));
}

fn multiply_binary32(left: u32, right: u32) -> u32 {
  let a = left & 0x7fffffffu;
  let b = right & 0x7fffffffu;
  let sign = (left ^ right) & 0x80000000u;
  if a > 0x7f800000u || b > 0x7f800000u { return 0x7fc00000u; }
  if a == 0x7f800000u || b == 0x7f800000u {
    if a == 0u || b == 0u { return 0x7fc00000u; }
    return sign | 0x7f800000u;
  }
  if a == 0u || b == 0u { return sign; }
  var a_exponent = i32(a >> 23u);
  var b_exponent = i32(b >> 23u);
  var a_significand = a & 0x7fffffu;
  var b_significand = b & 0x7fffffu;
  if a_exponent == 0 {
    let shift = countLeadingZeros(a_significand) - 8u;
    a_significand <<= shift; a_exponent = 1 - i32(shift);
  } else { a_significand |= 0x800000u; }
  if b_exponent == 0 {
    let shift = countLeadingZeros(b_significand) - 8u;
    b_significand <<= shift; b_exponent = 1 - i32(shift);
  } else { b_significand |= 0x800000u; }
  let product = significand_product(a_significand, b_significand);
  // Each normalized significand is in [2^23, 2^24), so the leading product bit
  // is 46 or 47. Effective input exponents lie in [-22, 254]; the output
  // exponent and rounding distance fit i32/u32 without relying on overflow.
  let extra = select(0u, 1u, product.y >= 0x8000u);
  var exponent = a_exponent + b_exponent - 127 + i32(extra);
  let distance = 23u + extra + u32(max(0, 1 - exponent));
  var rounded = round_product(product, distance);
  if exponent <= 0 { exponent = select(0, 1, rounded >= 0x800000u); }
  if rounded >= 0x1000000u { rounded >>= 1u; exponent += 1; }
  if exponent >= 255 { return sign | 0x7f800000u; }
  return sign | (u32(exponent) << 23u) | (rounded & 0x7fffffu);
}

@group(0) @binding(0) var<storage, read> left: array<u32>;
@group(0) @binding(1) var<storage, read> right: array<u32>;
@group(0) @binding(2) var<storage, read_write> output: array<u32>;
@compute @workgroup_size(${WEBGPU_MULTIPLICATION_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) position: vec3<u32>) {
  let index = position.x;
  if index < arrayLength(&output) { output[index] = multiply_binary32(left[index], right[index]); }
}
`;
