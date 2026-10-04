/** Physical representation and partition; never a logical tensor dtype. */
export const WEBGPU_SUM_WORKGROUP_SIZE = 64;
export const WEBGPU_SUM_GROUP_ELEMENTS = 2 * WEBGPU_SUM_WORKGROUP_SIZE;
export const WEBGPU_SUM_PARTIAL_BYTES = 44;
export const WEBGPU_SUM_WORKGROUP_BYTES = WEBGPU_SUM_PARTIAL_BYTES * WEBGPU_SUM_WORKGROUP_SIZE;

/** Exact signed coefficients of 2^-149, with one terminal binary32 rounding.
 * A finite coefficient needs <277 magnitude bits. Every subset of a u32
 * input count needs <309, so ten two's-complement words cannot overflow.
 * Flags describe explicit input specials, independently of finite overflow.
 */
export const WEBGPU_SUM_SOURCE = `
struct Accumulator { words: array<u32, 10>, flags: u32 }
struct Parameters { count: u32, final_stage: u32, partial_input: u32, padding: u32 }
@group(0) @binding(0) var<storage, read> input: array<u32>;
@group(0) @binding(1) var<storage, read_write> output: array<u32>;
@group(0) @binding(2) var<uniform> parameters: Parameters;
var<workgroup> partials: array<Accumulator, ${WEBGPU_SUM_WORKGROUP_SIZE}>;

fn negate(value: Accumulator) -> Accumulator {
  var result = value;
  var carry = 1u;
  for (var word = 0u; word < 10u; word++) {
    result.words[word] = ~value.words[word] + carry;
    carry = select(0u, 1u, carry != 0u && result.words[word] == 0u);
  }
  return result;
}

fn merge(left: Accumulator, right: Accumulator) -> Accumulator {
  var result: Accumulator;
  var carry = 0u;
  for (var word = 0u; word < 10u; word++) {
    let sum = left.words[word] + right.words[word];
    let with_carry = sum + carry;
    result.words[word] = with_carry;
    carry = select(0u, 1u, sum < left.words[word] || with_carry < sum);
  }
  result.flags = left.flags | right.flags;
  return result;
}

fn decode(bits: u32) -> Accumulator {
  var result: Accumulator;
  let exponent = (bits >> 23u) & 255u;
  let fraction = bits & 0x7fffffu;
  if exponent == 255u {
    if fraction != 0u { result.flags = 1u; }
    else { result.flags = select(2u, 4u, (bits >> 31u) != 0u); }
    return result;
  }
  let significand = fraction | select(0u, 0x800000u, exponent != 0u);
  let shift = select(0u, exponent - 1u, exponent != 0u);
  let word = shift / 32u;
  let offset = shift % 32u;
  result.words[word] = significand << offset;
  if offset != 0u { result.words[word + 1u] = significand >> (32u - offset); }
  if (bits >> 31u) != 0u { result = negate(result); }
  return result;
}

fn load_partial(index: u32) -> Accumulator {
  var result: Accumulator;
  if index >= parameters.count { return result; }
  if parameters.partial_input == 0u { return decode(input[index]); }
  for (var word = 0u; word < 10u; word++) { result.words[word] = input[index * 11u + word]; }
  result.flags = input[index * 11u + 10u];
  return result;
}

fn rounded(value: Accumulator) -> u32 {
  if (value.flags & 1u) != 0u || (value.flags & 6u) == 6u { return 0x7fc00000u; }
  if (value.flags & 2u) != 0u { return 0x7f800000u; }
  if (value.flags & 4u) != 0u { return 0xff800000u; }
  let sign = value.words[9] & 0x80000000u;
  var magnitude = value;
  if sign != 0u { magnitude = negate(magnitude); }
  var highest = -1i;
  for (var word = 0u; word < 10u; word++) {
    if magnitude.words[word] != 0u {
      highest = i32(32u * word + 31u - countLeadingZeros(magnitude.words[word]));
    }
  }
  // Exact zero is always positive; subnormal totals are exactly representable.
  if highest < 0i { return 0u; }
  if highest < 23i { return sign | magnitude.words[0]; }
  var high = u32(highest);
  let shift = high - 23u;
  let word = shift / 32u;
  let offset = shift % 32u;
  var top = magnitude.words[word] >> offset;
  if offset != 0u && word + 1u < 10u { top |= magnitude.words[word + 1u] << (32u - offset); }
  if shift != 0u {
    let guard_index = shift - 1u;
    let guard_word = guard_index / 32u;
    let guard_offset = guard_index % 32u;
    let guard = (magnitude.words[guard_word] >> guard_offset) & 1u;
    var sticky = 0u;
    for (var below = 0u; below < guard_word; below++) { sticky |= magnitude.words[below]; }
    if guard_offset != 0u { sticky |= magnitude.words[guard_word] & ((1u << guard_offset) - 1u); }
    if guard != 0u && (sticky != 0u || (top & 1u) != 0u) { top++; }
  }
  if top == 0x1000000u { top >>= 1u; high++; }
  let exponent = high - 22u;
  if exponent >= 255u { return sign | 0x7f800000u; }
  return sign | (exponent << 23u) | (top & 0x7fffffu);
}

@compute @workgroup_size(${WEBGPU_SUM_WORKGROUP_SIZE})
fn main(@builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3<u32>) {
  let index = group.x * ${WEBGPU_SUM_GROUP_ELEMENTS}u + lane * 2u;
  partials[lane] = merge(load_partial(index), load_partial(index + 1u));
  for (var stride = ${WEBGPU_SUM_WORKGROUP_SIZE / 2}u; stride > 0u; stride >>= 1u) {
    workgroupBarrier();
    if lane < stride { partials[lane] = merge(partials[lane], partials[lane + stride]); }
  }
  if lane == 0u {
    if parameters.final_stage != 0u { output[group.x] = rounded(partials[0]); }
    else {
      for (var word = 0u; word < 10u; word++) { output[group.x * 11u + word] = partials[0].words[word]; }
      output[group.x * 11u + 10u] = partials[0].flags;
    }
  }
}
`;
