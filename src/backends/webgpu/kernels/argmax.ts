import { cooperativeEntry, type LinearDispatchLayout } from "../linear-dispatch.js";

export const ARGMAX_WORKGROUP_SIZE = 64;
export const ARGMAX_GROUP_TERMS = 256;
export const ARGMAX_PARTIAL_BYTES = 12;
export const ARGMAX_PARAMETERS_BYTES = 32;

const floatOrder = `
fn float_key(word: u32) -> u32 {
  if (word == 0x80000000u) { return 0x80000000u; }
  if ((word & 0x7fffffffu) > 0x7f800000u) { return 0xffffffffu; }
  return select(word ^ 0x80000000u, ~word, (word & 0x80000000u) != 0u);
}
fn compare(a: Candidate, b: Candidate) -> i32 {
  return ordering(float_key(a.low), float_key(b.low));
}
`;

const int32Order = `
fn compare(a: Candidate, b: Candidate) -> i32 {
  return ordering(a.low ^ 0x80000000u, b.low ^ 0x80000000u);
}
`;

const int64Order = `
fn compare(a: Candidate, b: Candidate) -> i32 {
  if (a.high != b.high) { return ordering(a.high ^ 0x80000000u, b.high ^ 0x80000000u); }
  return ordering(a.low, b.low);
}
`;

const comparisonByType = { float32: floatOrder, int32: int32Order, int64: int64Order };

export function argmaxSource(dtype: keyof typeof comparisonByType, layout: LinearDispatchLayout): string {
  const entry = cooperativeEntry(layout, 1, "parameters.workgroups");
  const load = dtype === "int64" ? "Candidate(source[2u * address], source[2u * address + 1u], term)"
    : "Candidate(source[address], 0u, term)";
  return `
struct Candidate { low: u32, high: u32, index: u32 }
struct Parameters {
  count: u32, inner: u32, chunks: u32, workgroups: u32,
  partial_input: u32, final_stage: u32, unused0: u32, unused1: u32,
}
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> output: array<u32>;
@group(0) @binding(2) var<uniform> parameters: Parameters;
var<workgroup> winners: array<Candidate, ${ARGMAX_WORKGROUP_SIZE}>;
const absent = 0xffffffffu;

fn ordering(a: u32, b: u32) -> i32 {
  return i32(a > b) - i32(a < b);
}
${comparisonByType[dtype]}
fn pick(a: Candidate, b: Candidate) -> Candidate {
  if (b.index == absent) { return a; }
  if (a.index == absent) { return b; }
  let order = compare(a, b);
  if (order < 0 || (order == 0 && b.index < a.index)) { return b; }
  return a;
}

@compute @workgroup_size(${ARGMAX_WORKGROUP_SIZE})
${entry.signature}
  ${entry.guard}
  let group_chunk = ${entry.index};
  let row = group_chunk / parameters.chunks;
  let chunk = group_chunk % parameters.chunks;
  var winner = Candidate(0u, 0u, absent);
  for (var offset = lane; offset < ${ARGMAX_GROUP_TERMS}u; offset += ${ARGMAX_WORKGROUP_SIZE}u) {
    let term = chunk * ${ARGMAX_GROUP_TERMS}u + offset;
    if (term < parameters.count) {
      var candidate: Candidate;
      if (parameters.partial_input == 0u) {
        let address = ((row / parameters.inner) * parameters.count + term) * parameters.inner + row % parameters.inner;
        candidate = ${load};
      } else {
        let address = 3u * (row * parameters.count + term);
        candidate = Candidate(source[address], source[address + 1u], source[address + 2u]);
      }
      winner = pick(winner, candidate);
    }
  }
  winners[lane] = winner;
  for (var stride = ${ARGMAX_WORKGROUP_SIZE / 2}u; stride > 0u; stride /= 2u) {
    workgroupBarrier();
    if (lane < stride) { winners[lane] = pick(winners[lane], winners[lane + stride]); }
  }
  if (lane != 0u) { return; }
  if (parameters.final_stage != 0u) {
    output[row * 2u] = winners[0].index;
    output[row * 2u + 1u] = 0u;
  } else {
    output[group_chunk * 3u] = winners[0].low;
    output[group_chunk * 3u + 1u] = winners[0].high;
    output[group_chunk * 3u + 2u] = winners[0].index;
  }
}
`;
}
