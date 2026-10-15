import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPackageApplication, runPackageProcess } from "../js-tests/fixtures/package-application.mjs";
import { checkPublicPackageEntries, checkPublicPackageTypes, checkPublicPackageCpuAssets } from "../js-tests/fixtures/package-consumer.mjs";
import { PackageArtifactError, verifyPackageDirectory } from "./package-artifact.mjs";
import { BrowserRunError, browserDefinitions, browserVersion, resolveBrowser, runBrowserPage, selectBrowserDefinitions, startBrowserServer } from "./browser-harness.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = join(repository, "js-tests/browser");
const page = "distribution/candidate.html";
const assets = ["distribution/candidate.mjs", "distribution/python-worker.mjs"];

export function parsePackageArguments(arguments_) {
  const options = { gpu: false };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--gpu" && !options.gpu) options.gpu = true;
    else if ((argument === "--tarball" || argument === "--expected")
      && options[argument.slice(2)] === undefined && arguments_[index + 1] !== undefined
      && !arguments_[index + 1].startsWith("--")) options[argument.slice(2)] = resolve(arguments_[++index]);
    else throw new PackageArtifactError("ARGUMENTS_INVALID", "Use optional --gpu and paired --tarball archive.tgz --expected candidate.json.");
  }
  if ((options.tarball === undefined) !== (options.expected === undefined)) {
    throw new PackageArtifactError("ARGUMENTS_INVALID", "Supply both an archive and its admitted expected evidence.");
  }
  return options;
}

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
    }
  }
}

async function prepareBrowserApplication(fixture) {
  const application = fixture.application;
  await cp(join(fixture.packageDirectory, "dist"), join(application, "vendor/tabgrad"), { recursive: true });
  await verifyPackageDirectory(join(application, "vendor/tabgrad"), fixture.evidence.files
    .filter(file => file.path.startsWith("dist/")).map(file => ({ ...file, path: file.path.slice(5) })));
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
}

function readCandidateAsset(application, reads, path) {
  const actual = containedPath(fixtureRoot, path) ? join(application, relative(fixtureRoot, path)) : path;
  assert.ok(containedPath(application, actual), "A candidate request escaped the external application.");
  reads.push(relative(application, actual).split(sep).join("/"));
  return readFile(actual);
}

async function runCandidateProfile(fixture, browser, executable, version, mode) {
  const application = fixture.application;
  const reads = [];
  const server = await startBrowserServer([page], { assets, crossOriginIsolation: mode === "gpu" || mode === "origin", distributionDirectory: application,
    readAsset: path => readCandidateAsset(application, reads, path),
  });
  const notes = [];
  let observation;
  try {
    await runBrowserPage({ server, browser, executable, version, page, parameters: { mode },
      reportNote: message => notes.push(message.trimEnd()),
      validateResult(result) {
        observation = candidateObservation(result, mode, browser.name, version);
      },
    });
    if (mode === "direct") assert.ok(!reads.some(path => path.startsWith("vendor/pyodide/")
      || path.startsWith("vendor/tabgrad/python/") || path.startsWith("vendor/tabgrad/frontends/python/")
      || path === "vendor/tabgrad/python.js"));
    return { ...observation, notes };
  } finally { await server.close(); }
}

function candidateObservation(result, mode, browser, version) {
  validateCandidateResult(result, mode);
  const observation = { browser, version, mode, status: "passed" };
  if (result.environment !== undefined) observation.environment = result.environment;
  if (mode === "gpu") {
    const physical = result.completion.diagnostics.webgpu;
    observation.gpu = { adapter: physical.adapter, features: physical.features, limits: physical.limits };
  }
  return observation;
}

function parseExpectedEvidence(bytes) {
  try { return JSON.parse(bytes); }
  catch { throw new PackageArtifactError("EVIDENCE_INVALID", "Expected candidate evidence is not valid JSON."); }
}

function failureObservation(error, phase) {
  const failure = { phase, code: error instanceof PackageArtifactError ? error.code : "QUALIFICATION_FAILED",
    message: error instanceof PackageArtifactError ? error.message : "The selected qualification phase failed.",
    ...(Number.isInteger(error?.exitCode) ? { exitCode: error.exitCode } : {}) };
  if (error instanceof BrowserRunError) {
    const diagnostics = error.diagnostics;
    failure.code = "BROWSER_FAILED";
    failure.browser = { kind: diagnostics.failureKind, exitCode: diagnostics.process.exitCode,
      signal: diagnostics.process.signal, standardErrorClosedEarly: diagnostics.standardErrorClosedEarly,
      profileCleanupFailed: diagnostics.cleanupFailure !== null, terminationFailed: diagnostics.terminationFailure !== null };
  }
  return failure;
}

/**
 * Non-publishing qualification of either a retained admitted archive or a new
 * source candidate. Reports requested and observed coverage separately, never
 * input paths or raw process/browser errors. Owned state is joined and removed
 * before success is reported; partial observations survive a later failure.
 */
export async function qualifyPackage(options) {
  const report = { schemaVersion: 1, input: options.tarball === undefined ? "source-candidate" : "supplied-archive",
    status: "failed", requested: { gpu: options.gpu, browsers: [], profiles: options.gpu ? ["gpu", "origin"] : ["direct", "python", "prerequisite"] },
    environment: { node: process.version, platform: process.platform, release: release(), architecture: process.arch }, checks: [], profiles: [] };
  let directory, fixture;
  let phase = "selection";
  try {
    const browsers = selectBrowserDefinitions(process.env.TABGRAD_BROWSER ?? (options.gpu ? "Chrome" : undefined), browserDefinitions);
    report.requested.browsers = browsers.map(browser => browser.name);
    phase = "preparation";
    directory = await mkdtemp(join(tmpdir(), "tabgrad-package-browser-"));
    let tarball = options.tarball;
    let evidenceBytes;
    if (tarball === undefined) {
      const output = join(directory, "candidate");
      runPackageProcess(process.execPath, [join(repository, "scripts/package-distribution.mjs"), output], repository, { reportStderr: false });
      evidenceBytes = await readFile(join(output, "candidate.json"));
      const prepared = JSON.parse(evidenceBytes);
      tarball = join(output, prepared.tarball.path);
    } else evidenceBytes = await readFile(options.expected);
    report.expectedEvidenceSha256 = createHash("sha256").update(evidenceBytes).digest("hex");
    phase = "admission-and-installation";
    fixture = await createPackageApplication({ tarball, expected: parseExpectedEvidence(evidenceBytes) });
    const expected = fixture.evidence;
    report.candidate = { name: expected.name, version: expected.version, sourceRevision: expected.sourceRevision,
      private: expected.private, archive: { byteLength: expected.tarball.byteLength, sha256: expected.tarball.sha256,
        integrity: expected.tarball.integrity }, files: expected.files.length };
    report.environment.npm = runPackageProcess("npm", ["--version"], fixture.application, { reportStderr: false }).trim();
    report.checks.push("archive-identity", "archive-structure", "metadata-and-source", "installed-inventory");
    phase = "public-entries";
    await checkPublicPackageEntries(fixture); report.checks.push(phase);
    phase = "public-types";
    await checkPublicPackageTypes(fixture); report.checks.push(phase);
    report.environment.typescript = JSON.parse(await readFile(join(repository, "node_modules/typescript/package.json"), "utf8")).version;
    phase = "cpu-assets";
    await checkPublicPackageCpuAssets(fixture); report.checks.push(phase);
    phase = "static-application";
    await prepareBrowserApplication(fixture); report.checks.push("static-inventory");
    for (const browser of browsers) {
      phase = `${browser.name}-availability`;
      const executable = await resolveBrowser(browser);
      const version = browserVersion(executable);
      for (const mode of report.requested.profiles) {
        phase = `${browser.name}-${mode}`;
        report.profiles.push(await runCandidateProfile(fixture, browser, executable, version, mode));
      }
    }
    report.status = "passed";
  } catch (error) {
    report.failure = failureObservation(error, phase);
    if (error instanceof PackageArtifactError && error.archive !== undefined) report.archive = error.archive;
    if (error?.cleanupError !== undefined) report.cleanupFailure = failureObservation(error.cleanupError, "application-cleanup");
  }
  finally {
    try { await fixture?.close(); }
    catch (error) { report.cleanupFailure = failureObservation(error, "application-cleanup"); report.status = "failed"; }
    try { if (directory !== undefined) await rm(directory, { recursive: true, force: true }); }
    catch (error) { report.preparationCleanupFailure = failureObservation(error, "preparation-cleanup"); report.status = "failed"; }
  }
  return report;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  let report;
  try { report = await qualifyPackage(parsePackageArguments(process.argv.slice(2))); }
  catch (error) { report = { schemaVersion: 1, status: "failed", failure: failureObservation(error, "arguments") }; }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.status !== "passed") process.exitCode = 1;
}
