import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyValidationPaths, selectValidationScope } from "../../../scripts/validation-scope.mjs";

test("prose and native tooling tests retain consistency without unrelated runtime or browser work", () => {
  const scope = classifyValidationPaths([
    "docs/architecture/execution-lifecycle.md", "README.md", "AGENTS.md",
    ".github/ISSUE_TEMPLATE/maintenance.yml", ".github/pull_request_template.md", "assets/brand/tabgrad-logo.svg",
    "tests/test_repository_checks.py",
  ]);
  assert.deepEqual(scope, { runtime: false, browser: false, reason: "consistency-only" });
});

test("Node cases need runtime validation while unchanged browser code is not exercised", () => {
  assert.deepEqual(classifyValidationPaths(["docs/quality.md", "js-tests/unit/nested/contract.test.mjs"]),
    { runtime: true, browser: false, reason: "unit-tests-only" });
});

test("shared, distribution, browser, selection and unknown changes keep both families", () => {
  for (const path of ["src/runtime/runtime.ts", "python/torch/__init__.py", "rust/lib.rs", "package-lock.json",
    "js-tests/browser/example.html", "scripts/validation-scope.mjs", ".github/workflows/repository-checks.yml",
    "docs/example.mjs", "docs-next/page.md", "assets/brand/example.js", "unknown.md"]) {
    const scope = classifyValidationPaths(["docs/quality.md", path]);
    assert.equal(scope.runtime, true, path);
    assert.equal(scope.browser, true, path);
  }
});

test("empty or invalid path inputs cannot become exclusions", () => {
  for (const paths of [[], [""], ["/docs/page.md"], ["docs/../page.md"], ["docs//page.md"], ["docs\\page.md"], ["docs/x\0.md"]]) {
    assert.deepEqual(classifyValidationPaths(paths), { runtime: true, browser: true, reason: "empty-or-invalid-comparison" });
  }
});

/** @param {import("node:test").TestContext} context */
async function repositoryFixture(context) {
  const root = await fs.mkdtemp(join(tmpdir(), "tabgrad-validation-scope-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Validation fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  const write = async (path, content = "fixture\n") => {
    await fs.mkdir(dirname(join(root, path)), { recursive: true });
    await fs.writeFile(join(root, path), content);
  };
  const commit = () => { git("add", "--all"); git("commit", "--quiet", "-m", "fixture"); return git("rev-parse", "HEAD"); };
  await write("README.md");
  const base = commit();
  return { root, git, write, commit, base };
}

test("actual Git comparisons include newline filenames, deletion and both sides of renames", async (context) => {
  const repo = await repositoryFixture(context);
  await repo.write("docs/café\npage.md");
  let head = repo.commit();
  const select = (base, target = head) => selectValidationScope({ event: "pull_request", base, head: target, repository: repo.root });
  assert.equal(select(repo.base).runtime, false);
  await repo.write("src/component.ts");
  const source = repo.commit();
  await fs.rename(join(repo.root, "src/component.ts"), join(repo.root, "docs/moved.md"));
  head = repo.commit();
  assert.equal(select(source).runtime, true, "a source-to-doc rename includes the removed executable path");
  assert.equal(select(source).browser, true);
  await repo.write("src/deleted.ts");
  const beforeDeletion = repo.commit();
  await fs.rm(join(repo.root, "src/deleted.ts"));
  head = repo.commit();
  assert.equal(select(beforeDeletion).browser, true, "an executable deletion still needs execution coverage");
  await fs.rm(join(repo.root, "docs/moved.md"));
  const previous = head;
  head = repo.commit();
  assert.equal(select(previous).runtime, false, "a pure documentation deletion is still classified");
  assert.equal(select(head).runtime, true, "an empty diff is not evidence for exclusion");
  assert.equal(select(repo.base, source).runtime, true, "a different checkout head cannot support exclusions");
  assert.equal(select("0".repeat(40)).browser, true, "an unavailable base cannot support exclusions");
  repo.git("checkout", "--quiet", "--orphan", "unrelated");
  repo.git("rm", "--quiet", "-rf", ".");
  await repo.write("README.md");
  const unrelated = repo.commit();
  assert.equal(selectValidationScope({ event: "pull_request", base: repo.base, head: unrelated, repository: repo.root }).browser,
    true, "an unrelated history cannot support exclusions");
});

test("the actual merged checkout, not a guessed PR-head diff, determines applicability", async (context) => {
  const repo = await repositoryFixture(context);
  const main = repo.git("branch", "--show-current");
  repo.git("checkout", "--quiet", "-b", "candidate");
  await repo.write("docs/change.md");
  const candidate = repo.commit();
  repo.git("checkout", "--quiet", main);
  await repo.write("src/new-base.ts");
  const advancedBase = repo.commit();
  repo.git("merge", "--quiet", "--no-edit", "candidate");
  const merge = repo.git("rev-parse", "HEAD");
  assert.equal(selectValidationScope({ event: "pull_request", base: advancedBase, head: merge, repository: repo.root }).runtime, false);
  assert.equal(selectValidationScope({ event: "pull_request", base: repo.base, head: merge, repository: repo.root }).runtime, true);
  assert.equal(selectValidationScope({ event: "pull_request", base: advancedBase, head: candidate, repository: repo.root }).runtime, true);
});

test("main, manual, unknown or malformed events and unavailable repositories require all", () => {
  for (const event of [undefined, "push", "workflow_dispatch", "unknown", "pull_request_target"]) {
    assert.equal(selectValidationScope({ event }).browser, true);
  }
  for (const base of [undefined, "main", "--output=other", "x".repeat(40)]) {
    assert.equal(selectValidationScope({ event: "pull_request", base, head: "a".repeat(40) }).runtime, true);
  }
  assert.equal(selectValidationScope({ event: "pull_request", base: "a".repeat(40), head: "b".repeat(40), repository: "/nonexistent-validation-fixture" }).browser, true);
});

test("CLI publishes categorical outputs and distinguishes non-applicability from a test pass", async (context) => {
  const repo = await repositoryFixture(context);
  await repo.write("docs/change.md");
  const head = repo.commit();
  const command = fileURLToPath(new URL("../../../scripts/validation-scope.mjs", import.meta.url));
  const output = join(repo.root, "outputs");
  const env = { ...process.env, GITHUB_OUTPUT: output, TABGRAD_VALIDATION_EVENT: "pull_request", TABGRAD_VALIDATION_BASE: repo.base, TABGRAD_VALIDATION_HEAD: head };
  const decision = spawnSync(process.execPath, [command], { cwd: repo.root, env, encoding: "utf8", timeout: 5000 });
  assert.equal(decision.status, 0, decision.stderr);
  assert.deepEqual(JSON.parse(decision.stdout), { runtime: false, browser: false, reason: "consistency-only" });
  assert.equal(await fs.readFile(output, "utf8"), "runtime=false\nbrowser=false\nreason=consistency-only\n");
  const report = spawnSync(process.execPath, [command, "--report", "runtime"], { env: { ...env, TABGRAD_VALIDATION_RUNTIME: "false" }, encoding: "utf8" });
  assert.equal(report.status, 0);
  assert.deepEqual(JSON.parse(report.stdout), { family: "runtime", applicability: "not-applicable" });
  for (const value of ["", "unknown", "false\ntrue"]) {
    const invalid = spawnSync(process.execPath, [command, "--report", "browser"], { env: { ...env, TABGRAD_VALIDATION_BROWSER: value }, encoding: "utf8" });
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, "");
  }
  const failedRecording = spawnSync(process.execPath, [command], {
    cwd: repo.root, env: { ...env, GITHUB_OUTPUT: join(repo.root, "missing", "output") }, encoding: "utf8",
  });
  assert.equal(failedRecording.status, 1);
  assert.match(failedRecording.stderr, /Unable to record validation applicability outputs/);
  assert.equal(failedRecording.stderr.includes(repo.root), false, "no local path or stack is logged");
});
