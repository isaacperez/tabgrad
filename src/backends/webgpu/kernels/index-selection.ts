import { invocationEntry, type LinearDispatchLayout } from "../linear-dispatch.js";

export const INDEX_SELECTION_WORKGROUP_SIZE = 64;
export const INDEX_SELECTION_PARAMETERS_BYTES = 32;
export const INDEX_SELECTION_VALID = 0xffff_ffff;

export function indexSelectionSource(dataWords: 1 | 2, indexWords: 1 | 2, layout: LinearDispatchLayout): string {
  const entry = invocationEntry(layout, INDEX_SELECTION_WORKGROUP_SIZE);
  const readHigh = indexWords === 1 ? "select(0u, 0xffffffffu, (low & 0x80000000u) != 0u)"
    : "indices[index_position * 2u + 1u]";
  const copy = dataWords === 1 ? "output[element] = source[address];" : `
  output[element * 2u] = source[address * 2u];
  output[element * 2u + 1u] = source[address * 2u + 1u];`;
  return `
struct Parameters {
  bound_low: u32, bound_high: u32, count: u32, inner: u32,
  elements: u32, computation: u32, unused0: u32, unused1: u32,
}
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read> indices: array<u32>;
@group(0) @binding(2) var<storage, read_write> output: array<u32>;
@group(0) @binding(3) var<storage, read_write> status: atomic<u32>;
@group(0) @binding(4) var<uniform> parameters: Parameters;

@compute @workgroup_size(${INDEX_SELECTION_WORKGROUP_SIZE})
${entry.signature}
  let element = ${entry.index};
  let bounds_only = parameters.elements == 0u;
  if element >= select(parameters.elements, parameters.count, bounds_only) { return; }
  var index_position = element;
  if !bounds_only { index_position = (element / parameters.inner) % parameters.count; }
  let low = indices[index_position * ${indexWords}u];
  let high = ${readHigh};
  if (high & 0x80000000u) != 0u || high > parameters.bound_high
    || (high == parameters.bound_high && low >= parameters.bound_low) {
    if bounds_only || (element / parameters.inner < parameters.count && element % parameters.inner == 0u) {
      atomicMin(&status, parameters.computation);
    }
    return;
  }
  if bounds_only { return; }
  let block = (element / parameters.inner) / parameters.count;
  let address = (block * parameters.bound_low + low) * parameters.inner + element % parameters.inner;
  ${copy}
}
`;
}
