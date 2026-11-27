import type { LinearDispatchLayout } from "../linear-dispatch.js";
import { PACKED16_LANE_SOURCE } from "./packed-words.js";
import { WEBGPU_EXACT_SUM_ARITHMETIC_SOURCE, createWideSumSource } from "./sum.js";

// The existing accumulator is scaled by 2^-149. Bfloat16's least significant
// subnormal bit is 2^-133, so the narrow step always discards at least 16 bits.
const BFLOAT_SUM_ROUNDING = `
fn rounded_bfloat(value: Accumulator) -> u32 {
  if (value.flags & 1u) != 0u || (value.flags & 6u) == 6u { return 0x7fc0u; }
  if (value.flags & 2u) != 0u { return 0x7f80u; }
  if (value.flags & 4u) != 0u { return 0xff80u; }
  let sign = (value.words[9] >> 16u) & 0x8000u;
  var magnitude = value;
  if sign != 0u { magnitude = negate(magnitude); }
  var highest = -1i;
  for (var index = 0u; index < 10u; index++) {
    if magnitude.words[index] != 0u { highest = i32(32u * index + firstLeadingBit(magnitude.words[index])); }
  }
  if highest < 0i { return 0u; }
  let shift = u32(max(16i, highest - 7i));
  let word = shift / 32u;
  let offset = shift % 32u;
  var top = magnitude.words[word] >> offset;
  if offset != 0u && word + 1u < 10u { top |= magnitude.words[word + 1u] << (32u - offset); }
  let guard_index = shift - 1u;
  let guard_word = guard_index / 32u;
  let guard_offset = guard_index % 32u;
  let guard = (magnitude.words[guard_word] >> guard_offset) & 1u;
  var sticky = 0u;
  for (var below = 0u; below < guard_word; below++) { sticky |= magnitude.words[below]; }
  if guard_offset != 0u { sticky |= magnitude.words[guard_word] & ((1u << guard_offset) - 1u); }
  if guard != 0u && (sticky != 0u || (top & 1u) != 0u) { top += 1u; }
  let encoded = min(0x7f80u, ((shift - 16u) << 7u) + top);
  return sign | encoded;
}
`;

export function createBfloatSumSource(layout: LinearDispatchLayout): string {
  return createWideSumSource(layout, {
    source: WEBGPU_EXACT_SUM_ARITHMETIC_SOURCE + PACKED16_LANE_SOURCE + BFLOAT_SUM_ROUNDING,
    decodeInput: "decode(packed16_lane(input[index / 2u], index) << 16u)",
    roundOutput: "rounded_bfloat",
  });
}
