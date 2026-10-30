import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { publicationEnvironment } from "../../../scripts/publication-client.mjs";
import { publicationContext, publicationRoleJob } from "../../../scripts/release-publication.mjs";
const entry = fileURLToPath(new URL("../../../scripts/release-publication.mjs", import.meta.url));

test("each maintained command selects its actual recipe job without changing the shared gate context", async () => {
  const recipe = await readFile(new URL("../../../.github/workflows/release-publication.yml", import.meta.url), "utf8");
  const jobs = new Map(), commands = new Set();
  let jobId, jobName;
  // This checks the declared command/job relationship in the maintained recipe;
  // an unrecognized layout must lose discovery and fail, not silently qualify it.
  for (const line of recipe.split("\n")) {
    const job = /^  ([a-z_]+):$/.exec(line);
    if (job) { jobId = job[1]; jobName = undefined; }
    const name = /^    name: ([a-z-]+)$/.exec(line);
    if (name) { jobName = name[1]; jobs.set(jobId, jobName); }
    const command = /run: node scripts\/release-publication\.mjs ([a-z-]+) /.exec(line);
    if (command) {
      assert.ok(jobName); assert.equal(publicationRoleJob(command[1]), jobName);
      commands.add(command[1]);
    }
  }
  assert.equal(jobs.size, 8); assert.equal(commands.size, 12);
  assert.equal(publicationRoleJob("human"), jobs.get("bootstrap"));
  assert.throws(() => publicationRoleJob("unrecognized"), { code: "PUBLICATION_ROLE_CONTEXT" });
  const environment = { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "a".repeat(40), GITHUB_WORKFLOW_REF: "example/repo/.github/workflows/release-publication.yml@refs/heads/main",
    GITHUB_RUN_ID: "301", GITHUB_RUN_ATTEMPT: "1", GITHUB_REPOSITORY_ID: "17" };
  assert.deepEqual(publicationContext({ ...environment, GITHUB_JOB: "npm" }),
    publicationContext({ ...environment, GITHUB_JOB: "gate" }));
  assert.equal(Object.hasOwn(publicationContext(environment), "activeJobName"), false);
});

test("actual CLI is inert by default for every CI role, creates no files and exposes only a bounded code", async t => {
  const root = await mkdtemp(join(tmpdir(), "tabgrad-publication-entry-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const role of ["precheck", "admit", "npm", "bootstrap", "observe", "consume", "complete"]) {
    const result = spawnSync(process.execPath, [entry, role, root], { env: publicationEnvironment(root), encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 1, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.code, "PUBLICATION_DISABLED"); assert.equal(body.status, "failed");
    assert.equal(result.stderr, ""); assert.equal(result.stdout.includes(root), false);
    assert.deepEqual(await readdir(root), []);
  }
});
