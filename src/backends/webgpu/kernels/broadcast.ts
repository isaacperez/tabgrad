import { WEBGPU_ADDITION_ARITHMETIC_SOURCE } from "./addition.js";
import { WEBGPU_MULTIPLICATION_ARITHMETIC_SOURCE } from "./multiplication.js";

export const WEBGPU_POINTWISE_WORKGROUP_SIZE = 64;

/** Arithmetic is specialized at pipeline creation, never interpreted per value. */
export function pointwiseSource(arithmetic: string, calculate: string): string {
  return `${arithmetic}
@group(0) @binding(0) var<storage, read> left: array<u32>;
@group(0) @binding(1) var<storage, read> right: array<u32>;
@group(0) @binding(2) var<storage, read_write> output: array<u32>;
@group(0) @binding(3) var<storage, read> geometry: array<u32>;

@compute @workgroup_size(${WEBGPU_POINTWISE_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) position: vec3<u32>) {
  let width = geometry[2];
  let first = position.x * width;
  if first >= geometry[1] { return; }
  let rank = geometry[0];
  var remaining = first;
  var left_index = 0u;
  var right_index = 0u;
  for (var axis = rank; axis > 0u; axis--) {
    let base = 3u + (axis - 1u) * 3u;
    let coordinate = remaining % geometry[base];
    remaining /= geometry[base];
    left_index += coordinate * geometry[base + 1u];
    right_index += coordinate * geometry[base + 2u];
  }
  // Four adjacent positions remain within the proven common inner run.
  // Scalar domains have rank zero and use width one.
  var left_step = 0u;
  var right_step = 0u;
  if rank != 0u {
    left_step = geometry[3u + (rank - 1u) * 3u + 1u];
    right_step = geometry[3u + (rank - 1u) * 3u + 2u];
  }
  for (var lane = 0u; lane < width; lane++) {
    output[first + lane] = ${calculate}(left[left_index + lane * left_step], right[right_index + lane * right_step]);
  }
}
`;
}

export const WEBGPU_BROADCAST_ADDITION_SOURCE = pointwiseSource(WEBGPU_ADDITION_ARITHMETIC_SOURCE, "add_binary32");
export const WEBGPU_BROADCAST_MULTIPLICATION_SOURCE = pointwiseSource(WEBGPU_MULTIPLICATION_ARITHMETIC_SOURCE, "multiply_binary32");
