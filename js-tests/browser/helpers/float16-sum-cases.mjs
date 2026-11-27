function halfValue(word) {
  const exponent = (word >>> 10) & 31;
  const fraction = word & 1023;
  const magnitude = exponent === 31 ? (fraction === 0 ? Infinity : NaN)
    : exponent === 0 ? fraction * 2 ** -24 : (1024 + fraction) * 2 ** (exponent - 25);
  return word & 0x8000 ? -magnitude : magnitude;
}

export function halfSumCases() {
  const cases = [
    ["empty", [], 0],
    ["negative zero", [0x8000], 0],
    ["scalar", [0xbc01], 0xbc01],
    ["subnormal cancellation", [0x7bff, 1, 0xfbff], 1],
    ["negative subnormal cancellation", [0x7bff, 0x8001, 0xfbff], 0x8001],
    ["subnormal carry", [0x03ff, 1], 0x0400],
    ["lower even tie", [0x3c00, 0x1000], 0x3c00],
    ["upper even tie", [0x3c01, 0x1000], 0x3c02],
    ["sticky bit", [0x3c00, 0x1000, 1], 0x3c01],
    ["significand carry", [0x3fff, 0x1000], 0x4000],
    ["largest finite", [0x7bff, 0x4b80], 0x7bff],
    ["overflow tie", [0x7bff, 0x4c00], 0x7c00],
    ["negative overflow", [0xfbff, 0xcc00], 0xfc00],
    ["positive infinity", [0x7c00, 0xfbff], 0x7c00],
    ["negative infinity", [0xfc00, 0x7bff], 0xfc00],
    ["opposite infinities", [0x7c00, 0xfc00], 0x7e00],
    ["NaN with infinity", [0x7c00, 0xfe01], 0x7e00],
  ];
  for (const length of [127, 128, 129, 16384, 16385]) {
    const words = new Uint16Array(length);
    const middle = Math.floor(length / 2);
    words.fill(0x7bff, 0, middle - 1);
    words.fill(0xfbff, middle, 2 * middle - 1);
    words[length - 1] = 3;
    cases.push([`opposite partials at ${length}`, words, 3]);
  }
  return cases.map(([name, words, expectedWord]) => ({
    name, words, expectedWord, values: () => Float32Array.from(words, halfValue), expected: halfValue(expectedWord),
  }));
}
