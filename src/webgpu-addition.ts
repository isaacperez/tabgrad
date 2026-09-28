/** Binary32 addition via unsigned arithmetic: no WGSL floating-point relaxation. */
export const WEBGPU_ADDITION_SOURCE = `
fn shift_right_jam(value: u32, distance: u32) -> u32 {
  if distance == 0u { return value; }
  if distance >= 32u { return select(0u, 1u, value != 0u); }
  return (value >> distance) | select(0u, 1u, (value << (32u - distance)) != 0u);
}

fn add_binary32(left: u32, right: u32) -> u32 {
  let left_magnitude = left & 0x7fffffffu;
  let right_magnitude = right & 0x7fffffffu;
  if left_magnitude > 0x7f800000u || right_magnitude > 0x7f800000u { return 0x7fc00000u; }
  if left_magnitude == 0x7f800000u {
    if right_magnitude == 0x7f800000u && ((left ^ right) >> 31u) != 0u { return 0x7fc00000u; }
    return left;
  }
  if right_magnitude == 0x7f800000u { return right; }
  if left_magnitude == 0u && right_magnitude == 0u { return (left & right) & 0x80000000u; }
  // Order magnitudes before subtraction, retaining the larger operand's sign.
  var large = left;
  var small = right;
  if right_magnitude > left_magnitude { large = right; small = left; }
  let sign = large & 0x80000000u;
  var exponent = max((large >> 23u) & 255u, 1u);
  let small_exponent = max((small >> 23u) & 255u, 1u);
  let large_hidden = select(0u, 0x800000u, (large & 0x7f800000u) != 0u);
  let small_hidden = select(0u, 0x800000u, (small & 0x7f800000u) != 0u);
  // Guard, round and sticky bits preserve all information needed for ties-even.
  var significand = ((large & 0x7fffffu) | large_hidden) << 3u;
  let aligned = shift_right_jam(((small & 0x7fffffu) | small_hidden) << 3u, exponent - small_exponent);
  if ((large ^ small) & 0x80000000u) == 0u {
    significand += aligned;
    if significand >= 0x8000000u { significand = shift_right_jam(significand, 1u); exponent += 1u; }
  } else {
    significand -= aligned;
    if significand == 0u { return 0u; }
    while significand < 0x4000000u && exponent > 1u { significand <<= 1u; exponent -= 1u; }
  }
  let remainder = significand & 7u;
  var rounded = significand >> 3u;
  if remainder > 4u || (remainder == 4u && (rounded & 1u) != 0u) { rounded += 1u; }
  if rounded >= 0x1000000u { rounded >>= 1u; exponent += 1u; }
  if exponent >= 255u { return sign | 0x7f800000u; }
  if rounded < 0x800000u { exponent = 0u; }
  return sign | (exponent << 23u) | (rounded & 0x7fffffu);
}

@group(0) @binding(0) var<storage, read> left: array<u32>;
@group(0) @binding(1) var<storage, read> right: array<u32>;
@group(0) @binding(2) var<storage, read_write> output: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) position: vec3<u32>) {
  let index = position.x;
  if index < arrayLength(&output) { output[index] = add_binary32(left[index], right[index]); }
}
`;
