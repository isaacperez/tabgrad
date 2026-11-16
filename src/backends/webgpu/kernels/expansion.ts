import { invocationEntry, type LinearDispatchLayout } from "../linear-dispatch.js";
/** Scalar derivative expansion shares the elementwise dispatch extent. */
export const WEBGPU_EXPANSION_WORKGROUP_SIZE = 64;

/** Copy stored binary32 bits; WGSL floating-point arithmetic is unnecessary. */
export function createExpansionSource(layout: LinearDispatchLayout = "linear"): string {
  const entry = invocationEntry(layout, WEBGPU_EXPANSION_WORKGROUP_SIZE);
  return `
@group(0) @binding(0) var<storage, read> scalar: array<u32>;
@group(0) @binding(1) var<storage, read_write> output: array<u32>;
@compute @workgroup_size(${WEBGPU_EXPANSION_WORKGROUP_SIZE})
${entry.signature}
  let index = ${entry.index};
  if index < arrayLength(&output) { output[index] = scalar[0]; }
}
`;
}

export const WEBGPU_EXPANSION_SOURCE = createExpansionSource();
