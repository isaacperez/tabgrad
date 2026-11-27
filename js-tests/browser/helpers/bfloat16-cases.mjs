// Fixed expectations distinguish exact bfloat16 reduction and ordered, separate
// binary32 matrix steps from binary32 double rounding, fused and exact dot sums.
const MAX = 0x7f7f;
const ONE = 0x3f80;
const TWO = 0x4000;

export function bfloatSumCases() {
  const cases = [
    ["empty", [], 0],
    ["negative zero becomes positive", [0x8000, 0x8000], 0],
    ["subnormal carry", [0x007f, 1], 0x0080],
    ["finite overflow", [MAX, MAX], 0x7f80],
    ["negative finite overflow", [0xff7f, 0xff7f], 0xff80],
    ["smallest term survives cancellation", [MAX, 1, 0xff7f], 1],
    ["discarded term tips a midpoint", [ONE, 0x3b80, 1], 0x3f81],
    ["tie rounds to the even upper value", [0x3f81, 0x3b80], 0x3f82],
    ["opposite infinities", [0x7f80, 0xff80], 0x7fc0],
    ["NaN with infinity", [0x7f81, 0x7f80], 0x7fc0],
    ["negative infinity", [MAX, 0xff80], 0xff80],
  ];
  for (const length of [127, 128, 129, 16385]) {
    const words = new Uint16Array(length);
    const pairs = Math.floor((length - 1) / 2);
    words.fill(MAX, 0, pairs);
    words.fill(0xff7f, pairs, 2 * pairs);
    words[length - 1] = 3;
    cases.push([`partition boundary at ${length}`, words, 3]);
  }
  return cases.map(([name, words, expectedWord]) => ({ name, words, expectedWord }));
}

export function bfloatMatrixCases() {
  const cases = [
    ["zero rows", [0, 1, 1], [], [ONE], []],
    ["zero contraction", [2, 0, 3], [], [], [0, 0, 0, 0, 0, 0]],
    ["odd row packing", [2, 1, 3], [ONE, TWO], [ONE, 0xbf80, TWO],
      [ONE, 0xbf80, TWO, TWO, 0xc000, 0x4080]],
    ["subnormal step distinguishes separated multiply", [1, 3, 1],
      [0x1e00, 0x9a80, 0x1a00], [0x1ec0, 0x1a00, 0x1a00], [1]],
    ["overflow rounds before addition", [1, 2, 1], [MAX, 0xff7f], [TWO, TWO], [0x7fc0]],
    ["contraction order", [1, 3, 1], [MAX, ONE, 0xff7f], [ONE, ONE, ONE], [0]],
    ["terminal underflow retains negative sign", [1, 1, 1], [0x8001], [0x3e80], [0x8000]],
    ["infinite operand times zero", [1, 1, 1], [0x7f80], [0], [0x7fc0]],
    ["odd output spans the constrained GPU grid", [17, 7, 129],
      new Uint16Array(17 * 7).fill(ONE), new Uint16Array(7 * 129).fill(TWO),
      new Uint16Array(17 * 129).fill(0x4160)],
  ];
  return cases.map(([name, shape, left, right, expected]) => ({ name, shape, flags: 0, left, right, expected }));
}
