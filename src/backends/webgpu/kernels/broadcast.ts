import { invocationEntry, type LinearDispatchLayout } from "../linear-dispatch.js";

export const WEBGPU_POINTWISE_WORKGROUP_SIZE = 64;

/** Arithmetic is specialized at pipeline creation, never interpreted per value. */
export function pointwiseSource(arithmetic: string, calculate: string, layout: LinearDispatchLayout = "linear"): string {
  const entry = invocationEntry(layout, WEBGPU_POINTWISE_WORKGROUP_SIZE);
  return `${arithmetic}
@group(0) @binding(0) var<storage, read> left: array<u32>;
@group(0) @binding(1) var<storage, read> right: array<u32>;
@group(0) @binding(2) var<storage, read_write> output: array<u32>;
@group(0) @binding(3) var<storage, read> geometry: array<u32>;

@compute @workgroup_size(${WEBGPU_POINTWISE_WORKGROUP_SIZE})
${entry.signature}
  let width = geometry[2];
  let first = ${entry.index} * width;
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
