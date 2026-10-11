/** Scalar derivative expansion shares the elementwise dispatch extent. */
export const WEBGPU_EXPANSION_WORKGROUP_SIZE = 64;

/** Copy stored binary32 bits; WGSL floating-point arithmetic is unnecessary. */
export const WEBGPU_EXPANSION_SOURCE = `
@group(0) @binding(0) var<storage, read> scalar: array<u32>;
@group(0) @binding(1) var<storage, read_write> output: array<u32>;
@compute @workgroup_size(${WEBGPU_EXPANSION_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) position: vec3<u32>) {
  let index = position.x;
  if index < arrayLength(&output) { output[index] = scalar[0]; }
}
`;
