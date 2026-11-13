import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { siteFixture } from "../../fixtures/release-site.mjs";
import { completedRelease, releaseSiteIdentity, acquireReleaseSite, observeCompletedRelease } from "../../../scripts/release-website.mjs";
import { canonicalBytes } from "../../../scripts/release-record-data.mjs";


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
