import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runBrowserPage, startBrowserServer } from "./browser-harness.mjs";
import { compactArithmeticCases } from "../js-tests/browser/helpers/compact-float-cases.mjs";

const page = "dtype/conformance.html";
const assets = ["dtype/conformance.mjs", "dtype/python-worker.mjs", "dtype/gpu-device.mjs", "dtype/restrict-gpu.mjs",
  "helpers/compact-float-cases.mjs", "helpers/compact-float-oracle.json", "helpers/cpu-profile.mjs", "helpers/gpu-dispatch-cases.mjs",
  "helpers/bfloat16-cases.mjs", "helpers/float16-values.mjs", "helpers/float16-sum-cases.mjs", "helpers/float16-matrix-oracle.mjs",
  "helpers/float32-addition-oracle.mjs", "helpers/float32-multiplication-oracle.mjs", "helpers/float32-coefficient-oracle.mjs", "helpers/float32-matrix-oracle.mjs"];

const binary16 = Object.freeze({ dtype: "float16", fractionBits: 10 });
const bfloat16 = Object.freeze({ dtype: "bfloat16", fractionBits: 7 });
const runtimeProfiles = Object.freeze([binary16, bfloat16]);

export async function runPublicDTypeConformance(options) {
  for (const profile of runtimeProfiles) await runDTypeConformance({ ...options, profile });
}

export function validateCompactFloatOracle(profile, oracle) {
  assert.match(profile.dtype, /^[a-z][a-z0-9_]*$/);
  assert.ok(Number.isInteger(profile.fractionBits) && profile.fractionBits >= 7 && profile.fractionBits <= 11,
    "The corpus requires a packed 16-bit float with 7–11 fraction bits.");
  const { construction, pointwise } = oracle ?? {};
  assert.ok(Array.isArray(construction?.inputs) && Array.isArray(pointwise?.left),
    "The corpus requires construction inputs and pointwise operand words.");
  const count = construction.inputs.length;
  const pairs = pointwise.left.length;
  assert.ok(count > 0 && count % 2 === 0 && pairs > 0);
  assert.ok(construction.inputs.every(value => (Number.isFinite(value) && !Object.is(value, -0))
    || ["nan", "inf", "-inf", "-0"].includes(value)),
    "Construction inputs use JSON numbers and explicit nonfinite or signed-zero tokens.");
  for (const [words, size] of [[construction.words, count],
    ...["left", "right", "add", "mul", "mulThenAdd"].map(name => [pointwise[name], pairs])]) {
    assert.ok(Array.isArray(words) && words.length === size
      && words.every(value => Number.isInteger(value) && value >= 0 && value <= 0xffff),
    "Oracle arrays must contain matching 16-bit words.");
  }
  if (profile === binary16) assert.deepEqual([count, pairs], [992, 8976]);
  if (profile === bfloat16) assert.deepEqual([count, pairs], [20, 836]);
  return oracle;
}

/** Source and installed consumers share full-output and resource assertions. */
export async function runDTypeConformance({ browser, executable, version, language, device,
  distributionDirectory, reportNote, profile = binary16, variant }) {
  assert.ok(device === "cpu" || device === "webgpu");
  assert.ok(language === "javascript" || language === "python");
  assert.ok(variant === undefined || (device === "cpu" && ["scalar", "simd128"].includes(variant)));
  const { dtype, fractionBits } = profile;
  const arithmetic = runtimeProfiles.includes(profile) ? dtype : "";
  const oracle = validateCompactFloatOracle(profile, arithmetic
    ? JSON.parse(await readFile(new URL(`../js-tests/fixtures/${dtype}-oracle.json`, import.meta.url), "utf8")) : profile.oracle);
  const bytes = Buffer.from(JSON.stringify(oracle));
  const { sums, matrices } = compactArithmeticCases(arithmetic);
  const reads = [];
  const server = await startBrowserServer([page], { assets, crossOriginIsolation: device === "webgpu",
    ...(distributionDirectory === undefined ? {} : { distributionDirectory }),
    readAsset(path) {
      reads.push(String(path));
      return String(path).endsWith("/helpers/compact-float-oracle.json") ? bytes : readFile(path);
    },
  });
  const observations = [];
  try {
    for (const grid of device === "webgpu" ? [false, true] : [false]) {
      await runBrowserPage({ server, browser, executable, version, page, parameters: { language, device, dtype, fractionBits: String(fractionBits), grid: String(grid), arithmetic,
        ...(variant === undefined ? {} : { variant }) }, reportNote,
        validateResult(result) {
          assert.equal(result.ok, true, JSON.stringify(result.error));
          assert.equal(result.language, language); assert.equal(result.device, device);
          assert.equal(result.grid, grid); assert.equal(result.dtype, dtype);
          assert.deepEqual(result.cases, { construction: oracle.construction.words.length, pointwise: oracle.pointwise.left.length,
            broadcasts: 10, oddDense: 2, channelCompositions: 1, totalSums: sums.length, matrixProducts: matrices.length });
          for (const name of ["liveTensorHandles", "liveTensorValues", "liveAllocationBytes", "liveRequestLeases"]) {
            assert.equal(result.final[name], 0, name);
          }
          if (language === "python") {
            assert.equal(result.pyodide, "314.0.6"); assert.equal(result.worker, true); assert.equal(result.jspiAvailable, false);
          }
          if (device === "webgpu") {
            assert.equal(result.beforeClose.webgpu.adapter.isFallbackAdapter, false);
            if (grid) assert.equal(result.beforeClose.webgpu.limits.maxComputeWorkgroupsPerDimension, 17);
            assert.ok(result.beforeClose.webgpu.kernelCalls > 0, "Selected GPU performs the numerical work.");
            assert.equal(result.beforeClose.kernelCalls, 0, "Selected GPU does not fall back to CPU kernels.");
            assert.ok(result.beforeClose.webgpu.peakOwnedBufferBytes <= 128 * 1024 ** 2);
            for (const name of ["ownedBufferBytes", "pendingSubmissions", "unknownCompletionBytes"]) {
              assert.equal(result.final.webgpu[name], 0, name);
            }
          } else {
            assert.equal(result.beforeClose.webgpu, null);
            assert.ok(result.beforeClose.kernelCalls > 0);
            if (variant !== undefined) assert.equal(result.beforeClose.selectedVariant, variant);
          }
          observations.push({ browser: browser.name, version, language, device, dtype, grid, variant: result.beforeClose.selectedVariant, cases: result.cases,
            beforeClose: result.beforeClose, final: result.final });
        },
      });
    }
    if (language === "javascript") assert(!reads.some(path => path.includes("/pyodide/")
      || path.includes("/frontends/python/") || path.endsWith("/python.js") || path.endsWith("/python/bootstrap.py")),
    "Direct JavaScript conformance must not load the Python frontend or interpreter.");
    return observations;
  } finally { await server.close(); }
}
