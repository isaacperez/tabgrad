export function halfValue(word) {
  const exponent = (word >>> 10) & 31;
  const fraction = word & 1023;
  const magnitude = exponent === 31 ? (fraction === 0 ? Infinity : NaN)
    : exponent === 0 ? fraction * 2 ** -24 : (1024 + fraction) * 2 ** (exponent - 25);
  return word & 0x8000 ? -magnitude : magnitude;
}
