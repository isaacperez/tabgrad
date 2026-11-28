import { invocationEntry, type LinearDispatchLayout } from "../linear-dispatch.js";
import { pointwiseElementIndices, WEBGPU_POINTWISE_WORKGROUP_SIZE } from "./broadcast.js";
import { BOOL_VALUES_PER_WORD } from "./packed-words.js";

export function createGreaterSource(broadcast: boolean, layout: LinearDispatchLayout): string {
  const entry = invocationEntry(layout, WEBGPU_POINTWISE_WORKGROUP_SIZE);
  return `
@group(0) @binding(0) var<storage, read> left: array<u32>;
@group(0) @binding(1) var<storage, read> right: array<u32>;
@group(0) @binding(2) var<storage, read_write> output: array<u32>;
@group(0) @binding(3) var<storage, read> geometry: array<u32>;

fn ordered(bits: u32) -> u32 {
  return select(bits ^ 0x80000000u, ~bits, (bits & 0x80000000u) != 0u);
}

// Compare by encoding to preserve subnormals on every supported adapter.
fn greater(a: u32, b: u32) -> u32 {
  let abs_a = a & 0x7fffffffu;
  let abs_b = b & 0x7fffffffu;
  if abs_a > 0x7f800000u || abs_b > 0x7f800000u || (abs_a | abs_b) == 0u {
    return 0u;
  }
  return select(0u, 1u, ordered(a) > ordered(b));
}

@compute @workgroup_size(${WEBGPU_POINTWISE_WORKGROUP_SIZE})
${entry.signature}
  let word = ${entry.index};
  let first = word * ${BOOL_VALUES_PER_WORD}u;
  if first >= geometry[1] { return; }
  var packed = 0u;
  for (var lane = 0u; lane < ${BOOL_VALUES_PER_WORD}u; lane++) {
    let index = first + lane;
    if index < geometry[1] {
      ${pointwiseElementIndices(broadcast)}
      packed |= greater(left[indices.x], right[indices.y]) << (lane * 8u);
    }
  }
  output[word] = packed;
}
`;
}
