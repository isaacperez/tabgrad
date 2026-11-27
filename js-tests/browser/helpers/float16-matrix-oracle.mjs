import { exactMatrixProduct } from "./float32-matrix-oracle.mjs";
import { halfValue } from "./float16-values.mjs";

function nearestHalf(value) {
  if (Number.isNaN(value)) return 0x7e00;
  const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0;
  const magnitude = Math.abs(value);
  if (magnitude >= 65520) return sign | 0x7c00;
  // Search neighbors without repeating the kernel's exponent/round-bit calculation.
  let low = 0;
  let high = 0x7c00;
  while (high - low > 1) {
    const middle = (low + high) >>> 1;
    if (halfValue(middle) <= magnitude) low = middle;
    else high = middle;
  }
  const below = magnitude - halfValue(low), above = halfValue(high) - magnitude;
  return sign | (above < below || (above === below && (low & 1) !== 0) ? high : low);
}

function halfMatrixCase(name, shape, left, right, flags = 0) {
  const leftWords = Uint16Array.from(left, nearestHalf);
  const rightWords = Uint16Array.from(right, nearestHalf);
  const asBinary32Words = words => new Uint32Array(Float32Array.from(words, halfValue).buffer);
  const wide = exactMatrixProduct(asBinary32Words(leftWords), asBinary32Words(rightWords), shape, flags);
  const expected = Uint16Array.from(new Float32Array(wide.buffer), nearestHalf);
  return { name, shape, flags, left: leftWords, right: rightWords, expected };
}

export function halfMatrixCases() {
  const tiny = 2 ** -24;
  const cases = [
    halfMatrixCase("rectangular odd row", [3, 2, 3], [1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6]),
    halfMatrixCase("zero rows", [0, 3, 2], [], [1, 2, 3, 4, 5, 6]),
    halfMatrixCase("zero contraction", [2, 0, 3], [], []),
    halfMatrixCase("zero columns", [2, 3, 0], [1, 2, 3, 4, 5, 6], []),
    halfMatrixCase("ordered rounding", [1, 3, 1], [4096, 1, -4096], [4096, 1, 4096]),
    halfMatrixCase("reordered cancellation", [1, 3, 1], [4096, -4096, 1], [4096, 4096, 1]),
    halfMatrixCase("terminal negative zero", [1, 1, 3], [-tiny], [0.25, 0.5, 1]),
    halfMatrixCase("terminal nearest even", [1, 2, 2], [1, 1], [1, 1 + 2 ** -10, 2 ** -11, 2 ** -11]),
    halfMatrixCase("finite product before compact overflow", [1, 3, 2], [65504, -65504, tiny], [2, 2, 2, -2, 1, 1]),
    halfMatrixCase("zeros and nonfinites", [2, 2, 3], [0, -0, Infinity, NaN], [Infinity, 2, -3, 4, 5, NaN]),
    halfMatrixCase("both infinity signs", [1, 2, 3], [Infinity, Infinity], [1, -1, 1, -1, -1, 1]),
  ];
  for (const flags of [1, 2, 3]) cases.push(halfMatrixCase("stored orientation " + flags,
    [2, 3, 5], [1, 2, 3, 4, 5, 6], Array.from({ length: 15 }, (_, index) => (index - 7) / 4), flags));
  // 2,193 output elements require 18 groups of 64 packed writers.
  const [m, k, n] = [17, 7, 129];
  const left = Array.from({ length: m * k }, (_, index) => (index % 11 - 5) / 8);
  const right = Array.from({ length: k * n }, (_, index) => (index % 13 - 6) / 16);
  cases.push(halfMatrixCase("packed constrained grid", [m, k, n], left, right));
  return cases;
}
