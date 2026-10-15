import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { test } from "node:test";
import { createPackageApplication, runPackageProcess } from "../../fixtures/package-application.mjs";
import { verifyPackageDirectory } from "../../../scripts/package-artifact.mjs";
import { packageFixture, hash, archiveIdentity, sourceRevision } from "../../fixtures/package-candidate.mjs";
import { parsePackageArguments } from "../../../scripts/run-package-browser-tests.mjs";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
const driver = join(repository, "scripts/run-package-browser-tests.mjs");

async function cliProbe(fixture, bytes = fixture.bytes, expected = fixture.expected, environment = {}, command = driver) {
  const input = join(fixture.directory, "supplied input.tgz");
  const evidence = join(fixture.directory, "expected evidence.json");
  const temporary = await mkdtemp(join(fixture.directory, "probe-"));
  await writeFile(input, bytes);
  const evidenceBytes = typeof expected === "string" ? expected : JSON.stringify(expected);
  await writeFile(evidence, evidenceBytes);
  const result = spawnSync(process.execPath, [command, "--tarball", input, "--expected", evidence], {
    cwd: fixture.directory, encoding: "utf8", env: { ...process.env, TMPDIR: temporary, ...environment },
  });
  assert.ifError(result.error);
  assert.notEqual(result.stdout, "", `Qualification exited without its report: ${result.status}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(result.status, report.status === "passed" ? 0 : 1);
  assert.ok(!result.stdout.includes(fixture.directory));
  assert.ok(!result.stderr.includes(fixture.directory));
  assert.deepEqual(await readdir(temporary), [], "failed or successful qualification leaked owned temporary state");
  assert.deepEqual(await readFile(input), bytes);
  assert.equal(await readFile(evidence, "utf8"), evidenceBytes);
  return report;
}

function updateChecksum(bytes) {
  bytes.fill(32, 148, 156);
  const checksum = bytes.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  bytes.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return bytes;
}

function headerPath(bytes, path) {
  bytes.fill(0, 0, 100);
  bytes.write(path, 0, 100, "ascii");
  return updateChecksum(bytes);
}

async function executableOnPath(name) {
  for (const directory of process.env.PATH.split(delimiter)) {
    const path = join(directory, name);
    try { await access(path); return resolve(path); } catch { /* Try the next configured directory. */ }
  }
  throw new Error("Required prepared executable is missing.");
}

test("retained package arguments keep source mode and require an explicit input pair", () => {
  assert.deepEqual(parsePackageArguments([]), { gpu: false });
  assert.deepEqual(parsePackageArguments(["--gpu"]), { gpu: true });
  assert.deepEqual(parsePackageArguments(["--expected", "evidence.json", "--gpu", "--tarball", "input.tgz"]),
    { gpu: true, expected: resolve("evidence.json"), tarball: resolve("input.tgz") });
  for (const arguments_ of [["--tarball", "x"], ["--expected", "x"], ["--gpu", "--gpu"], ["--other"], ["--tarball"], ["--expected", "--gpu"]]) {
    assert.throws(() => parsePackageArguments(arguments_), { code: "ARGUMENTS_INVALID" });
  }
});

test("supplied identity is independent of checkout and installs exact bytes without lifecycle scripts", async context => {
  const input = await packageFixture(context);
  for (let repetition = 0; repetition < 2; repetition += 1) {
    const application = await createPackageApplication({ tarball: input.tarball, expected: input.expected });
    try {
      assert.equal(application.metadata.name, "@tabgrad/retained-fixture");
      assert.equal(application.metadata.version, "0.9.7");
      assert.equal(application.evidence.sourceRevision, sourceRevision);
      assert.equal(application.metadata.private, false);
      assert.notEqual(application.tarball, input.tarball);
      assert.deepEqual(await readFile(application.tarball), input.bytes);
      await verifyPackageDirectory(application.packageDirectory, input.expected.files);
      await assert.rejects(access(input.lifecycleMarker));
    } finally { await application.close(); }
    await assert.rejects(access(application.directory));
    assert.deepEqual(await readFile(input.tarball), input.bytes);
  }
});

test("npm consumes an owned exact copy even if the supplied pathname changes at installation", async context => {
  const input = await packageFixture(context);
  const actualNpm = await executableOnPath("npm");
  const wrapperDirectory = join(input.directory, "commands");
  const observed = join(input.directory, "observed.json");
  await mkdir(wrapperDirectory);
  const wrapper = join(wrapperDirectory, "npm");
  await writeFile(wrapper, `#!/usr/bin/env node
const fs = require('node:fs'); const {spawnSync} = require('node:child_process'); const crypto = require('node:crypto');
const args = process.argv.slice(2); if (args[0] !== 'install') process.exit(87);
const bytes = fs.readFileSync(args[1]);
fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({args, hash:crypto.createHash('sha256').update(bytes).digest('hex')}));
fs.writeFileSync(${JSON.stringify(input.tarball)}, 'substituted original');
const result = spawnSync(${JSON.stringify(actualNpm)}, args, {stdio:'inherit'}); process.exit(result.status ?? 1);
`);
  await chmod(wrapper, 0o755);
  const previousPath = process.env.PATH;
  let application;
  try {
    process.env.PATH = `${wrapperDirectory}${delimiter}${previousPath}`;
    application = await createPackageApplication({ tarball: input.tarball, expected: input.expected });
  } finally { process.env.PATH = previousPath; }
  try {
    const observation = JSON.parse(await readFile(observed, "utf8"));
    assert.equal(observation.hash, input.expected.tarball.sha256);
    assert.equal(observation.args[1], application.tarball);
    for (const flag of ["--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--bin-links=false", "--save=false", "--package-lock=false"]) {
      assert.ok(observation.args.includes(flag));
    }
    assert.equal(await readFile(input.tarball, "utf8"), "substituted original");
    await verifyPackageDirectory(application.packageDirectory, input.expected.files);
    await assert.rejects(access(input.lifecycleMarker));
  } finally { await application?.close(); }
});

test("independent archive, identity and inventory mismatches reject before profiles and preserve inputs", async context => {
  const input = await packageFixture(context);
  const cases = [
    ["archive bytes", expected => expected, Buffer.from("different bytes"), "ARCHIVE_MISMATCH"],
    ["archive digest", expected => { expected.tarball.sha256 = "0".repeat(64); }, input.bytes, "ARCHIVE_MISMATCH"],
    ["archive integrity", expected => { expected.tarball.integrity = "sha512-different"; }, input.bytes, "ARCHIVE_MISMATCH"],
    ["name", expected => { expected.name = "another-package"; }, input.bytes, "METADATA_MISMATCH"],
    ["version", expected => { expected.version = "0.9.8"; }, input.bytes, "METADATA_MISMATCH"],
    ["source", expected => { expected.sourceRevision = "b".repeat(40); }, input.bytes, "SOURCE_MISMATCH"],
    ["private flag", expected => { expected.private = true; }, input.bytes, "METADATA_MISMATCH"],
    ["file digest", expected => { expected.files[0].sha256 = "0".repeat(64); }, input.bytes, "CONTENT_MISMATCH"],
    ["file length", expected => { expected.files[0].byteLength += 1; }, input.bytes, "CONTENT_MISMATCH"],
    ["unlisted file", expected => { expected.files = expected.files.filter(file => file.path !== "dist/index.js"); }, input.bytes, "CONTENT_MISMATCH"],
    ["missing file", expected => { expected.files.push({ path: "dist/missing.js", byteLength: 0, sha256: hash("") }); }, input.bytes, "CONTENT_MISMATCH"],
    ["same-count wrong file", expected => { expected.files.find(file => file.path.startsWith("dist/")).path = "dist/absent.js"; }, input.bytes, "CONTENT_MISMATCH"],
    ["duplicate inventory", expected => { expected.files.push(expected.files[0]); }, input.bytes, "EVIDENCE_INVALID"],
    ["inventory path", expected => { expected.files[0].path = "dist/../outside"; }, input.bytes, "EVIDENCE_INVALID"],
    ["invalid shape", expected => { expected.files = null; }, input.bytes, "EVIDENCE_INVALID"],
    ["invalid source type", expected => { expected.sourceRevision = [sourceRevision]; }, input.bytes, "EVIDENCE_INVALID"],
    ["invalid package path", expected => { expected.name = "../../escape"; }, input.bytes, "EVIDENCE_INVALID"],
    ["negative file length", expected => { expected.files[0].byteLength = -1; }, input.bytes, "EVIDENCE_INVALID"],
  ];
  for (const [name, mutate, bytes, code] of cases) await context.test(name, async () => {
    const expected = structuredClone(input.expected); mutate(expected);
    const report = await cliProbe(input, bytes, expected);
    assert.equal(report.status, "failed"); assert.equal(report.failure.code, code);
    if (code !== "EVIDENCE_INVALID") assert.deepEqual(report.archive, archiveIdentity(bytes));
    assert.deepEqual(report.checks, []); assert.deepEqual(report.profiles, []);
    await assert.rejects(access(input.lifecycleMarker));
  });
});

test("portable npm archives preserve ustar prefixes and payload block boundaries", async context => {
  const extraFiles = [0, 511, 512, 513].map(size => [`dist/${"nested/".repeat(16)}payload-${size}.txt`, Buffer.alloc(size, 120)]);
  const input = await packageFixture(context, { extraFiles });
  const application = await createPackageApplication({ tarball: input.tarball, expected: input.expected });
  try { await verifyPackageDirectory(application.packageDirectory, input.expected.files); }
  finally { await application.close(); }
});

test("admitted metadata can omit private while dependency-bearing packages reject", async context => {
  const input = await packageFixture(context, { metadataOverrides: { private: undefined } });
  delete input.expected.private;
  const application = await createPackageApplication({ tarball: input.tarball, expected: input.expected });
  await application.close();
  const dependency = await packageFixture(context, { metadataOverrides: { dependencies: { unexpected: "1.0.0" } } });
  const report = await cliProbe(dependency);
  assert.equal(report.failure.code, "METADATA_INVALID");
  assert.deepEqual(report.profiles, []);
});

test("installation failure retains archive and exit evidence without private process output", async context => {
  const input = await packageFixture(context);
  const commands = join(input.directory, "commands");
  await mkdir(commands);
  await writeFile(join(commands, "npm"), `#!/usr/bin/env node\nprocess.stderr.write(${JSON.stringify(input.directory)}); process.exit(42);\n`);
  await chmod(join(commands, "npm"), 0o755);
  const report = await cliProbe(input, input.bytes, input.expected, { PATH: `${commands}${delimiter}${process.env.PATH}` });
  assert.equal(report.failure.code, "INSTALLATION_FAILED");
  assert.equal(report.failure.exitCode, 42);
  assert.deepEqual(report.archive, archiveIdentity(input.bytes));
  assert.deepEqual(report.profiles, []);
});

test("unsupported tar entries and malformed framing reject before package execution", async context => {
  const input = await packageFixture(context);
  const original = gunzipSync(input.bytes);
  const firstLength = 512 + Math.ceil(Number.parseInt(original.subarray(124, 136).toString(), 8) / 512) * 512;
  const cases = [
    ["checksum", bytes => { bytes[0] ^= 1; return bytes; }],
    ["magic", bytes => { bytes.write("other", 257); return updateChecksum(bytes); }],
    ["absolute path", bytes => headerPath(bytes, "/package/dist/index.js")],
    ["parent path", bytes => headerPath(bytes, "package/../outside")],
    ["noncanonical path", bytes => headerPath(bytes, "package/dist//index.js")],
    ["backslash path", bytes => headerPath(bytes, "package/dist\\outside")],
    ["other root", bytes => headerPath(bytes, "elsewhere/dist/index.js")],
    ["unadmitted content", bytes => headerPath(bytes, "package/private.txt")],
    ["high-bit path", bytes => { bytes[0] |= 128; return updateChecksum(bytes); }],
    ["high-bit size", bytes => { bytes[124] |= 128; return updateChecksum(bytes); }],
    ["missing end", bytes => bytes.subarray(0, bytes.length - 1024)],
    ["truncated header", bytes => bytes.subarray(0, 300)],
    ["trailing data", bytes => Buffer.concat([bytes, Buffer.from("extra")])],
    ["duplicate entry", bytes => Buffer.concat([bytes.subarray(0, -1024), bytes.subarray(0, firstLength), Buffer.alloc(1024)])],
    ...["1", "2", "3", "5", "x", "g", "L"].map(type => [`entry type ${type}`, bytes => { bytes[156] = type.charCodeAt(0); return updateChecksum(bytes); }]),
  ];
  for (const [name, mutate] of cases) await context.test(name, async () => {
    const bytes = gzipSync(mutate(Buffer.from(original)));
    const expected = structuredClone(input.expected); Object.assign(expected.tarball, archiveIdentity(bytes));
    const report = await cliProbe(input, bytes, expected);
    assert.equal(report.failure.code, "ARCHIVE_INVALID"); assert.deepEqual(report.profiles, []);
    await assert.rejects(access(input.lifecycleMarker));
  });
  const truncated = input.bytes.subarray(0, -5);
  const expected = structuredClone(input.expected); Object.assign(expected.tarball, archiveIdentity(truncated));
  assert.equal((await cliProbe(input, truncated, expected)).failure.code, "ARCHIVE_INVALID");
});

test("an undelimited checksum rejects before npm can interpret it differently", async context => {
  const input = await packageFixture(context);
  const tar = gunzipSync(input.bytes);
  tar.fill(32, 148, 156);
  const checksum = tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  tar.write(checksum.toString(8).padStart(8, "0"), 148, 8, "ascii");
  const bytes = gzipSync(tar);
  const expected = structuredClone(input.expected);
  Object.assign(expected.tarball, archiveIdentity(bytes));
  const commands = join(input.directory, "commands");
  const invoked = join(input.directory, "npm-invoked");
  await mkdir(commands);
  await writeFile(join(commands, "npm"), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(invoked)}, 'unexpected'); process.exit(87);\n`);
  await chmod(join(commands, "npm"), 0o755);
  const report = await cliProbe(input, bytes, expected, { PATH: `${commands}${delimiter}${process.env.PATH}` });
  assert.equal(report.failure.code, "ARCHIVE_INVALID");
  assert.deepEqual(report.profiles, []);
  await assert.rejects(access(invoked));
});

test("complete installed/static checks reject additions, omissions, changed bytes and links", async context => {
  const input = await packageFixture(context);
  const tree = join(input.directory, "verified");
  await cp(input.source, tree, { recursive: true });
  await verifyPackageDirectory(tree, input.expected.files);
  await writeFile(join(tree, "dist/extra.js"), "extra");
  await assert.rejects(verifyPackageDirectory(tree, input.expected.files), { code: "CONTENT_MISMATCH" });
  await rm(join(tree, "dist/extra.js"));
  await rm(join(tree, "dist/index.js"));
  await assert.rejects(verifyPackageDirectory(tree, input.expected.files), { code: "CONTENT_MISMATCH" });
  await writeFile(join(tree, "dist/index.js"), "changed");
  await assert.rejects(verifyPackageDirectory(tree, input.expected.files), { code: "CONTENT_MISMATCH" });
  await rm(join(tree, "dist/index.js"));
  await symlink(join(input.source, "dist/index.js"), join(tree, "dist/index.js"));
  await assert.rejects(verifyPackageDirectory(tree, input.expected.files), { code: "CONTENT_MISMATCH" });
});

test("failure reports preserve observed admission but do not claim unavailable browser coverage", async context => {
  const input = await packageFixture(context, { fullRuntime: true });
  const report = await cliProbe(input, input.bytes, input.expected, { TABGRAD_BROWSER: "Chrome", TABGRAD_CHROME: join(input.directory, "absent-browser") });
  assert.equal(report.status, "failed");
  assert.equal(report.failure.phase, "Chrome-availability");
  assert.equal(report.candidate.name, "@tabgrad/retained-fixture");
  assert.equal(report.candidate.sourceRevision, sourceRevision);
  assert.ok(report.checks.includes("static-inventory"));
  assert.deepEqual(report.requested.profiles, ["direct", "python", "prerequisite"]);
  assert.deepEqual(report.profiles, []);
  await assert.rejects(access(input.lifecycleMarker));
});

test("retained qualification needs no verifier dist, build or matching checkout metadata", async context => {
  const input = await packageFixture(context, { fullRuntime: true });
  const verifier = join(input.directory, "unrelated-verifier");
  const inputs = ["scripts/run-package-browser-tests.mjs", "scripts/package-artifact.mjs",
    "scripts/package-registry.mjs", "scripts/package-registry-transport.mjs",
    "scripts/browser-harness.mjs", "scripts/browser-run-diagnostics.mjs",
    ...["package-application", "package-consumer", "runtime-fixture-server", "runtime-wasm-fixture"]
      .map(name => `js-tests/fixtures/${name}.mjs`),
    "js-tests/browser/distribution/candidate.html", "js-tests/browser/distribution/candidate.mjs",
    "js-tests/browser/distribution/python-worker.mjs"];
  for (const path of inputs) {
    await mkdir(dirname(join(verifier, path)), { recursive: true });
    await cp(join(repository, path), join(verifier, path));
  }
  await writeFile(join(verifier, "package.json"), JSON.stringify({ name: "unrelated-verifier", version: "99.0.0", private: true, type: "module" }));
  await writeFile(join(verifier, "scripts/package-distribution.mjs"), 'throw new Error("Source preparation must not execute");\n');
  await mkdir(join(verifier, "node_modules"));
  for (const name of ["typescript", "pyodide"]) await symlink(join(repository, "node_modules", name), join(verifier, "node_modules", name), "dir");
  const report = await cliProbe(input, input.bytes, input.expected,
    { TABGRAD_BROWSER: "Chrome", TABGRAD_CHROME: join(input.directory, "absent-browser") },
    join(verifier, "scripts/run-package-browser-tests.mjs"));
  assert.equal(report.failure.phase, "Chrome-availability");
  assert.equal(report.candidate.name, "@tabgrad/retained-fixture");
  assert.equal(report.candidate.version, "0.9.7");
  assert.equal(report.candidate.sourceRevision, sourceRevision);
  assert.ok(report.checks.includes("cpu-assets"));
  assert.ok(report.checks.includes("static-inventory"));
  await assert.rejects(access(join(verifier, "dist")));
});

test("invalid expected JSON is reported before admission and preserves both inputs", async context => {
  const input = await packageFixture(context);
  const report = await cliProbe(input, input.bytes, "{");
  assert.equal(report.failure.code, "EVIDENCE_INVALID");
  assert.deepEqual(report.checks, []);
  assert.deepEqual(report.profiles, []);
});

test("browser process failures keep a useful classification without raw private output", async context => {
  const input = await packageFixture(context, { fullRuntime: true });
  const browser = join(input.directory, "controlled-browser");
  await writeFile(browser, `#!/usr/bin/env node
if (process.argv.includes('--version')) console.log('Synthetic browser 1');
else { process.stderr.write(${JSON.stringify(input.directory)}); process.exit(17); }
`);
  await chmod(browser, 0o755);
  const report = await cliProbe(input, input.bytes, input.expected, { TABGRAD_BROWSER: "Chrome", TABGRAD_CHROME: browser });
  assert.equal(report.failure.code, "BROWSER_FAILED");
  assert.equal(report.failure.phase, "Chrome-direct");
  assert.equal(report.failure.browser.kind, "browser-process");
  assert.equal(report.failure.browser.exitCode, 17);
  assert.equal(report.failure.browser.profileCleanupFailed, false);
  assert.equal(report.failure.browser.terminationFailed, false);
  assert.ok(report.checks.includes("static-inventory"));
  assert.deepEqual(report.profiles, []);
});
