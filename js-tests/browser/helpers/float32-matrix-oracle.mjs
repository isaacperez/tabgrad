import { exactCoefficientAddition } from "./float32-coefficient-oracle.mjs";

export function exactMatrixProduct(left, right, [m, k, n], flags = 0) {
  const output = new Uint32Array(m * n);
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) {
    let accumulator = 0;
    for (let t = 0; t < k; t++) {
      accumulator = exactCoefficientAddition(accumulator,
        left[flags & 1 ? t * m + i : i * k + t], right[flags & 2 ? j * k + t : t * n + j]);
    }
    output[i * n + j] = accumulator;
  }
  return output;
}

const word = value => new Uint32Array(new Float32Array([value]).buffer)[0];
const edgeWords = [0, 0x80000000, 1, 0x80000001, 0x7fffff, 0x807fffff, 0x800000, 0x80800000,
  word(1), word(-1), word(1.5), 0x3f800001, 0x7f7fffff, 0xff7fffff, 0x7f800000, 0xff800000,
  0x7fc00000, 0xffc12345];

function generatedWords(length, payload, seed) {
  const result = new Uint32Array(length);
  for (let index = 0; index < length; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    result[index] = payload === "edges" ? edgeWords[seed % edgeWords.length]
      : payload === "dyadic" ? word((seed % 33 - 16) / 8) : seed;
  }
  return result;
}

/** Geometry and payload vary independently; all four physical orientations share an oracle. */
export function matrixCases() {
  const result = [];
  const shapes = [[0, 7, 4], [3, 0, 4], [3, 7, 0], [1, 1, 1], [2, 3, 2], [3, 7, 4],
    ...[3, 4, 5, 17, 33, 63, 64, 65, 127, 128, 129].map(k => [1, k, 3]),
    ...[1, 2, 3, 4, 5, 17, 63, 64, 65].map(n => [2, 3, n]),
    ...[1, 2, 17, 33, 65].map(m => [m, 5, 2])];
  for (const shape of shapes) for (const payload of ["dyadic", "edges", "words"]) for (const flags of [0, 1, 2, 3]) {
    const [m, k, n] = shape;
    const left = generatedWords(m * k, payload, 0x273274);
    const right = generatedWords(k * n, payload, 0x5274273);
    result.push({ name: `${shape.join("x")}/${payload}/${flags}`, shape, flags, left, right,
      expected: exactMatrixProduct(left, right, shape, flags) });
  }
  // Valid native calls with intentional different associations: these are exact
  // Tabgrad conformance controls, not fixtures to omit under a relative tolerance.
  for (const [left, right, expected] of [
    [[word(50.29061508178711), word(502.9061279296875)], [word(1), word(-0.1)], 0x35ce9e68],
    [[0x7f7fffff, 0xff7fffff], [word(2), word(2)], 0x7f800000],
    [[0x7f7fffff, 0x7f7fffff, 0xff7fffff, 0xff7fffff], [word(1), word(1), word(1), word(1)], 0x7f800000],
  ]) result.push({ name: `association-${result.length}`, shape: [1, left.length, 1], flags: 0,
    left: new Uint32Array(left), right: new Uint32Array(right), expected: new Uint32Array([expected]) });
  // A combined dense shape crosses both row/column and contraction boundaries.
  // Sixteen independent constant dots suffice; every output position is checked.
  const [m, k, n] = [65, 129, 65];
  const left = new Uint32Array(m * k), right = new Uint32Array(k * n);
  for (let row = 0; row < m; row++) left.fill(word((row % 4 + 1) / 8), row * k, (row + 1) * k);
  for (let t = 0; t < k; t++) for (let column = 0; column < n; column++) right[t * n + column] = word((column % 4 - 2) / 8);
  const dots = Array.from({ length: 16 }, (_, index) => {
    let value = 0;
    for (let t = 0; t < k; t++) value = exactCoefficientAddition(value, word((Math.floor(index / 4) + 1) / 8), word((index % 4 - 2) / 8));
    return value;
  });
  const expected = Uint32Array.from({ length: m * n }, (_, index) => dots[(Math.floor(index / n) % 4) * 4 + index % n % 4]);
  result.push({ name: "dense-combined-65x129x65", shape: [m, k, n], flags: 0, left, right, expected });
  return result;
}

export function assertMatrixWords(actual, expected, assert) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index++) {
    const want = expected[index], got = actual[index];
    if ((want & 0x7fffffff) > 0x7f800000) assert.ok((got & 0x7fffffff) > 0x7f800000, `NaN category at ${index}`);
    else assert.equal(got, want, `stored word ${index}`);
  }
}
