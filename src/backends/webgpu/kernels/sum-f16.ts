import { cooperativeEntry, type LinearDispatchLayout } from "../linear-dispatch.js";

export const WEBGPU_HALF_SUM_WORKGROUP_SIZE = 64;
export const WEBGPU_HALF_SUM_PARTIAL_BYTES = 16;
export const WEBGPU_HALF_SUM_GROUP_ELEMENTS = 2 * WEBGPU_HALF_SUM_WORKGROUP_SIZE;

export function createHalfSumSource(layout: LinearDispatchLayout): string {
  const entry = cooperativeEntry(layout, WEBGPU_HALF_SUM_GROUP_ELEMENTS, "parameters.count");
  return `
struct Parameters { count: u32, final_stage: u32, partial_input: u32, padding: u32 }
@group(0) @binding(0) var<storage, read> input: array<u32>;
@group(0) @binding(1) var<storage, read_write> output: array<u32>;
@group(0) @binding(2) var<uniform> parameters: Parameters;
// Low, middle and high words of a signed 96-bit total in units of 2^-24,
// followed by the positive infinity, negative infinity and NaN flags.
var<workgroup> partials: array<vec4u, ${WEBGPU_HALF_SUM_WORKGROUP_SIZE}>;

fn add96(a: vec3u, b: vec3u) -> vec3u {
  let low = a.x + b.x;
  let middle = a.y + b.y;
  let with_carry = middle + u32(low < a.x);
  let carry = u32(middle < a.y || with_carry < middle);
  return vec3u(low, with_carry, a.z + b.z + carry);
}

fn negate96(value: vec3u) -> vec3u {
  return add96(~value, vec3u(1u, 0u, 0u));
}

fn merge(a: vec4u, b: vec4u) -> vec4u {
  return vec4u(add96(a.xyz, b.xyz), a.w | b.w);
}

fn decode(bits: u32) -> vec4u {
  let exponent = (bits >> 10u) & 31u;
  let fraction = bits & 1023u;
  let negative = (bits & 0x8000u) != 0u;
  if exponent == 31u {
    let flags = select(select(1u, 2u, negative), 4u, fraction != 0u);
    return vec4u(0u, 0u, 0u, flags);
  }
  let significand = fraction + select(0u, 1024u, exponent != 0u);
  let shift = max(1u, exponent) - 1u;
  var units = vec3u(significand << shift, 0u, 0u);
  if shift != 0u { units.y = significand >> (32u - shift); }
  return vec4u(select(units, negate96(units), negative), 0u);
}

fn rounded(total: vec4u) -> u32 {
  if total.w == 1u { return 0x7c00u; }
  if total.w == 2u { return 0xfc00u; }
  if total.w != 0u { return 0x7e00u; }
  let negative = (total.z & 0x80000000u) != 0u;
  let sign = select(0u, 0x8000u, negative);
  let magnitude = select(total.xyz, negate96(total.xyz), negative);
  // 65520 in units of 2^-24 is 0xfff0000000, the overflow tie.
  if magnitude.z != 0u || magnitude.y > 0xffu || (magnitude.y == 0xffu && magnitude.x >= 0xf0000000u) {
    return sign | 0x7c00u;
  }
  if magnitude.y == 0u && magnitude.x < 1024u { return sign | magnitude.x; }
  let leading = select(firstLeadingBit(magnitude.x), 32u + firstLeadingBit(magnitude.y), magnitude.y != 0u);
  let shift = leading - 10u;
  if shift == 0u { return sign | magnitude.x; }
  let significand = (magnitude.x >> shift) | (magnitude.y << (32u - shift));
  let remainder = magnitude.x & ((1u << shift) - 1u);
  let midpoint = 1u << (shift - 1u);
  let increment = u32(remainder > midpoint || (remainder == midpoint && (significand & 1u) != 0u));
  return sign | ((shift << 10u) + significand + increment);
}

fn load_partial(index: u32) -> vec4u {
  if index >= parameters.count { return vec4u(0u); }
  if parameters.partial_input == 0u {
    let packed = input[index >> 1u];
    return decode((packed >> ((index & 1u) * 16u)) & 0xffffu);
  }
  let word = index * 4u;
  return vec4u(input[word], input[word + 1u], input[word + 2u], input[word + 3u]);
}

@compute @workgroup_size(${WEBGPU_HALF_SUM_WORKGROUP_SIZE})
${entry.signature}${entry.guard}
  let index = ${entry.index} * ${WEBGPU_HALF_SUM_GROUP_ELEMENTS}u + lane * 2u;
  partials[lane] = merge(load_partial(index), load_partial(index + 1u));
  for (var stride = ${WEBGPU_HALF_SUM_WORKGROUP_SIZE / 2}u; stride > 0u; stride >>= 1u) {
    workgroupBarrier();
    if lane < stride { partials[lane] = merge(partials[lane], partials[lane + stride]); }
  }
  if lane == 0u {
    if parameters.final_stage != 0u { output[${entry.index}] = rounded(partials[0]); }
    else {
      let word = ${entry.index} * 4u;
      let total = partials[0];
      output[word] = total.x;
      output[word + 1u] = total.y;
      output[word + 2u] = total.z;
      output[word + 3u] = total.w;
    }
  }
}
`;
}
