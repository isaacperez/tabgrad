const numeric = new Float32Array(1);
const binary32 = new Uint32Array(numeric.buffer);

export function encodeBfloat16(value: number): number {
  numeric[0] = value;
  const bits = binary32[0]!;
  if ((bits & 0x7fff_ffff) > 0x7f80_0000) return 0x7fc0;
  const upper = bits >>> 16;
  const lower = bits & 0xffff;
  return upper + Number(lower > 0x8000 || (lower === 0x8000 && (upper & 1) !== 0));
}

export function bfloat16ObservationBits(word: number): number {
  return word << 16;
}
