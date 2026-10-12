/** Shared exact 24-by-24-bit unsigned product; no floating-point evaluation. */
export const WEBGPU_SIGNIFICAND_PRODUCT_SOURCE = `
// The product has at most 48 bits. Split operands at bit 16 so each partial
// product and the cross-term fit u32; retain the carry from the low word.
// A high part is <=255: cross <=2*255*65535, high_product <=255*255.
// WGSL unsigned arithmetic wraps modulo 2^32; low < low_product detects the
// sole low-word carry. The high word is therefore the exact remaining 16 bits.
fn significand_product(left: u32, right: u32) -> vec2<u32> {
  let low_product = (left & 65535u) * (right & 65535u);
  let cross = (left >> 16u) * (right & 65535u) + (left & 65535u) * (right >> 16u);
  let low = low_product + (cross << 16u);
  let high = (left >> 16u) * (right >> 16u) + (cross >> 16u) + select(0u, 1u, low < low_product);
  return vec2<u32>(low, high);
}
`;
