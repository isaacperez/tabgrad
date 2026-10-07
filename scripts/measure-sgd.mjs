import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadPyodide } from "pyodide";
import { attachPython } from "../dist/python.js";
import { createTestRuntimeSession, getTestRuntimeOwnership, getTestRuntimeSemanticOwnership } from "../dist/testing.js";
import { RuntimeFixtureServer } from "../js-tests/fixtures/runtime-fixture-server.mjs";
import { checkSGDFixedOwners, checkPythonSGDFixedOwners } from "../js-tests/browser/helpers/sgd-lifetime.mjs";

function git(arguments_) {
  const result = spawnSync("git", arguments_, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

const timerSamples = Array.from({ length: 1000 }, () => {
  const start = performance.now(); return performance.now() - start;
});
const report = { schemaVersion: 1, revision: git(["rev-parse", "HEAD"]),
  sourceTree: git(["rev-parse", "HEAD^{tree}"]), workingTreeStatus: git(["status", "--porcelain=v1"]),
  environment: { node: process.version, platform: `${process.platform}-${process.arch}`, pyodide: null },
  timer: { minimumMilliseconds: Math.min(...timerSamples), maximumMilliseconds: Math.max(...timerSamples) },
  method: "One process, sequential profiles; first 16 steps are pilot. Fixed owners including alias and old saved history; post-observation drain. Host memory includes GC/toolchain effects; no speed or immediate RSS-reclamation claim.",
  direct: [], python: [] };
const server = new RuntimeFixtureServer(fileURLToPath(new URL("../dist", import.meta.url)));
const distributionUrl = await server.start();
try {
  for (const forceVariant of ["scalar", "simd128"]) {
    for (const length of [32, 4096, 65536]) {
      const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
      try {
        report.direct.push({ forceVariant, length, snapshots: await checkSGDFixedOwners(session, length, getTestRuntimeOwnership, getTestRuntimeSemanticOwnership) });
      } finally { await session.close(); }
    }
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => String(url).startsWith("file:")
    ? new Response(await readFile(url)) : originalFetch(url, options);
  try {
    const interpreter = await loadPyodide(); report.environment.pyodide = interpreter.version;
    const binding = await attachPython(interpreter);
    try {
      for (const length of [32, 4096, 65536]) {
        const snapshots = await checkPythonSGDFixedOwners(binding, interpreter, length, getTestRuntimeOwnership, getTestRuntimeSemanticOwnership);
        report.python.push({ variant: interpreter.runPython("torch._runtime_session.diagnostics().selectedVariant"), length, snapshots });
      }
    } finally { await binding.close(); }
  } finally { globalThis.fetch = originalFetch; }
} finally { await server.close(); }
await mkdir(new URL("../test-results", import.meta.url), { recursive: true });
await writeFile(new URL("../test-results/sgd-resources.json", import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write("SGD resource measurements saved under test-results/sgd-resources.json\n");
