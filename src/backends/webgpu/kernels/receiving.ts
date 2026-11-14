import { WEBGPU_EXACT_SUM_ARITHMETIC_SOURCE, WEBGPU_SUM_GROUP_ELEMENTS, WEBGPU_SUM_WORKGROUP_SIZE } from "./sum.js";

export const WEBGPU_RECEIVING_UNIFORM_BYTES = 32;

/** One group/chunk per workgroup; later stages merge the same exact partials. */
export const WEBGPU_RECEIVING_SOURCE = `${WEBGPU_EXACT_SUM_ARITHMETIC_SOURCE}
struct Parameters { count: u32, chunks: u32, terms: u32, groups: u32, partial_input: u32, final_stage: u32, window_base: u32, padding: u32 }
@group(0) @binding(0) var<storage, read> input: array<u32>;
@group(0) @binding(1) var<storage, read_write> output: array<u32>;
@group(0) @binding(2) var<storage, read> geometry: array<u32>;
@group(0) @binding(3) var<uniform> parameters: Parameters;
var<workgroup> partials: array<Accumulator, ${WEBGPU_SUM_WORKGROUP_SIZE}>;

fn project(index: u32, start: u32, rank: u32) -> u32 {
  var remaining = index;
  var offset = 0u;
  for (var axis = rank; axis > 0u; axis--) {
    let base = start + (axis - 1u) * 2u;
    offset += (remaining % geometry[base]) * geometry[base + 1u];
    remaining /= geometry[base];
  }
  return offset;
}

fn load(receiver: u32, term: u32) -> Accumulator {
  var value: Accumulator;
  if term >= parameters.count { return value; }
  if parameters.partial_input != 0u {
    let base = (receiver * parameters.count + term) * 11u;
    for (var word = 0u; word < 10u; word++) { value.words[word] = input[base + word]; }
    value.flags = input[base + 10u];
    return value;
  }
  let base = project(receiver, 2u, geometry[0]);
  let offset = project(term, 2u + 2u * geometry[0], geometry[1]);
  return decode(input[base + offset]);
}

@compute @workgroup_size(${WEBGPU_SUM_WORKGROUP_SIZE})
fn main(@builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) workgroup: vec3<u32>) {
  let work = parameters.window_base + workgroup.x;
  let receiver = work / parameters.chunks;
  let chunk = work % parameters.chunks;
  let index = chunk * ${WEBGPU_SUM_GROUP_ELEMENTS}u + lane * 2u;
  partials[lane] = merge(load(receiver, index), load(receiver, index + 1u));
  for (var stride = ${WEBGPU_SUM_WORKGROUP_SIZE / 2}u; stride > 0u; stride >>= 1u) {
    workgroupBarrier();
    if lane < stride { partials[lane] = merge(partials[lane], partials[lane + stride]); }
  }
  if lane == 0u {
    if parameters.final_stage != 0u { output[receiver] = rounded(partials[0]); }
    else {
      for (var word = 0u; word < 10u; word++) { output[work * 11u + word] = partials[0].words[word]; }
      output[work * 11u + 10u] = partials[0].flags;
    }
  }
}
`;
