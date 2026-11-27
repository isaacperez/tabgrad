import type { LinearDispatchLayout } from "../linear-dispatch.js";
import { WEBGPU_ADDITION_ARITHMETIC_SOURCE } from "./addition.js";
import { BFLOAT16_NARROW_SOURCE } from "./bfloat16.js";
import { WEBGPU_MULTIPLICATION_ARITHMETIC_SOURCE } from "./multiplication.js";
import { createPackedMatrixSource } from "./packed-matrix.js";

const MATRIX_ARITHMETIC = `${WEBGPU_ADDITION_ARITHMETIC_SOURCE}${WEBGPU_MULTIPLICATION_ARITHMETIC_SOURCE}${BFLOAT16_NARROW_SOURCE}
fn accumulate_packed(total: u32, left: u32, right: u32) -> u32 {
  let product = multiply_binary32(left << 16u, right << 16u);
  return add_binary32(total, product);
}

fn narrow_packed(bits: u32) -> u32 {
  return narrow_bfloat(bits);
}
`;

export function createBfloatMatrixSource(layout: LinearDispatchLayout): string {
  return createPackedMatrixSource(layout, MATRIX_ARITHMETIC);
}
