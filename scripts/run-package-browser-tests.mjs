import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createPackageApplication, runPackageProcess } from "../js-tests/fixtures/package-application.mjs";
import { checkPublicPackageEntries, checkPublicPackageTypes, checkPublicPackageCpuAssets } from "../js-tests/fixtures/package-consumer.mjs";
import { browserDefinitions, browserVersion, resolveBrowser, runBrowserPage, selectBrowserDefinitions, startBrowserServer } from "./browser-harness.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = join(repository, "js-tests/browser");
const page = "distribution/candidate.html";
const assets = ["distribution/candidate.mjs", "distribution/python-worker.mjs"];
const gpu = process.argv[2] === "--gpu";
if (process.argv.length > (gpu ? 3 : 2)) throw new Error("Usage: npm run test:package:browser or npm run test:package:webgpu");

function containedPath(root, path) {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function assertDrained(diagnostics) {
  assert.equal(diagnostics.liveTensorHandles, 0);
  assert.equal(diagnostics.liveRequestLeases, 0);
  assert.equal(diagnostics.liveAllocationBytes, 0);
  if (diagnostics.webgpu !== null) {
    assert.equal(diagnostics.webgpu.ownedBufferBytes, 0);
    assert.equal(diagnostics.webgpu.pendingSubmissions, 0);
    assert.equal(diagnostics.webgpu.unknownCompletionBytes, 0);
  }
}

function validateCandidateResult(result, mode) {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  if (mode === "direct") {
    assert.deepEqual(result.logs, [[11], [3, 4]]);
    assertDrained(result.diagnostics);
  } else if (mode === "prerequisite" || mode === "origin") {
    assert.equal(result.rejected, true);
    assert.equal(result.code, mode === "origin" ? "SecurityError" : "UNSUPPORTED_DEVICE");
  } else {
    assert.equal(result.environment.pyodide, "314.0.6");
    assert.equal(result.environment.jspiAvailable, false);
    assert.equal(result.environment.sharedIdentity, true);
    assert.equal(result.environment.worker, true);
    assert.equal(result.environment.isolated, mode === "gpu");
    assert.equal(result.completion.preservedHost, true);
    assertDrained(result.completion.diagnostics);
    if (mode === "gpu") {
      const physical = result.completion.diagnostics.webgpu;
      assert.ok(physical.kernelCalls > 0);
      assert.equal(physical.adapter.isFallbackAdapter, false);
      process.stdout.write(`${JSON.stringify({ gpu: physical.adapter, features: physical.features, limits: physical.limits })}\n`);
    }
  }
}

const directory = await mkdtemp(join(tmpdir(), "tabgrad-package-browser-"));
let fixture;
try {
  const output = join(directory, "candidate");
  runPackageProcess(process.execPath, [join(repository, "scripts/package-distribution.mjs"), output], repository);
  const report = JSON.parse(await readFile(join(output, "candidate.json"), "utf8"));
  fixture = await createPackageApplication({ tarball: join(output, report.tarball.path) });
  const application = fixture.application;
  for (const file of report.files) {
    const bytes = await readFile(join(fixture.packageDirectory, file.path));
    assert.equal(bytes.length, file.byteLength);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
  }
  await checkPublicPackageEntries(fixture);
  await checkPublicPackageTypes(fixture);
  await checkPublicPackageCpuAssets(fixture);
  process.stdout.write("PASS external candidate Node entries, declarations, CPU gradients and invalid assets\n");
  await cp(join(fixture.packageDirectory, "dist"), join(application, "vendor/tabgrad"), { recursive: true });
  await mkdir(join(application, "distribution"));
  for (const path of [page, ...assets]) await cp(join(fixtureRoot, path), join(application, path));
  await mkdir(join(application, "vendor/pyodide"));
  for (const path of ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "pyodide-lock.json", "python_stdlib.zip"]) {
    await cp(join(repository, "node_modules/pyodide", path), join(application, "vendor/pyodide", path));
  }
  const readme = await readFile(join(fixture.packageDirectory, "README.md"), "utf8");
  const code = readme.match(/```javascript\n([\s\S]*?)\n```/)?.[1];
  assert.ok(code, "Candidate has no documented JavaScript example.");
  await writeFile(join(application, "documented-example.mjs"), `${code}\nexport const diagnostics = session.diagnostics();\n`);
  for (const browser of selectBrowserDefinitions(process.env.TABGRAD_BROWSER ?? (gpu ? "Chrome" : undefined), browserDefinitions)) {
    const executable = await resolveBrowser(browser);
    const version = browserVersion(executable);
    for (const mode of gpu ? ["gpu", "origin"] : ["direct", "python", "prerequisite"]) {
      const reads = [];
      const server = await startBrowserServer([page], { assets, crossOriginIsolation: gpu, distributionDirectory: application,
        readAsset(path) {
          const actual = containedPath(fixtureRoot, path) ? join(application, relative(fixtureRoot, path)) : path;
          assert.ok(containedPath(application, actual), "A candidate request escaped the external application.");
          reads.push(relative(application, actual).split(sep).join("/"));
          return readFile(actual);
        },
      });
      try {
        await runBrowserPage({ server, browser, executable, version, page, parameters: { mode },
          validateResult(result) { validateCandidateResult(result, mode); },
        });
        if (mode === "direct") assert.ok(!reads.some(path => path.startsWith("vendor/pyodide/")
          || path.startsWith("vendor/tabgrad/python/") || path.startsWith("vendor/tabgrad/frontends/python/")
          || path === "vendor/tabgrad/python.js"));
        process.stdout.write(`PASS ${browser.name} ${version} external package ${mode}\n`);
      } finally { await server.close(); }
    }
  }
  process.stdout.write(`${JSON.stringify({ sourceRevision: report.sourceRevision, version: report.version,
    tarball: report.tarball, files: report.files.length, staticDirectory: report.staticDirectory })}\n`);
} finally {
  try { await fixture?.close(); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
