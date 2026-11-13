import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readyFixture } from "../../fixtures/tag-release.mjs";
import { completedRelease, releaseSiteIdentity, acquireReleaseSite, observeCompletedRelease } from "../../../scripts/release-website.mjs";
import { canonicalBytes } from "../../../scripts/release-record-data.mjs";

async function siteFixture(t) {
  const f = await readyFixture(t);
  const descriptor = { schemaVersion: 1, plan: f.plan, publisher: { runId: "601", attempt: "1" },
    inventory: f.bytes.toString("base64"), releaseId: "701", environment: f.profile.tagDelivery.websiteEnvironment };
  const selected = completedRelease(descriptor);
  f.values.set("/actions/runs/601", { ...f.values.get("/actions/runs/301"), id: 601, status: "in_progress", conclusion: null });
  f.values.set("/actions/runs/601/attempts/1/jobs?per_page=100", { total_count: 1, jobs: [{ name: "complete-github-release",
    run_id: 601, head_sha: f.plan.publisher.revision, status: "completed", conclusion: "success", steps: [{
      name: `Completed release ${selected.sha256}`, status: "completed", conclusion: "success" }] }] });
  const artifact = { id: "902", sha256: "b".repeat(64) };
  f.values.set("/actions/artifacts/902", { id: 902, name: "tabgrad-publication-completion-601-1", digest: `sha256:${artifact.sha256}`, expired: false,
    workflow_run: { id: 601, head_sha: f.plan.publisher.revision, repository_id: 17 } });
  const current = { release: { id: 701, draft: false, prerelease: false, immutable: true, tag_name: f.plan.github.tag } };
  f.values.set("/releases/701", current.release);
  f.values.set(`/git/ref/tags/${f.plan.github.tag}`, { object: { type: "tag", sha: "e".repeat(40) } });
  f.values.set(`/git/tags/${"e".repeat(40)}`, { object: { type: "commit", sha: f.plan.candidate.sourceRevision } });
  const assets = [];
  for (const [index, asset] of f.plan.github.assets.entries()) {
    assets.push({ id: 1000 + index, name: asset.name, size: asset.byteLength, state: "uploaded" });
    f.values.set(`/releases/assets/${1000 + index}`, await readFile(asset.kind === "archive" ? f.tarball
      : asset.kind === "inventory" ? join(f.root, "data/candidate.json")
      : asset.kind.endsWith("-proof") ? join(f.root, "proofs", `${asset.kind}.json`)
      : join(f.root, "input", asset.kind === "evidence" ? "producer-evidence.json" : "release-checksums.txt")));
  }
  f.values.set("/releases/701/assets?per_page=100&page=1", assets);
  const api = f.api;
  return { ...f, environment: { ...f.environment, GITHUB_RUN_ID: "601" }, descriptor, selected, artifact, current, api };
}

test("completed site descriptor retains exact original inventory bytes and distinct content/recipe identities", async t => {
  const f = await siteFixture(t), identity = releaseSiteIdentity(f.descriptor);
  assert.equal(identity.sourceRevision, f.candidate.sourceRevision); assert.equal(identity.recipeRevision, f.plan.publisher.revision);
  assert.notEqual(identity.sourceRevision, identity.recipeRevision); assert.equal(identity.completionSha256, f.selected.sha256);
  for (const mutate of [d => { d.extra = true; }, d => { d.inventory = canonicalBytes(f.candidate).toString("base64"); },
    d => { d.publisher.attempt = "2"; }, d => { d.plan.candidate.version = "0.4.0"; }]) {
    const d = structuredClone(f.descriptor); mutate(d);
    // Original fixture inventory deliberately uses pretty JSON, so reserialization must fail too.
    assert.throws(() => completedRelease(d));
  }
});

test("site observes completed GitHub role without waiting for its still-running caller", async t => {
  const f = await siteFixture(t), args = { descriptor: f.descriptor, api: f.api, artifact: f.artifact, environment: f.environment };
  await observeCompletedRelease(args);
  for (const [path, mutate] of [
    ["/actions/runs/601", x => { x.run_attempt = 2; }],
    ["/actions/runs/601/attempts/1/jobs?per_page=100", x => { x.jobs[0].conclusion = "failure"; }],
    ["/actions/runs/601/attempts/1/jobs?per_page=100", x => { x.jobs[0].steps[0].name = "Completed release forged"; }],
    ["/actions/artifacts/902", x => { x.expired = true; }],
    ["/environments/website-tag-publication", x => { x.protection_rules = [{ type: "required_reviewers" }]; }],
  ]) {
    const old = structuredClone(f.values.get(path)); mutate(f.values.get(path));
    await assert.rejects(observeCompletedRelease(args)); f.values.set(path, old);
  }
  f.current.release.immutable = false; await assert.rejects(observeCompletedRelease(args));
});

test("registry acquisition hands off an owned exact tree and closes on success and failure", async t => {
  const f = await siteFixture(t); let closed = 0;
  const createApplication = async ({ expected, registryPlan }) => {
    assert.deepEqual(expected, f.candidate); assert.equal(registryPlan.channel, f.plan.npm.channel);
    return { packageDirectory: f.source, close: async () => { closed++; } };
  };
  const root = join(f.root, "site-runtime");
  const context = await acquireReleaseSite({ descriptor: f.descriptor, directory: root, createApplication });
  assert.equal(closed, 1); assert.deepEqual(context.release, releaseSiteIdentity(f.descriptor));
  assert.equal(await readFile(join(context.packageDirectory, "package.json"), "utf8"), await readFile(join(f.source, "package.json"), "utf8"));
  await writeFile(join(f.root, "not-directory"), "x");
  await assert.rejects(acquireReleaseSite({ descriptor: f.descriptor, directory: join(f.root, "site-failure"), createApplication: async () =>
    ({ packageDirectory: join(f.root, "not-directory/missing"), close: async () => { closed++; } }) }));
  assert.equal(closed, 2); assert.ok(!(await readdir(f.root)).includes("site-failure"));
});
