import type { LinearDispatchLayout } from "../linear-dispatch.js";
import { WEBGPU_ADDITION_ARITHMETIC_SOURCE } from "./addition.js";
import { BINARY16_ROUND_SHIFT_SOURCE } from "./half.js";
import { createPackedMatrixSource } from "./packed-matrix.js";

const MATRIX_ARITHMETIC = `${WEBGPU_ADDITION_ARITHMETIC_SOURCE}${BINARY16_ROUND_SHIFT_SOURCE}
fn exact_half_product(left_bits: u32, right_bits: u32) -> u32 {
  let a = left_bits & 0x7fffu;
  let b = right_bits & 0x7fffu;
  let sign = ((left_bits ^ right_bits) & 0x8000u) << 16u;
  if a > 0x7c00u || b > 0x7c00u { return 0x7fc00000u; }
  if a == 0x7c00u || b == 0x7c00u {
    if a == 0u || b == 0u { return 0x7fc00000u; }
    return sign | 0x7f800000u;
  }
  if a == 0u || b == 0u { return sign; }
  let ae = a >> 10u;
  let be = b >> 10u;
  let av = (a & 1023u) | select(0u, 1024u, ae != 0u);
  let bv = (b & 1023u) | select(0u, 1024u, be != 0u);
  let product = av * bv;
  let leading = firstLeadingBit(product);
  // Each half significand carries scale 2^(max(E, 1)-25).
  // The product fits in at most 22 bits and is normal in binary32.
  let exponent = max(ae, 1u) + max(be, 1u) + leading + 77u;
  let fraction = (product << (23u - leading)) & 0x7fffffu;
  return sign | (exponent << 23u) | fraction;
}

fn narrow_packed(bits: u32) -> u32 {
  let sign = (bits >> 16u) & 0x8000u;
  let exponent = (bits >> 23u) & 255u;
  let fraction = bits & 0x7fffffu;
  if exponent == 255u && fraction != 0u { return 0x7e00u; }
  if exponent >= 143u { return sign | 0x7c00u; }
  if exponent < 113u { return sign | half_round_shift(fraction | 0x800000u, 126u - exponent); }
  return sign | (((exponent - 112u) << 10u) + half_round_shift(fraction, 13u));
}

fn accumulate_packed(total: u32, left: u32, right: u32) -> u32 {
  return add_binary32(total, exact_half_product(left, right));
}
`;

export function createHalfMatrixSource(layout: LinearDispatchLayout): string {
  return createPackedMatrixSource(layout, MATRIX_ARITHMETIC);
}
