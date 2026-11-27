import { invocationEntry, type LinearDispatchLayout } from "../linear-dispatch.js";
import { PACKED16_LANE_SOURCE, PACKED16_VALUES_PER_WORD } from "./packed-words.js";

export const PACKED16_WORKGROUP_SIZE = 64;

/** Each invocation owns a complete word. Odd tails never load a missing lane. */
export function packed16PointwiseSource(arithmetic: string, calculate: string, broadcast: boolean, layout: LinearDispatchLayout): string {
  const entry = invocationEntry(layout, PACKED16_WORKGROUP_SIZE);
  const indices = broadcast ? `
      var remaining = index;
      var indices = vec2<u32>(0u);
      for (var axis = geometry[0]; axis > 0u; axis--) {
        let base = 3u + (axis - 1u) * 3u;
        let coordinate = remaining % geometry[base];
        remaining /= geometry[base];
        indices += coordinate * vec2<u32>(geometry[base + 1u], geometry[base + 2u]);
      }` : "let indices = vec2<u32>(index);";
  return `${arithmetic}${PACKED16_LANE_SOURCE}
@group(0) @binding(0) var<storage, read> left: array<u32>;
@group(0) @binding(1) var<storage, read> right: array<u32>;
@group(0) @binding(2) var<storage, read_write> output: array<u32>;
@group(0) @binding(3) var<storage, read> geometry: array<u32>;
@compute @workgroup_size(${PACKED16_WORKGROUP_SIZE})
${entry.signature}
  let word_index = ${entry.index};
  let first = word_index * ${PACKED16_VALUES_PER_WORD}u;
  if first >= geometry[1] { return; }
  var packed = 0u;
  for (var lane = 0u; lane < ${PACKED16_VALUES_PER_WORD}u; lane++) {
    let index = first + lane;
    if index < geometry[1] {
      ${indices}
      let a = packed16_lane(left[indices.x / ${PACKED16_VALUES_PER_WORD}u], indices.x);
      let b = packed16_lane(right[indices.y / ${PACKED16_VALUES_PER_WORD}u], indices.y);
      packed |= ${calculate}(a, b) << (lane * 16u);
    }
  }
  output[word_index] = packed;
}
`;
}
