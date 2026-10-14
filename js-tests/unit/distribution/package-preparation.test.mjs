import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function command(executable, arguments_, cwd) {
  const result = spawnSync(executable, arguments_, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

async function sourceFixture(context, buildFails = false) {
  const directory = await mkdtemp(join(tmpdir(), "tabgrad-candidate-source-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source");
  await mkdir(join(source, "scripts"), { recursive: true });
  await mkdir(join(source, "docs/reference"), { recursive: true });
  await copyFile(new URL("../../../scripts/package-distribution.mjs", import.meta.url), join(source, "scripts/package-distribution.mjs"));
  await writeFile(join(source, ".node-version"), `${process.versions.node}\n`);
  await writeFile(join(source, ".gitignore"), "dist/\n");
  await writeFile(join(source, "LICENSE"), "synthetic package fixture\n");
  await writeFile(join(source, "README.md"), "checkout-only README\n");
  await writeFile(join(source, "docs/reference/browser-package.md"), "Package fixture documentation.\n");
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "@tabgrad/candidate-fixture", version: "0.0.0", private: true, type: "module",
    packageManager: "npm@11.1.0", files: ["dist/"], exports: { ".": "./dist/index.js" }, scripts: { build: "node build.mjs" } }));
  await writeFile(join(source, "build.mjs"), buildFails ? "process.exit(9);\n" : `import { mkdir, writeFile } from "node:fs/promises";
await mkdir("dist", {recursive:true}); await writeFile("dist/index.js", "export const value = 11;\\n");\n`);
  command("git", ["init", "-q"], source);
  command("git", ["config", "user.name", "Tabgrad test"], source);
  command("git", ["config", "user.email", "test@example.invalid"], source);
  command("git", ["add", "."], source);
  command("git", ["commit", "-qm", "Create synthetic candidate source"], source);
  return { directory, source, script: join(source, "scripts/package-distribution.mjs") };
}

test("clean candidate preparation pairs inspected npm and static bytes reproducibly", async context => {
  const fixture = await sourceFixture(context);
  const outputs = [join(fixture.directory, "first"), join(fixture.directory, "second")];
  const reports = [];
  for (const output of outputs) {
    command(process.execPath, [fixture.script, output], fixture.source);
    const report = JSON.parse(await readFile(join(output, "candidate.json"), "utf8"));
    assert.equal(report.sourceRevision, command("git", ["rev-parse", "HEAD"], fixture.source).trim());
    assert.equal(report.private, true);
    assert.equal(report.staticDirectory, "package/dist");
    for (const file of report.files) {
      const bytes = await readFile(join(output, "package", file.path));
      assert.equal(bytes.length, file.byteLength);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
    }
    const bytes = await readFile(join(output, report.tarball.path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), report.tarball.sha256);
    const metadata = JSON.parse(await readFile(join(output, "package/package.json"), "utf8"));
    assert.equal(metadata.scripts, undefined);
    await assert.rejects(access(join(output, ".npm-cache")));
    reports.push(report);
  }
  assert.deepEqual(reports[0], reports[1]);
  assert.deepEqual(await readFile(join(outputs[0], reports[0].tarball.path)), await readFile(join(outputs[1], reports[1].tarball.path)));
});

test("dirty source is rejected before candidate output is created", async context => {
  const fixture = await sourceFixture(context);
  await writeFile(join(fixture.source, "README.md"), "changed source\n");
  const output = join(fixture.directory, "candidate");
  const result = spawnSync(process.execPath, [fixture.script, output], { cwd: fixture.source, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires a clean identified source tree/);
  await assert.rejects(access(output));
});

test("existing candidate output is not overwritten or deleted", async context => {
  const fixture = await sourceFixture(context);
  const output = join(fixture.directory, "candidate");
  await mkdir(output);
  await writeFile(join(output, "sentinel"), "keep");
  const result = spawnSync(process.execPath, [fixture.script, output], { cwd: fixture.source, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(join(output, "sentinel"), "utf8"), "keep");
});

test("failed preparation removes owned partial output and preserves other files", async context => {
  const fixture = await sourceFixture(context, true);
  const output = join(fixture.directory, "candidate");
  await writeFile(join(fixture.directory, "sentinel"), "keep");
  const result = spawnSync(process.execPath, [fixture.script, output], { cwd: fixture.source, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  await assert.rejects(access(output));
  assert.equal(await readFile(join(fixture.directory, "sentinel"), "utf8"), "keep");
});
