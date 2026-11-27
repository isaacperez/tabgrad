import { WEBGPU_ADDITION_ARITHMETIC_SOURCE } from "./addition.js";
import { WEBGPU_MULTIPLICATION_ARITHMETIC_SOURCE } from "./multiplication.js";

export const BFLOAT16_NARROW_SOURCE = `
fn narrow_bfloat(bits: u32) -> u32 {
  if (bits & 0x7fffffffu) > 0x7f800000u { return 0x7fc0u; }
  let upper = bits >> 16u;
  let lower = bits & 0xffffu;
  return upper + u32(lower > 0x8000u || (lower == 0x8000u && (upper & 1u) != 0u));
}
`;

export const BFLOAT16_ADDITION_SOURCE = `${WEBGPU_ADDITION_ARITHMETIC_SOURCE}${BFLOAT16_NARROW_SOURCE}
fn add_bfloat16(left: u32, right: u32) -> u32 {
  return narrow_bfloat(add_binary32(left << 16u, right << 16u));
}
`;

export const BFLOAT16_MULTIPLICATION_SOURCE = `${WEBGPU_MULTIPLICATION_ARITHMETIC_SOURCE}${BFLOAT16_NARROW_SOURCE}
fn multiply_bfloat16(left: u32, right: u32) -> u32 {
  return narrow_bfloat(multiply_binary32(left << 16u, right << 16u));
}
`;
