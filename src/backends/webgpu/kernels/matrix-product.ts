import { WEBGPU_FUSED_MULTIPLY_ADD_SOURCE } from "./fused-multiply-add.js";

export const WEBGPU_MATRIX_WORKGROUP_SIZE = 64;
export const WEBGPU_MATRIX_UNIFORM_BYTES = 16;

export const WEBGPU_MATRIX_SOURCE = `${WEBGPU_FUSED_MULTIPLY_ADD_SOURCE}
struct Matrix { rows: u32, columns: u32, contraction: u32, flags: u32, }
@group(0) @binding(0) var<storage, read> left: array<u32>;
@group(0) @binding(1) var<storage, read> right: array<u32>;
@group(0) @binding(2) var<storage, read_write> output: array<u32>;
@group(0) @binding(3) var<uniform> matrix: Matrix;
@compute @workgroup_size(${WEBGPU_MATRIX_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) position: vec3<u32>) {
  let index = position.x;
  if index >= matrix.rows * matrix.columns { return; }
  let row = index / matrix.columns;
  let column = index % matrix.columns;
  var accumulator = 0u;
  for (var t = 0u; t < matrix.contraction; t++) {
    var a = row * matrix.contraction + t;
    if (matrix.flags & 1u) != 0u { a = t * matrix.rows + row; }
    var b = t * matrix.columns + column;
    if (matrix.flags & 2u) != 0u { b = column * matrix.contraction + t; }
    accumulator = fused_multiply_add_binary32(accumulator, left[a], right[b]);
  }
  output[index] = accumulator;
}
`;
