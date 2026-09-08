import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";

import {
  browserDefinitions,
  browserVersion,
  resolveBrowser,
  runBrowserPage,
  startBrowserServer,
} from "./browser-harness.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const distributionRoot = fileURLToPath(new URL("../dist", import.meta.url));

function command(executable, arguments_) {
  const result = spawnSync(executable, arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${executable} ${arguments_.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function nearestRankPercentile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    medianMilliseconds: nearestRankPercentile(sorted, 0.5),
    p95Milliseconds: nearestRankPercentile(sorted, 0.95),
    minimumMilliseconds: sorted[0],
    maximumMilliseconds: sorted.at(-1),
  };
}

async function artifactSizes() {
  const paths = await readdir(distributionRoot, { recursive: true });
  const sizes = [];
  for (const path of paths.sort()) {
    const absolutePath = join(distributionRoot, path);
    let bytes;
    try {
      bytes = await readFile(absolutePath);
    } catch {
      continue;
    }
    sizes.push({
      path: relative(distributionRoot, absolutePath),
      rawBytes: bytes.byteLength,
      gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
      brotliBytes: brotliCompressSync(bytes).byteLength,
    });
  }
  return sizes;
}

const gitStatus = command("git", ["status", "--porcelain=v1"]);
const report = {
  schemaVersion: 2,
  measuredAt: new Date().toISOString(),
  revision: command("git", ["rev-parse", "HEAD"]),
  workingTreeDirty: gitStatus.length > 0,
  workingTreeFingerprint: createHash("sha256").update(gitStatus).digest("hex"),
  limits: {
    maximumTensorLength: 1_048_576,
    warmRepetitions: 5,
    maximumExperimentOwnedBytes: 67_108_864,
    browserConcurrency: 1,
  },
  environment: {
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    npm: command("npm", ["--version"]),
    rustc: command(process.env.RUSTC ?? "rustc", ["--version"]),
  },
  comparisonReference: {
    source: "https://github.com/isaacperez/tabgrad/issues/31#issuecomment-5579515513",
    revision: "363291ecdbb0aedf4052609fdd85985ea1b6d044",
    workload: {
      operation: "resident float32 addition through the raw WebAssembly ABI",
      length: 262_144,
      warmupsPerRound: 7,
      observationsPerRound: 31,
      rounds: 3,
      memoryBytesPerRound: 67_108_864,
      inputAndOutputState: "resident",
      crossOriginIsolated: true,
    },
    artifactBytes: { scalar: 3_766, simd128: 5_751 },
    medianMilliseconds: {
      Chrome: { scalar: 0.080, simd128: 0.030 },
      Firefox: { scalar: 0.080, simd128: 0.040 },
    },
    interpretation:
      "Compare only with rawKernelComparison. Public-path warm timings also include runtime formation, allocation, and explicit result readback.",
  },
  artifacts: await artifactSizes(),
  browsers: [],
};

const server = await startBrowserServer(["measure.html", "raw-kernel-measure.html"], {
  crossOriginIsolation: true,
});
try {
  for (const browser of browserDefinitions) {
    const executable = await resolveBrowser(browser);
    const browserResult = {
      name: browser.name,
      version: browserVersion(executable),
      variants: [],
    };
    for (const variant of ["scalar", "simd128"]) {
      const publicPath = await runBrowserPage({
        server,
        browser,
        executable,
        page: "measure.html",
        parameters: { variant },
        applicationTimeoutMilliseconds: 60_000,
      });
      assert.equal(publicPath.ok, true, JSON.stringify(publicPath.error));
      const rawRounds = [];
      for (let round = 0; round < 3; round += 1) {
        const rawRound = await runBrowserPage({
          server,
          browser,
          executable,
          page: "raw-kernel-measure.html",
          parameters: { variant, round },
          applicationTimeoutMilliseconds: 60_000,
        });
        assert.equal(rawRound.ok, true, JSON.stringify(rawRound.error));
        const { ok: _ok, ...measurements } = rawRound;
        rawRounds.push(measurements);
      }
      const rawSummary = summarize(rawRounds.flatMap((round) => round.samples));
      const referenceMedian = report.comparisonReference
        .medianMilliseconds[browser.name][variant];
      const referenceArtifactBytes = report.comparisonReference.artifactBytes[variant];
      const { ok: _ok, ...publicMeasurements } = publicPath;
      browserResult.variants.push({
        variant,
        ...publicMeasurements,
        rawKernelComparison: {
          rounds: rawRounds,
          summary: rawSummary,
          referenceMedianMilliseconds: referenceMedian,
          medianDifferenceMilliseconds:
            rawSummary.medianMilliseconds - referenceMedian,
          medianRatio: rawSummary.medianMilliseconds / referenceMedian,
          referenceArtifactBytes,
          artifactByteDifference: rawRounds[0].artifactBytes - referenceArtifactBytes,
          artifactByteRatio: rawRounds[0].artifactBytes / referenceArtifactBytes,
        },
      });
      process.stdout.write(`MEASURED ${browser.name} ${variant}\n`);
    }
    report.browsers.push(browserResult);
  }
} finally {
  await server.close();
}

const outputDirectory = new URL("../test-results/", import.meta.url);
await mkdir(outputDirectory, { recursive: true });
const output = new URL("performance.json", outputDirectory);
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${output.pathname}\n`);
