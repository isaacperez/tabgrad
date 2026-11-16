import { invocationEntry, type LinearDispatchLayout } from "../linear-dispatch.js";
import { WEBGPU_FUSED_MULTIPLY_ADD_SOURCE } from "./fused-multiply-add.js";

export const WEBGPU_COEFFICIENT_ADDITION_WORKGROUP_SIZE = 64;
/** Four u32 fields satisfy the uniform packet's 16-byte layout. */
export const WEBGPU_COEFFICIENT_UNIFORM_BYTES = 16;

/** Exact binary32 product plus parameter, with one nearest/ties-even rounding. */
export function createCoefficientAdditionSource(layout: LinearDispatchLayout = "linear"): string {
  const entry = invocationEntry(layout, WEBGPU_COEFFICIENT_ADDITION_WORKGROUP_SIZE);
  return `${WEBGPU_FUSED_MULTIPLY_ADD_SOURCE}
struct Coefficient { bits: u32, padding0: u32, padding1: u32, padding2: u32, }
@group(0) @binding(0) var<storage, read> parameters: array<u32>;
@group(0) @binding(1) var<storage, read> gradients: array<u32>;
@group(0) @binding(2) var<storage, read_write> output: array<u32>;
@group(0) @binding(3) var<uniform> coefficient: Coefficient;
@compute @workgroup_size(${WEBGPU_COEFFICIENT_ADDITION_WORKGROUP_SIZE})
${entry.signature}
  let index = ${entry.index};
  if index < arrayLength(&output) {
    output[index] = fused_multiply_add_binary32(parameters[index], gradients[index], coefficient.bits);
  }
}
`;
}

export const WEBGPU_COEFFICIENT_ADDITION_SOURCE = createCoefficientAdditionSource();
