const bits = value => new Uint32Array(new Float32Array([value]).buffer)[0];

// Independently derived contract sentinels, also consumed by the CPU kernels.
// A residual below a binary64 sum's ULP must break a binary32 midpoint tie.
export const coefficientSentinels = [
  [0, 0x3f800000, 0x3f800000, 0x3f800000],
  [bits(2 ** -24), 0x3f800001, 0x3f800000, 0x3f800002],
  [0, 1, 0x3f000000, 0], [1, 1, 0x3f000000, 2],
  [0x80000000, 0x80000001, 0x3f000000, 0x80000000],
  [0x80000001, 0x80000001, 0x3f000000, 0x80000002],
  [0xff7fffff, 0x7f7fffff, 0x40000000, 0x7f7fffff],
  [0x7f7fffff, 0xff7fffff, 0x40000000, 0xff7fffff],
  [bits(2 ** -80), 0x3f800001, 0x3fc00000, 0x3fc00002],
  [bits(-(2 ** -80)), 0x3f800001, 0x3fc00000, 0x3fc00001],
  [0x80000000, 0, 0xbf800000, 0x80000000], [0, 0, 0xbf800000, 0],
  [bits(-(2 ** -80)), bits(31), bits(1082401 * 2 ** 103), 0x7f7fffff],
  [bits(2 ** -80), bits(-31), bits(1082401 * 2 ** 103), 0xff7fffff],
  [bits(2 ** -80), bits(31), bits(1082401 * 2 ** 103), 0x7f800000],
  [bits(-(2 ** -80)), bits(-31), bits(1082401 * 2 ** 103), 0xff800000],
  [0x7f800000, 0xff7fffff, 0x40000000, 0x7f800000],
  [0xff800000, 0x7f7fffff, 0x40000000, 0xff800000],
];

// Independent exact signed arithmetic in units of 2^-298, without the shader's
// two-word alignment, jam or normalization algorithm.
export function exactCoefficientAddition(parameter, gradient, alpha) {
  const p = parameter & 0x7fffffff, g = gradient & 0x7fffffff, a = alpha & 0x7fffffff;
  const sign = (gradient ^ alpha) & 0x80000000;
  if (p > 0x7f800000 || g > 0x7f800000 || a > 0x7f800000) return 0x7fc00000;
  if (g === 0x7f800000 || a === 0x7f800000) {
    if (g === 0 || a === 0 || (p === 0x7f800000 && ((parameter ^ sign) & 0x80000000) !== 0)) return 0x7fc00000;
    return (sign | 0x7f800000) >>> 0;
  }
  if (p === 0x7f800000) return parameter;
  const exact = integerValue(parameter) * 2n ** 149n + integerValue(gradient) * integerValue(alpha);
  if (exact === 0n) return p === 0 && (g === 0 || a === 0) ? (parameter & sign) >>> 0 : 0;
  const resultSign = exact < 0n ? 0x80000000 : 0;
  const absolute = exact < 0n ? -exact : exact;
  let shift = Math.max(149, absolute.toString(2).length - 24);
  const spacing = 2n ** BigInt(shift);
  let quotient = absolute / spacing;
  const remainder = absolute % spacing;
  if (2n * remainder > spacing || (2n * remainder === spacing && quotient % 2n === 1n)) quotient++;
  if (quotient >= 0x1000000n) { quotient /= 2n; shift++; }
  const exponent = quotient < 0x800000n ? 0 : shift - 148;
  if (exponent >= 255) return (resultSign | 0x7f800000) >>> 0;
  return (resultSign | (exponent << 23) | (Number(quotient) & 0x7fffff)) >>> 0;
}

function integerValue(word) {
  const exponent = (word >>> 23) & 255;
  const magnitude = BigInt((word & 0x7fffff) + (exponent ? 0x800000 : 0))
    * 2n ** BigInt(exponent ? exponent - 1 : 0);
  return word >>> 31 ? -magnitude : magnitude;
}

function nextWord(seed) { return (Math.imul(seed, 1664525) + 1013904223) >>> 0; }

function normalWord(exponent, tail, negative) {
  return (((exponent + 127) << 23) | tail | (negative ? 0x80000000 : 0)) >>> 0;
}

/** Uniform-aware production corpus: each group can use one real SGD coefficient. */
export function coefficientTriples() {
  const triples = [...coefficientSentinels.map(row => row.slice(0, 3)),
    [bits(50.29061508178711), bits(502.9061279296875), bits(-0.1)]];
  const edge = [0, 0x80000000, 1, 0x80000001, 0x7fffff, 0x807fffff, 0x800000, 0x80800000,
    0x3f000000, 0xbf000000, 0x3f800000, 0xbf800000, 0x3f800001, 0xbf800001, 0x40000000,
    0xc0000000, 0x7f7fffff, 0xff7fffff, 0x7f800000, 0xff800000, 0x7fc00000, 0xffc12345];
  for (const p of edge) for (const g of edge) for (const a of edge) triples.push([p, g, a]);
  let seed = 0x267270;
  const alphas = [];
  for (let index = 0; index < 32; index++) { seed = nextWord(seed); alphas.push(seed); }
  for (let index = 0; index < 12000; index++) {
    seed = nextWord(seed); const p = seed;
    seed = nextWord(seed); const g = seed;
    triples.push([p, g, alphas[index % alphas.length]]);
  }
  for (let index = 0; index < 4096; index++) {
    seed = nextWord(seed); const g = seed, a = alphas[index % alphas.length];
    triples.push([bits(-Math.fround(new Float32Array(new Uint32Array([g]).buffer)[0]
      * new Float32Array(new Uint32Array([a]).buffer)[0])), g, a]);
  }
  for (const exponent of [-60, 0, 64]) for (const distance of [0, 1, 2, 14, 15, 31, 32, 33, 38, 39, 61, 62, 63, 64, 65]) {
    for (const reverse of [false, true]) for (const gt of [0, 1, 0x3fffff]) for (const pt of [0, 1, 0x7fffff]) {
      for (const at of [0, 1]) for (const ps of [false, true]) for (const gs of [false, true]) {
        triples.push([normalWord(reverse ? exponent : exponent - distance, pt, ps),
          normalWord(reverse ? exponent - distance : exponent, gt, gs), normalWord(0, at, false)]);
      }
    }
  }
  for (const exponent of [-100, -50, 0, 50, 100]) for (const gap of [24, 25, 30, 40, 60, 80, 100, 149]) {
    if (exponent - gap >= -149) for (const ps of [-1, 1]) for (const gs of [false, true]) {
      triples.push([bits(ps * 2 ** (exponent - gap)), normalWord(exponent, 1, gs), bits(1.5)]);
    }
  }
  for (const exponent of [-149, -126, -80, -24, 0, 100]) for (const ps of [-1, 1]) for (const gs of [-1, 1]) {
    triples.push([bits(ps * 2 ** exponent), bits(gs * 31), bits(1082401 * 2 ** 103)]);
  }
  return triples;
}
