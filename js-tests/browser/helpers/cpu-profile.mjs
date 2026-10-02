// Controlled feature-detection profile, never a numerical-kernel substitute.
// Keep this exact probe aligned with the backend. A changed probe must fail the
// selectedVariant integration assertion rather than silently test another route.
const simdProbe = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
  0x03, 0x02, 0x01, 0x00,
  0x0a, 0x08, 0x01, 0x06, 0x00, 0x41, 0x00, 0xfd, 0x0f, 0x0b,
]);

export function selectCpuProfile(variant) {
  if (variant !== "scalar" && variant !== "simd128") throw new Error(`Unknown CPU profile ${variant}`);
  if (variant === "simd128") return;
  const validate = WebAssembly.validate;
  WebAssembly.validate = (bytes, ...options) => {
    if (bytes instanceof Uint8Array && bytes.length === simdProbe.length
      && bytes.every((byte, index) => byte === simdProbe[index])) return false;
    return validate(bytes, ...options);
  };
}
