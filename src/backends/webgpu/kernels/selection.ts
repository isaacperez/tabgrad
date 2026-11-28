import { invocationEntry, type LinearDispatchLayout } from "../linear-dispatch.js";
import { pointwiseElementIndices, WEBGPU_POINTWISE_WORKGROUP_SIZE } from "./broadcast.js";
import { BOOL_VALUES_PER_WORD } from "./packed-words.js";

function selectionSource(broadcast: boolean, layout: LinearDispatchLayout, whenTrue?: boolean): string {
  const entry = invocationEntry(layout, WEBGPU_POINTWISE_WORKGROUP_SIZE);
  const forward = whenTrue === undefined;
  const arity = forward ? 3 : 2;
  const choose = forward
    ? "select(right[indices.z], left[indices.y], mask_is_true)"
    : `select(0u, left[indices.y], ${whenTrue ? "mask_is_true" : "!mask_is_true"})`;
  return `
@group(0) @binding(0) var<storage, read> mask: array<u32>;
@group(0) @binding(1) var<storage, read> left: array<u32>;
${forward ? "@group(0) @binding(2) var<storage, read> right: array<u32>;" : ""}
@group(0) @binding(${arity}) var<storage, read_write> output: array<u32>;
@group(0) @binding(${arity + 1}) var<storage, read> geometry: array<u32>;

@compute @workgroup_size(${WEBGPU_POINTWISE_WORKGROUP_SIZE})
${entry.signature}
  let index = ${entry.index};
  if index >= geometry[1] { return; }
  ${pointwiseElementIndices(broadcast, arity)}
  let lane = indices.x % ${BOOL_VALUES_PER_WORD}u;
  let mask_is_true = ((mask[indices.x / ${BOOL_VALUES_PER_WORD}u] >> (lane * 8u)) & 0xffu) != 0u;
  output[index] = ${choose};
}
`;
}

export function createSelectionSource(broadcast: boolean, layout: LinearDispatchLayout): string {
  return selectionSource(broadcast, layout);
}

export function createMaskGradientSource(whenTrue: boolean): typeof createSelectionSource {
  return (broadcast, layout) => selectionSource(broadcast, layout, whenTrue);
}
