import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publicationPlanFixture } from "../../fixtures/publication.mjs";
import { canonicalBytes, sha256 } from "../../../scripts/release-record-data.mjs";
import { releaseRecord, locationIdentity } from "../../../scripts/release-record.mjs";
import { publicationRecord } from "../../../scripts/publication-record.mjs";

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), "tabgrad-publication-record-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const location = join(directory, "destination.git"); await mkdir(location);
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "init", "--bare", "--template=", location],
    { encoding: "utf8", env: { PATH: process.env.PATH, HOME: directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  assert.equal(result.status, 0, result.stderr);
  const f = publicationPlanFixture();
  const config = { schemaVersion: 1, protocol: "file", ref: "refs/heads/release-control-fixture",
    location, root: null, writerPolicy: "", evidence: {} };
  const retain = async value => {
    const bytes = canonicalBytes(value), identity = sha256(bytes), path = join(directory, `${identity}.json`);
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); config.evidence[identity] = path;
    return identity;
  };
  config.writerPolicy = await retain({ fixture: "trusted writer" });
  const priorEffects = await retain({ fixture: "no effects before enrollment" });
  f.publicationPlan.authority = await retain({ fixture: "opaque approval identity" });
  f.publicationPlan.owner = await retain({ fixture: "opaque responsible owner" });
  const locationHash = await retain({ location, ref: config.ref, protocol: config.protocol });
  assert.equal(locationHash, locationIdentity(config));
  const event = { type: "enroll", at: new Date(f.now).toISOString(), location: locationHash,
    writerPolicy: config.writerPolicy, priorEffects };
  const inputBytes = canonicalBytes({ schemaVersion: 1, event });
  const root = await releaseRecord({ command: "enroll", config, expectedHead: "absent", inputBytes,
    inspected: sha256(inputBytes), clock: () => f.now });
  config.root = root.root;
  const policy = { record: { location, root: root.root, protocol: config.protocol, ref: config.ref },
    writerPolicySha256: config.writerPolicy };
  const authorityObservation = { ...f.authority, authority: f.publicationPlan.authority, owner: f.publicationPlan.owner,
    writerPolicySha256: policy.writerPolicySha256, planSha256: sha256(canonicalBytes(f.publicationPlan)) };
  return { directory, config, policy, authorityObservation, expectedHead: root.head, plan: f.publicationPlan, clock: () => f.now,
    now: f.now };
}

function approvedPlan(f, plan) {
  return { ...f, plan, authorityObservation: { ...f.authorityObservation, planSha256: sha256(canonicalBytes(plan)),
    authority: plan.authority, owner: plan.owner, window: plan.window } };
}

test("actual Git: published intent/observation bind full approved plan and retained evidence", async context => {
  const f = await fixture(context);
  const record = await publicationRecord(f);
  const effect = record.effects[0];
  const call = await record.intent(effect);
  await record.observe(call, effect, "verified-effect", { fixture: "observed exact call" });
  const replay = await releaseRecord({ command: "read", config: record.config, expectedHead: record.head, clock: f.clock });
  assert.equal(replay.operations[0].calls[0].outcome, "verified-effect");
  assert.equal(replay.checkpoint.unresolvedCalls, 0);
  const changed = structuredClone(f.plan); changed.publisher.clientSha256 = "e".repeat(64);
  await assert.rejects(publicationRecord({ ...approvedPlan(f, changed), config: record.config, expectedHead: record.head }),
    { code: "PUBLICATION_RECORD_OPERATION_CHANGED" });
});

test("actual Git: unknown write cannot be closed or reset by a new operation", async context => {
  const f = await fixture(context), record = await publicationRecord(f), effect = record.effects[0];
  const call = await record.intent(effect);
  await record.observe(call, effect, "unknown", { fixture: "connection lost after dispatch" });
  await assert.rejects(record.close("abandoned", { fixture: "cannot prove closure" }), { code: "CALL_UNSETTLED" });
  await assert.rejects(publicationRecord({ ...approvedPlan(f, { ...f.plan, operation: "e".repeat(64) }),
    expectedHead: record.head, config: record.config }), { code: "PUBLICATION_RECORD_UNSETTLED" });
});

test("actual Git: competing recorder cursor fails before admitting another distribution call", async context => {
  const f = await fixture(context), first = await publicationRecord(f);
  const second = await publicationRecord({ ...f, config: first.config, expectedHead: first.head });
  await first.intent(first.effects[0]);
  await assert.rejects(second.intent(second.effects[0]), { code: "STALE_HEAD" });
});

test("actual Git: new explicit continuation preserves a known npm success without republishing", async context => {
  const f = await fixture(context), first = await publicationRecord(f), effect = first.effects[0];
  const call = await first.intent(effect);
  await first.observe(call, effect, "verified-effect", { fixture: "original successful npm call" });
  const closure = { fixture: "remaining GitHub actions not started" };
  await first.close("abandoned", closure);
  const plan = structuredClone(f.plan);
  plan.operation = "f".repeat(64);
  plan.npm.mode = "observe";
  plan.npm.before = { package: "existing", version: "matching", channel: plan.candidate.version };
  plan.continuation = { operation: f.plan.operation, evidenceSha256: sha256(canonicalBytes(closure)) };
  plan.window.deadline = new Date(f.now + 40 * 60 * 1000).toISOString();
  plan.producer.verification.expiresAt = new Date(f.now + 50 * 60 * 1000).toISOString();
  const wrongClosure = structuredClone(plan); wrongClosure.continuation.evidenceSha256 = f.plan.owner;
  await assert.rejects(publicationRecord({ ...approvedPlan(f, wrongClosure), config: first.config, expectedHead: first.head }),
    { code: "PUBLICATION_CONTINUATION_UNPROVEN" });
  const continued = await publicationRecord({ ...approvedPlan(f, plan), config: first.config, expectedHead: first.head });
  assert.equal(continued.complete.has(effect.identity), true);
  await assert.rejects(continued.intent(effect), { code: "PUBLICATION_EFFECT_ALREADY_COMPLETE" });
  const replay = await releaseRecord({ command: "read", config: continued.config, expectedHead: continued.head, clock: f.clock });
  assert.equal(replay.operations[1].admission.effects.includes(effect.identity), false);
});

for (const [name, change] of [
  ["window", replay => { replay.operations[0].admission.window.deadline = new Date(Date.now() + 120000).toISOString(); }],
  ["unapproved effect", replay => { replay.operations[0].admission.effects[0] = "0".repeat(64); }],
]) test(`historical full-plan admission rejects a substituted ${name} before another event`, async context => {
  const f = await fixture(context), record = await publicationRecord(f);
  const replay = await releaseRecord({ command: "read", config: record.config, expectedHead: record.head, clock: f.clock });
  change(replay);
  let reads = 0;
  await assert.rejects(publicationRecord({ ...f, config: record.config, expectedHead: record.head,
    protocol: async request => { assert.equal(request.command, "read"); reads++; return replay; } }),
  { code: "PUBLICATION_HISTORY_AUTHORITY_INVALID" });
  assert.equal(reads, 1);
});

test("historical full-plan original must remain available and a different run cannot adopt an active operation", async context => {
  const f = await fixture(context), record = await publicationRecord(f);
  const config = record.config;
  delete config.evidence[sha256(canonicalBytes(f.plan))];
  await assert.rejects(publicationRecord({ ...f, config, expectedHead: record.head }), { code: "PUBLICATION_PLAN_EVIDENCE_MISSING" });
  await assert.rejects(publicationRecord({ ...f, config: record.config, expectedHead: record.head,
    authorityObservation: { ...f.authorityObservation, runId: "302" } }), { code: "PUBLICATION_RECORD_OPERATION_CHANGED" });
});

test("actual Git: authenticated late outcome is conserved but does not authorize another intent", async context => {
  const { recordNpmPublication, transferPublicationHistory } = await import("../../../scripts/publication-controller.mjs");
  const { npmCallReceipt } = await import("../../../scripts/publication-effects.mjs");
  const f = await fixture(context), record = await publicationRecord(f), effect = record.effects[0];
  const call = await record.intent(effect);
  const handoff = { schemaVersion: 1, operation: f.plan.operation, planSha256: sha256(canonicalBytes(f.plan)),
    call, effect: effect.identity, recordHead: record.head };
  const receipt = npmCallReceipt(f.plan, handoff, { manifestSha256: f.plan.publisher.clientSha256 }, { dispatched: true, status: 0,
    stdout: JSON.stringify({ [f.plan.candidate.name]: { name: f.plan.candidate.name, version: f.plan.candidate.version,
      integrity: `sha512-${Buffer.from(f.plan.candidate.archiveSha512, "hex").toString("base64")}` } }) });
  receipt.status = "passed"; receipt.cleanup = "completed";
  let authenticated = 0;
  const lateClock = () => Date.parse(f.plan.window.deadline) + 1000;
  const result = await recordNpmPublication({ ...f, config: record.config, expectedHead: record.head, handoff, receipt,
    clock: lateClock, authenticateReceipt: async () => { authenticated++; } });
  assert.equal(result.outcome, "verified-effect"); assert.equal(authenticated, 1);
  const replay = await releaseRecord({ command: "read", config: result.config, expectedHead: result.head, clock: lateClock });
  assert.equal(replay.checkpoint.unresolvedCalls, 0);
  await assert.rejects(publicationRecord({ ...f, config: result.config, expectedHead: result.head, clock: lateClock }),
    { code: "PUBLICATION_AUTHORITY_INVALID" });
  const backup = join(f.directory, "backup");
  assert.ok(await transferPublicationHistory(f.directory + "/missing", backup).then(() => false, () => true));
  // Only a closed hash-file directory can be handed to another role.
  const originals = join(f.directory, "originals"); await mkdir(originals);
  const { copyFile } = await import("node:fs/promises");
  for (const [identity, path] of Object.entries(result.config.evidence)) await copyFile(path, join(originals, `${identity}.json`));
  assert.equal(await transferPublicationHistory(originals, backup), Object.keys(result.config.evidence).length);
  await writeFile(join(backup, `${f.plan.owner}.json`), "substituted");
  await assert.rejects(transferPublicationHistory(originals, backup));
});
