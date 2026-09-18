import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { browserDefinitions, browserVersion, resolveBrowser, runBrowserPage,
  selectBrowserDefinitions, startBrowserServer } from "./browser-harness.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
function command(executable, arguments_) {
  const result = spawnSync(executable, arguments_, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} failed: ${result.stderr}`);
  return result.stdout;
}
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

async function sourceIdentity() {
  const untracked = command("git", ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  const files = [];
  for (const path of untracked.sort()) files.push({ path, sha256: hash(await readFile(join(root, path))) });
  return { revision: command("git", ["rev-parse", "HEAD"]).trim(),
    trackedPatchSha256: hash(command("git", ["diff", "HEAD", "--binary"])), untracked: files };
}

async function artifactIdentity(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const bytes = await readFile(path);
    files.push({ path: path.slice(directory.length + 1), sha256: hash(bytes), rawBytes: bytes.length,
      gzipBytes: gzipSync(bytes, { level: 9 }).length, brotliBytes: brotliCompressSync(bytes).length });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function summary(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return { samples: samples.length, median: sorted[Math.floor(sorted.length / 2)],
    minimum: sorted[0], maximum: sorted.at(-1) };
}

function summarizeResult(result) {
  if (result.diagnostic) return; // Probe samples are not ordinary timing evidence.
  for (const record of result.cases) {
    const samples = record.samples.filter((sample) => !sample.warmup);
    if (samples.length === 0) continue;
    record.summaryMilliseconds = Object.fromEntries(Object.keys(samples[0].milliseconds)
      .map((name) => [name, summary(samples.map((sample) => sample.milliseconds[name]))]));
  }
}

// A baseline must be built separately from its stated revision with the same
// prepared toolchain. The command never switches or rewrites the worktree.
const baselineDirectory = process.env.TABGRAD_MEASURE_BASELINE;
const baselineRevision = process.env.TABGRAD_MEASURE_BASELINE_REVISION;
if (!baselineDirectory || !baselineRevision) {
  throw new Error("Set TABGRAD_MEASURE_BASELINE to an isolated base dist and TABGRAD_MEASURE_BASELINE_REVISION to its exact revision.");
}
const source = await sourceIdentity();
const distributions = {
  base: resolve(baselineDirectory), current: join(root, "dist"),
};
const artifacts = { base: await artifactIdentity(distributions.base), current: await artifactIdentity(distributions.current) };
const report = {
  schemaVersion: 2, startedAt: new Date().toISOString(), source,
  baselineRevision: command("git", ["rev-parse", `${baselineRevision}^{commit}`]).trim(), artifacts,
  environment: { platform: platform(), architecture: arch(), release: release(), node: process.version,
    npm: command("npm", ["--version"]).trim(), rustc: command("rustc", ["--version"]).trim(),
    power: process.platform === "darwin" ? command("pmset", ["-g", "batt"]).trim() : "not observed",
    backgroundLoad: "No synthetic competing load; unrelated system activity is not controlled." },
  method: { lengths: [0, 1, 4, 256, 4096], depths: [1, 4, 16], warmupsPerCase: 1, samplesPerCase: 5,
    tracingRunsPerPythonCase: 1, browserConcurrency: 1, workerConcurrency: 1,
    maximumNumericalPayloadBytes: 8 * 1024 * 1024, maximumTabgradCpuBytes: 64 * 1024 * 1024,
    cache: "Fresh browser profile per build/variant; no-store HTTP; sequential fresh sessions with reused interpreter and module code.",
    preparation: "JS empty add/readback and Python managed pass. Preparation methods differ; warm workloads are equivalent.",
    peak: "Allocator high-water over one fresh case session; Python tracemalloc peak in a separate diagnostic run. Logical snapshots are not transient peaks.",
    timing: "Worker-local public boundaries; import includes input container allocation and conversion, demandAndObservation includes planning, kernels, readback and presentation.",
    diagnostic: "Separate current-build profile: inclusive native kernel, backend execution, readback and Python bridge spans; actual tensor add/close and Python conversion call counts. One sample per case, no latency distribution; instrumentation overhead included.",
    unavailable: ["isolated planner duration", "total JS heap", "complete transient logical-record peaks", "live PyProxy count", "all Pyodide-internal FFI calls"],
  }, runs: [],
};
const outputDirectory = join(root, "test-results");
await mkdir(outputDirectory, { recursive: true });
// Unique output preserves unsuccessful attempts; it never overwrites an earlier run.
const output = join(outputDirectory, `python-performance-${Date.now()}.json`);
try {
  for (const browser of selectBrowserDefinitions(process.env.TABGRAD_BROWSER, browserDefinitions)) {
    const executable = await resolveBrowser(browser);
    const version = browserVersion(executable);
    for (const variant of ["scalar", "simd128"]) {
      const order = variant === "scalar" ? ["base", "current"] : ["current", "base"];
      const profiles = [...order.map((build) => ({ build, python: false })),
        { build: "current", python: true }, { build: "current", python: true, diagnostic: true }];
      for (const { build, python, diagnostic = false } of profiles) {
        const run = { browser: browser.name, version, variant, build,
          profile: diagnostic ? "boundary-diagnostics" : python ? "python-comparison" : "javascript-only" };
        report.runs.push(run);
        const server = await startBrowserServer(["python-measure.html"], {
          assets: ["python-measure.mjs", "cpu-profile.mjs", "execution-probe.mjs"], distributionDirectory: distributions[build],
        });
        try {
          run.result = await runBrowserPage({ server, browser, executable, version, page: "python-measure.html",
            parameters: { variant, python: python ? "yes" : "no", diagnostic: diagnostic ? "yes" : "no" },
            applicationTimeoutMilliseconds: 60_000 });
          summarizeResult(run.result);
          assert.equal(run.result.ok, true, JSON.stringify(run.result.error));
          assert.equal(run.result.variant, variant);
          assert.equal(run.result.worker, true);
          assert.equal(run.result.diagnostic, diagnostic);
          assert.equal(run.result.crossOriginIsolated, false);
          assert.equal(run.result.cases.length, python ? 30 : 15);
          process.stdout.write(`MEASURED ${browser.name} ${variant} ${build} ${run.profile}\n`);
        } catch (error) {
          run.failure = { message: String(error), diagnostics: error.diagnostics };
          throw error;
        } finally {
          await server.close();
          await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
        }
      }
    }
  }
  assert.deepEqual(await sourceIdentity(), source, "Source changed during measurement");
  for (const build of ["base", "current"]) {
    assert.deepEqual(await artifactIdentity(distributions[build]), artifacts[build], "Distribution changed during measurement");
  }
  report.completed = true;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${output}\n`);
}
