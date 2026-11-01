import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { releasePreparationFixture } from "../../fixtures/release-preparation.mjs";
import { selectReleaseInputs, composeReleaseInputs, releasePreparationPages, selectReleaseProducer,
  selectReleaseHistory, releaseNotes } from "../../../scripts/prepare-release.mjs";
import { publicationRegistry } from "../../../scripts/publication-registry.mjs";
import { canonicalBytes, sha256 } from "../../../scripts/release-record-data.mjs";

const ports = f => ({ api: f.api, clock: f.clock, replay: f.replay, registry: f.registry });

test("version/source compose a canonical public plan and exact execution facts without changing enrolled trust", async t => {
  const f = await releasePreparationFixture(t), before = structuredClone(f.environment);
  assert.equal((await selectReleaseInputs(f.root, f.environment, ports(f))).mode, "intent"); await f.receive();
  const result = await composeReleaseInputs(f.root, f.environment, ports(f));
  const raw = await readFile(join(f.root, "input/plan.json")), plan = JSON.parse(raw);
  assert.equal(sha256(raw), result.plan_sha256); assert.ok(canonicalBytes(plan).equals(raw));
  assert.equal(plan.candidate.version, f.candidate.version); assert.equal(plan.npm.mode, "oidc");
  assert.equal(plan.publisher.revision, f.environment.GITHUB_SHA); assert.equal(plan.owner, f.profile.maintainers[0].ownerSha256);
  assert.deepEqual(f.environment, before); assert.equal(f.replays.length, 1);
  assert.equal(f.replays[0].command, "read"); assert.equal(f.replays[0].config.root, f.profile.record.root);
  assert.equal(Object.keys(f.replays[0].config.evidence).length, 1);
  const execution = JSON.parse(await readFile(join(f.root, "input/execution.json")));
  assert.equal(execution.planSha256, result.plan_sha256); assert.equal(execution.physical.commentId, "56");
  assert.deepEqual((await readdir(join(f.root, "input"))).sort(), ["execution.json", "notes.md", "plan.json", "producer-evidence.json", "qualification.json", "release-checksums.txt"]);
  assert.equal(raw.includes(Buffer.from("operational qualification")), false);
  assert.equal(f.requests.some(route => route.endsWith("/approvals")), false);
});

test("selection is disabled by default, separates legacy epochs and requires independently enrolled trust", async t => {
  const f = await releasePreparationFixture(t);
  for (const env of [{ ...f.environment, TABGRAD_PUBLICATION_ENABLED: "false" },
    { ...f.environment, TABGRAD_RELEASE_POLICY_SHA256: "0".repeat(64) },
    { ...f.environment, TABGRAD_PUBLICATION_PLAN_JSON: "{}" }, { ...f.environment, TABGRAD_RELEASE_VERSION: "0.01.0" }]) {
    await assert.rejects(selectReleaseInputs(f.root, env, ports(f))); assert.equal(f.requests.length, 0);
  }
  const legacy = { ...f.profile, schemaVersion: 1, recipeRevision: f.environment.GITHUB_SHA,
    history: { id: "220", sha256: "0".repeat(64), expiresAt: f.history.expires_at,
      runId: "200", revision: f.history.workflow_run.head_sha, name: f.history.name } };
  delete legacy.clients;
  const env = { ...f.environment, TABGRAD_RELEASE_VERSION: "", TABGRAD_RELEASE_SOURCE: "",
    TABGRAD_RELEASE_POLICY_JSON: canonicalBytes(legacy).toString(), TABGRAD_RELEASE_POLICY_SHA256: sha256(canonicalBytes(legacy)) };
  assert.deepEqual(await selectReleaseInputs(f.root, env, ports(f)), { mode: "legacy" });
  assert.equal(f.requests.length, 0);
  await assert.rejects(selectReleaseInputs(f.root, { ...env, TABGRAD_RELEASE_VERSION: f.candidate.version }, ports(f)), { code: "PUBLICATION_MIXED_EPOCHS" });
});

test("complete keyed pagination rejects duplicate, truncated or changing observations", async () => {
  const page = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
  let n = 0; assert.equal((await releasePreparationPages({ request: async () => ++n === 1
    ? { total_count: 101, artifacts: page } : { total_count: 101, artifacts: [{ id: 101 }] } }, "/a", "artifacts")).length, 101);
  for (const last of [{ total_count: 101, artifacts: [] }, { total_count: 101, artifacts: [{ id: 1 }] },
    { total_count: 102, artifacts: [{ id: 101 }] }]) {
    n = 0; await assert.rejects(releasePreparationPages({ request: async () => ++n === 1
      ? { total_count: 101, artifacts: page } : last }, "/a?x=y", "artifacts"), { code: "PUBLICATION_PREPARATION_PAGINATION" });
  }
});

test("producer selection requires a unique exact eligible run, never the latest run", async t => {
  const f = await releasePreparationFixture(t), run = f.values.get("/actions/runs/131");
  assert.equal(selectReleaseProducer([run], f.candidate.sourceRevision, "17").id, 131);
  assert.throws(() => selectReleaseProducer([run, { ...run, id: 132 }], f.candidate.sourceRevision, "17"), { code: "PUBLICATION_PRODUCER_SELECTION" });
  assert.equal(selectReleaseProducer([run, { ...run, id: 132 }], f.candidate.sourceRevision, "17", "132").id, 132);
  for (const patch of [{ id: "131" }, { head_sha: "b".repeat(40) }, { run_attempt: 2 }, { event: "push" }, { conclusion: "failure" },
    { head_repository: { id: 18 } }, { path: ".github/workflows/other.yml" }]) {
    assert.throws(() => selectReleaseProducer([{ ...run, ...patch }], f.candidate.sourceRevision, "17"), { code: "PUBLICATION_PRODUCER_SELECTION" });
  }
});

test("history selection is a metadata transfer hint and rejects wrong carriers", async t => {
  const f = await releasePreparationFixture(t), a = f.history;
  assert.equal(selectReleaseHistory([a, { ...a, id: 221 }], "17", "", f.now).id, "221");
  assert.equal(selectReleaseHistory([a, { ...a, id: 221 }], "17", "220", f.now).id, "220");
  for (const patch of [{ expired: true }, { name: "unrelated" }, { digest: "unknown" },
    { workflow_run: { ...a.workflow_run, head_repository_id: 18 } }]) assert.throws(() => selectReleaseHistory([{ ...a, ...patch }], "17", "", f.now));
});

for (const [name, mutate, code] of [
  ["changed main", f => { f.values.get("/git/ref/heads/main").object.sha = "d".repeat(40); }, "PUBLICATION_MAIN_MOVED"],
  ["changed protection", f => { f.values.get("/environments/tabgrad-npm-publication").can_admins_bypass = true; }, "PUBLICATION_PROTECTION_INVALID"],
  ["missing physical observation", f => { f.values.set("/issues/55/comments", []); }, "PUBLICATION_PHYSICAL_EVIDENCE_REQUIRED"],
  ["wrong physical candidate", f => { f.comment.body = f.comment.body.replace(f.candidate.tarball.sha256, "0".repeat(64)); }, "PUBLICATION_QUALIFICATION_MISMATCH"],
  ["failed source checks", f => { f.values.get("/actions/runs/401/attempts/1/jobs?per_page=100").jobs[1].conclusion = "failure"; }, "PUBLICATION_SOURCE_CHECKS_INVALID"],
]) test(`composition stops on ${name} before protected admission`, async t => {
  const f = await releasePreparationFixture(t); await selectReleaseInputs(f.root, f.environment, ports(f)); await f.receive(); mutate(f);
  await assert.rejects(composeReleaseInputs(f.root, f.environment, ports(f)), { code }); assert.equal(f.replays.length, 0);
});

test("selection cannot replace source notes, responsible owner or the complete current history", async t => {
  for (const field of ["notesSha256", "owner"]) {
    const f = await releasePreparationFixture(t); await selectReleaseInputs(f.root, f.environment, ports(f)); await f.receive();
    const path = join(f.root, "selection.json"), s = JSON.parse(await readFile(path)); s[field] = "forged";
    await writeFile(path, canonicalBytes(s)); await assert.rejects(composeReleaseInputs(f.root, f.environment, ports(f)), { code: "PUBLICATION_PREPARATION_CHANGED" });
  }
  const f = await releasePreparationFixture(t); await selectReleaseInputs(f.root, f.environment, ports(f)); await f.receive();
  await assert.rejects(composeReleaseInputs(f.root, f.environment, { ...ports(f), replay: async () => ({ head: "a".repeat(40),
    checkpoint: { activeOperation: "unfinished", blockingUnresolvedCalls: 0, conflictingCalls: 0 } }) }), { code: "PUBLICATION_RECORD_BLOCKED" });
});

test("notes come from one committed version section and link to that source", () => {
  assert.equal(releaseNotes("# Log\n\n## 0.1.3 - Today\n\nSee [guide](docs/guide.md).\n\n## 0.1.2 - Before\nOld\n", "0.1.3", "example/project", "a".repeat(40)),
    `## 0.1.3 - Today\n\nSee [guide](https://github.com/example/project/blob/${"a".repeat(40)}/docs/guide.md).\n`);
  assert.throws(() => releaseNotes("## 0.1.3 - A\n\n## 0.1.3 - B\n", "0.1.3", "example/project", "a".repeat(40)), { code: "PUBLICATION_SOURCE_NOTES" });
});

test("ordinary registry intent rejects 404, used and withdrawn versions", async () => {
  const pack = { name: "@example/package", versions: {}, "dist-tags": { latest: "0.1.2" }, time: {} };
  const registry = publicationRegistry({ fetcher: async () => new Response(JSON.stringify(pack)) });
  assert.deepEqual(await registry.startingState(pack.name, "0.1.3", "latest"), { package: "existing", version: "absent", channel: "0.1.2" });
  pack.time["0.1.3"] = "used"; await assert.rejects(registry.startingState(pack.name, "0.1.3", "latest"), { code: "PUBLICATION_REGISTRY_CONFLICT" });
  delete pack.time["0.1.3"]; pack.time.unpublished = { versions: ["0.1.3"] };
  await assert.rejects(registry.startingState(pack.name, "0.1.3", "latest"), { code: "PUBLICATION_REGISTRY_CONFLICT" });
  await assert.rejects(publicationRegistry({ fetcher: async () => new Response("{}", { status: 404 }) }).startingState(pack.name, "0.1.3", "latest"),
    { code: "PUBLICATION_REGISTRY_VISIBILITY_UNKNOWN" });
});

// Real role entry + HTTP adapter + staged files. Provider observations are closed
// data; this does not attest a live service run, signature or protected approval.
test("generated snapshot reaches the actual precheck role and cannot bypass protected admission", async t => {
  const f = await releasePreparationFixture(t);
  f.profile.clients.controller = sha256(await readFile(process.execPath));
  f.environment.TABGRAD_RELEASE_POLICY_JSON = canonicalBytes(f.profile).toString();
  f.environment.TABGRAD_RELEASE_POLICY_SHA256 = sha256(Buffer.from(f.environment.TABGRAD_RELEASE_POLICY_JSON));
  await selectReleaseInputs(f.root, f.environment, ports(f)); await f.receive();
  const result = await composeReleaseInputs(f.root, f.environment, ports(f));
  const rows = structuredClone([...f.values]);
  for (const revision of [f.candidate.sourceRevision, f.environment.GITHUB_SHA]) rows.push([
    `/git/commits/${revision}`, { sha: revision, tree: { sha: "4".repeat(40) } }]);
  rows.push([`/git/trees/${"4".repeat(40)}`, { sha: "4".repeat(40), truncated: false,
    tree: [{ path: ".github", type: "tree", sha: "5".repeat(40) }] }]);
  rows.push([`/git/trees/${"5".repeat(40)}`, { sha: "5".repeat(40), truncated: false,
    tree: [{ path: "workflows", type: "tree", sha: "6".repeat(40) }] }]);
  rows.push(["/actions/runs/301/approvals", []]);
  const model = join(f.directory, "provider.json"), wrapper = join(f.directory, "role.mjs");
  await writeFile(model, JSON.stringify(rows));
  await writeFile(wrapper, `import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const values = new Map(JSON.parse(readFileSync(${JSON.stringify(model)})));
globalThis.fetch = async (url, options) => {
  assert.equal(options.method, "GET"); assert.equal(url.origin, "https://api.github.com");
  const route = url.pathname.slice("/repos/example/project".length) + url.search;
  assert.ok(values.has(route), route); return new Response(JSON.stringify(values.get(route)));
};
const { publicationRole } = await import(${JSON.stringify(fileURLToPath(new URL("../../../scripts/release-publication.mjs", import.meta.url)))});
try { console.log(JSON.stringify(await publicationRole(process.argv[2], process.argv[3]))); }
catch (error) { console.log(JSON.stringify({code:error.code})); process.exitCode=1; }
`);
  const env = { PATH: process.env.PATH, ...f.environment, GH_TOKEN: "synthetic-read-token",
    TABGRAD_PUBLICATION_PLAN_SHA256: result.plan_sha256, GITHUB_STEP_SUMMARY: join(f.directory, "summary.md") };
  const precheck = spawnSync(process.execPath, [wrapper, "precheck", f.root], { env, encoding: "utf8", timeout: 10000 });
  assert.equal(precheck.status, 0, precheck.stdout + precheck.stderr);
  assert.equal(JSON.parse(precheck.stdout).status, "unapproved-precheck");
  assert.ok((await readFile(env.GITHUB_STEP_SUMMARY, "utf8")).includes(result.plan_sha256));
  const admit = spawnSync(process.execPath, [wrapper, "admit", f.root], { env: { ...env, GITHUB_JOB: "admit" }, encoding: "utf8", timeout: 10000 });
  assert.equal(admit.status, 1, admit.stdout + admit.stderr);
  assert.equal(JSON.parse(admit.stdout).code, "PUBLICATION_ENVIRONMENT_REVIEW_INVALID");
});

test("valid long release notes stay outside the bounded selection record without truncation", async t => {
  const f = await releasePreparationFixture(t);
  const notes = `## ${f.candidate.version} - 2026-01-01\n\n${"Useful change.\n".repeat(8192)}`;
  const raw = Buffer.from(notes);
  f.values.set(`/contents/CHANGELOG.md?ref=${f.candidate.sourceRevision}`, {
    type: "file", encoding: "base64", content: raw.toString("base64"), size: raw.length });
  await selectReleaseInputs(f.root, f.environment, ports(f)); await f.receive();
  await composeReleaseInputs(f.root, f.environment, ports(f));
  assert.equal((await readFile(join(f.root, "input/notes.md"), "utf8")), notes);
  assert.ok((await readFile(join(f.root, "selection.json"))).length < 65536);
});

test("pagination accepts a complete collection at its exact cap and rejects incomplete or over-cap collections", async () => {
  for (const total of [100, 10000]) {
    let calls = 0;
    const rows = await releasePreparationPages({ request: async () => {
      const start = calls++ * 100; return { total_count: total, artifacts: Array.from({ length: 100 }, (_, i) => ({ id: start + i + 1 })) };
    } }, "/artifacts", "artifacts");
    assert.equal(rows.length, total); assert.equal(calls, total / 100);
  }
  let calls = 0;
  await assert.rejects(releasePreparationPages({ request: async () => {
    const start = calls++ * 100; return { total_count: 10000,
      artifacts: Array.from({ length: calls === 100 ? 99 : 100 }, (_, i) => ({ id: start + i + 1 })) };
  } }, "/artifacts", "artifacts"), { code: "PUBLICATION_PREPARATION_PAGINATION" });
  assert.equal(calls, 100);
  calls = 0;
  await assert.rejects(releasePreparationPages({ request: async () => { calls++;
    return { total_count: 10001, artifacts: Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) };
  } }, "/artifacts", "artifacts"), { code: "PUBLICATION_PREPARATION_PAGINATION" });
  assert.equal(calls, 1);
});
