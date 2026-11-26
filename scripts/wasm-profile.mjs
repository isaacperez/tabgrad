/** Producer profile; loader compatibility and raw-ABI tests verify this contract. */
export const wasmProfile = Object.freeze({
  initialPages: 32,
  maximumPages: 4096,
  alignment: 16,
});

export const wasmPageBytes = 65_536;
