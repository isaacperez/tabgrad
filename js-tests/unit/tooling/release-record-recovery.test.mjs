import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { recoveryFixture, recoveryEvent, invokeRecovery, retainRecoveryOriginal } from "../../fixtures/release-record-recovery.mjs";
import { releaseRecord } from "../../../scripts/release-record.mjs";
import { canonicalBytes, planBytes, sha256 } from "../../../scripts/release-record-data.mjs";
import { publicationRecord } from "../../../scripts/publication-record.mjs";
import { prepareNpmCall, requireNpmIntent } from "../../../scripts/publication-effects.mjs";
import { recordNpmPublication } from "../../../scripts/publication-controller.mjs";
import { npmCallReceipt } from "../../../scripts/publication-effects.mjs";

function git(f, arguments_) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "--git-dir", f.config.location, ...arguments_],
    { encoding: "utf8", env: { PATH: process.env.PATH, HOME: f.directory,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1" } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function append(f, event) {
  const inputBytes = canonicalBytes({ schemaVersion: 1, event });
  const result = await releaseRecord({ command: "append", config: f.config, expectedHead: f.expectedHead,
    inputBytes, inspected: sha256(inputBytes), clock: f.recoveryClock });
  f.expectedHead = result.head;
  return result;
}

async function handoff(f) {
  const result = await invokeRecovery(f, await recoveryEvent(f));
  assert.equal(result.status, "confirmed");
  f.expectedHead = result.head;
  f.config.writerPolicy = f.nextWriterPolicy;
  return result;
}

async function future(f) {
  const effect = await retainRecoveryOriginal(f, { fixture: "different future version effect" });
  const candidate = await retainRecoveryOriginal(f, { fixture: "different future version candidate" });
  // Only the generic recorder's admitted open data, with its own new window/identity.
  const opened = { type: "open", at: new Date(f.recoveryNow).toISOString(), operation: "9".repeat(64),
    candidate, authority: f.decision.operation, owner: f.decision.operation, effects: [effect], window: f.window };
  const old = await releaseRecord({ command: "read", config: f.config, expectedHead: f.expectedHead, clock: f.recoveryClock });
  opened.authority = old.operations[0].admission.authority;
  opened.owner = old.operations[0].admission.owner;
  opened.plan = sha256(planBytes(opened));
  await retainRecoveryOriginal(f, JSON.parse(planBytes(opened)));
  await append(f, opened);
  return { opened, effect };
}

function futurePublisher(f) {
  const plan = structuredClone(f.plan);
  plan.operation = "4".repeat(64); plan.window = f.window;
  plan.candidate.version = "0.9.8"; plan.candidate.inventorySha256 = "3".repeat(64);
  plan.candidate.archiveSha512 = "2".repeat(128);
  plan.npm.mode = "oidc"; plan.npm.before = { package: "existing", version: "absent", channel: f.plan.candidate.version };
  plan.github.tag = "v0.9.8";
  const authorityObservation = { ...f.authorityObservation, planSha256: sha256(canonicalBytes(plan)),
    window: f.window, writerPolicySha256: f.nextWriterPolicy, runId: "302" };
  return { ...f, plan, policy: { ...f.policy, writerPolicySha256: f.nextWriterPolicy },
    authorityObservation, clock: f.recoveryClock };
}

test("real Git handoff preserves v1 prefix/UNKNOWN and uses a new policy for future calls", async context => {
  const f = await recoveryFixture(context), oldHead = f.expectedHead;
  const oldFrame = git(f, ["show", `${oldHead}:checkpoint.json`]);
  const result = await handoff(f);
  assert.equal(result.root, f.config.root);
  assert.equal(result.checkpoint.unresolvedCalls, 1);
  assert.equal(result.checkpoint.blockingUnresolvedCalls, 0);
  assert.equal(git(f, ["show", `${oldHead}:checkpoint.json`]), oldFrame);
  assert.equal(JSON.parse(git(f, ["show", `${result.head}:checkpoint.json`])).schemaVersion, 2);
  const next = await future(f);
  await append(f, { type: "intent", at: new Date(f.recoveryNow).toISOString(), operation: next.opened.operation,
    call: "8".repeat(64), effect: next.effect });
  const observed = await releaseRecord({ command: "read", config: f.config, expectedHead: f.expectedHead, clock: f.recoveryClock });
  assert.equal(observed.checkpoint.unresolvedCalls, 2);
  assert.equal(observed.checkpoint.blockingUnresolvedCalls, 1);
  assert.equal(observed.operations[0].calls[0].outcome, "unknown");
  assert.equal(observed.operations[0].closure, null);
  assert.equal(observed.operations[0].writerPolicyAtAdmission, f.oldWriterPolicy);
  assert.equal(observed.operations[1].writerPolicyAtAdmission, f.nextWriterPolicy);
  assert.equal(observed.effectiveWriterPolicy, f.nextWriterPolicy);
  await assert.rejects(releaseRecord({ command: "read", config: { ...f.config, writerPolicy: f.oldWriterPolicy },
    expectedHead: f.expectedHead, clock: f.recoveryClock }), { code: "ENROLLMENT_MISMATCH" });
});

test("generic append cannot manufacture an authenticated administrative command", async context => {
  const f = await recoveryFixture(context);
  await assert.rejects(invokeRecovery(f, await recoveryEvent(f), { authenticateRecovery: undefined }),
    { code: "RECOVERY_COMMAND_REQUIRED" });
  assert.equal(git(f, ["rev-parse", f.config.ref]), f.expectedHead);
});

for (const [name, mutate, code] of [
  ["changed prefix", f => { f.decision.prefixSha256 = "0".repeat(64); }, "RECOVERY_PREFIX_CHANGED"],
  ["foreign call", f => { f.decision.calls[0].call = "0".repeat(64); }, "RECOVERY_CALL_SCOPE"],
  ["changed observation", f => { f.decision.calls[0].observationSha256 = "0".repeat(64); }, "RECOVERY_CALL_SCOPE"],
  ["changed old policy", f => { f.decision.previousWriterPolicy = "0".repeat(64); }, "RECOVERY_POLICY_CHANGED"],
]) test(`handoff rejects ${name} before a Git update`, async context => {
  const f = await recoveryFixture(context); mutate(f); await retainRecoveryOriginal(f, f.decision);
  await assert.rejects(invokeRecovery(f, await recoveryEvent(f)), { code });
  assert.equal(git(f, ["rev-parse", f.config.ref]), f.expectedHead);
});

test("changed or expired approval attribution rejects before a Git update", async context => {
  const f = await recoveryFixture(context);
  await assert.rejects(invokeRecovery(f, await recoveryEvent(f, {}, { decisionSha256: "0".repeat(64) })),
    { code: "RECOVERY_APPROVAL_INVALID" });
  await assert.rejects(invokeRecovery(f, await recoveryEvent(f, {}, { expiresAt: f.window.start })),
    { code: "RECOVERY_APPROVAL_EXPIRED" });
  assert.equal(git(f, ["rev-parse", f.config.ref]), f.expectedHead);
});

test("a late observation with the same evidence restores blocking without losing retirement", async context => {
  const f = await recoveryFixture(context);
  await handoff(f);
  const read = await releaseRecord({ command: "read", config: f.config, expectedHead: f.expectedHead, clock: f.recoveryClock });
  const previous = read.operations[0].calls[0].lastObservation;
  f.recoveryNow++;
  await append(f, { ...previous, at: new Date(f.recoveryNow).toISOString() });
  const current = await releaseRecord({ command: "read", config: f.config, expectedHead: f.expectedHead, clock: f.recoveryClock });
  assert.equal(current.checkpoint.blockingUnresolvedCalls, 1);
  assert.ok(current.operations[0].retirement);
  assert.equal(current.operations[0].calls[0].outcome, "unknown");
});

test("retired operation, candidate and exact effect cannot resume, and any new UNKNOWN prevents closure", async context => {
  const f = await recoveryFixture(context); await handoff(f);
  const next = await future(f);
  await assert.rejects(append(f, { type: "intent", at: f.window.start, operation: f.plan.operation,
    call: "7".repeat(64), effect: next.effect }), { code: "WINDOW_EXPIRED" });
  await append(f, { type: "close", at: f.window.start, operation: next.opened.operation,
    result: "abandoned", evidence: f.plan.owner });
  for (const [changed, code] of [
    [{ operation: "7".repeat(64), candidate: f.decision.candidate }, "CANDIDATE_RETIRED"],
    [{ operation: "7".repeat(64), effects: [f.decision.calls[0].call] }, null],
  ]) {
    const opened = { ...next.opened, ...changed };
    if (code === null) {
      const replay = await releaseRecord({ command: "read", config: f.config, expectedHead: f.expectedHead });
      opened.effects = [replay.operations[0].calls[0].intent.effect];
    }
    opened.plan = sha256(planBytes(opened)); await retainRecoveryOriginal(f, JSON.parse(planBytes(opened)));
    await assert.rejects(append(f, opened), { code: code ?? "EFFECT_RETIRED" });
  }
  const opened = { ...next.opened, operation: "6".repeat(64) };
  opened.plan = await retainRecoveryOriginal(f, JSON.parse(planBytes(opened)));
  await append(f, opened);
  await append(f, { type: "intent", at: f.window.start, operation: opened.operation, call: "5".repeat(64), effect: next.effect });
  await assert.rejects(append(f, { type: "close", at: f.window.start, operation: opened.operation,
    result: "abandoned", evidence: f.plan.owner }), { code: "CALL_UNSETTLED" });
});

test("handoff validates every retained policy/decision/approval original and refuses a stale accepted head", async context => {
  const f = await recoveryFixture(context), event = await recoveryEvent(f);
  for (const identity of [event.approval, f.nextWriterPolicy, sha256(canonicalBytes(f.decision))]) {
    const path = f.config.evidence[identity], original = await readFile(path);
    await writeFile(path, "changed");
    await assert.rejects(invokeRecovery(f, event), { code: "EVIDENCE_CHANGED" });
    await writeFile(path, original);
  }
  const path = f.config.evidence[event.approval], original = await readFile(path);
  await rm(path);
  await assert.rejects(invokeRecovery(f, event), { code: "EVIDENCE_UNAVAILABLE" });
  await writeFile(path, original);
  const accepted = await handoff(f);
  await assert.rejects(invokeRecovery(f, event, { expectedHead: f.decision.expectedHead,
    config: { ...f.config, writerPolicy: f.oldWriterPolicy } }), { code: "STALE_HEAD" });
  assert.equal(git(f, ["rev-parse", f.config.ref]), accepted.head);
});

test("a push followed by unavailable readback preserves uncertain handoff without re-enrolling or retrying", async context => {
  const f = await recoveryFixture(context);
  const wrapper = join(f.directory, "git-readback.mjs"), marker = join(f.directory, "pushed");
  await writeFile(wrapper, `#!${process.execPath}\nimport {spawnSync} from 'node:child_process';
import {existsSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2), marker=${JSON.stringify(marker)};
if(existsSync(marker) && args.includes('ls-remote')) process.exit(88);
const r=spawnSync('git',args,{env:process.env,input:await new Promise(resolve=>{let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>resolve(s));}),encoding:'utf8'});
if(args.includes('push')) writeFileSync(marker,'attempted');
if(r.stdout) process.stdout.write(r.stdout); if(r.stderr) process.stderr.write(r.stderr); process.exit(r.status??89);\n`, { mode: 0o700 });
  let uncertain;
  await assert.rejects(invokeRecovery(f, await recoveryEvent(f), { gitExecutable: wrapper }), error => {
    assert.equal(error.code, "WRITE_UNCONFIRMED"); uncertain = error.receipt; return true;
  });
  assert.equal(uncertain.status, "unconfirmed"); assert.equal(uncertain.priorHead, f.expectedHead);
  assert.equal(git(f, ["rev-parse", f.config.ref]), uncertain.attemptedCommit);
  const replay = await releaseRecord({ command: "read", config: { ...f.config, writerPolicy: f.nextWriterPolicy },
    expectedHead: uncertain.attemptedCommit, clock: f.recoveryClock });
  assert.equal(replay.checkpoint.sequence, f.decision.sequence + 1);
  assert.equal(replay.root, f.config.root);
});

test("ordinary publisher uses each policy epoch, admits a different version and still rejects fresh UNKNOWN/channel drift", async context => {
  const f = await recoveryFixture(context); await handoff(f);
  const parameters = futurePublisher(f), { plan, authorityObservation } = parameters;
  const record = await publicationRecord(parameters);
  let checks = 0;
  await assert.rejects(prepareNpmCall({ plan, record, fresh: async () => { checks++; },
    inspectNpm: async () => { throw Object.assign(new Error("synthetic channel drift"), { code: "PUBLICATION_NPM_CHANNEL_CHANGED" }); },
    inspectGithub: async () => assert.fail("must not proceed after registry drift"), notes: "" }),
  { code: "PUBLICATION_NPM_CHANNEL_CHANGED" });
  assert.equal(checks, 1);
  const effect = record.effects[0], call = await record.intent(effect);
  const replay = await releaseRecord({ command: "read", config: record.config, expectedHead: record.head, clock: f.recoveryClock });
  const npmHandoff = { schemaVersion: 1, operation: plan.operation, planSha256: sha256(canonicalBytes(plan)),
    call, effect: effect.identity, recordHead: record.head };
  assert.doesNotThrow(() => requireNpmIntent(plan, replay, npmHandoff, authorityObservation));
  assert.equal(replay.checkpoint.unresolvedCalls, 2); assert.equal(replay.checkpoint.blockingUnresolvedCalls, 1);
  const late = replay.operations[0].calls[0].lastObservation;
  // A changed full observation restores blocking even when evidence is unchanged.
  const changed = { ...late, at: new Date(f.recoveryNow + 1).toISOString() };
  const bytes = canonicalBytes({ schemaVersion: 1, event: changed });
  const result = await releaseRecord({ command: "append", config: record.config, expectedHead: record.head,
    inputBytes: bytes, inspected: sha256(bytes), clock: () => f.recoveryNow + 1 });
  const current = await releaseRecord({ command: "read", config: record.config, expectedHead: result.head });
  assert.equal(current.checkpoint.blockingUnresolvedCalls, 2);
  assert.throws(() => requireNpmIntent(plan, current, { ...npmHandoff, recordHead: result.head }, authorityObservation),
    { code: "PUBLICATION_NPM_INTENT_INVALID" });
  await assert.rejects(publicationRecord({ ...parameters, config: record.config, expectedHead: result.head }),
    { code: "PUBLICATION_RECORD_UNSETTLED" });
  const receipt = npmCallReceipt(plan, npmHandoff, { manifestSha256: plan.publisher.clientSha256 }, {
    dispatched: true, status: 0, stdout: JSON.stringify({ [plan.candidate.name]: { name: plan.candidate.name,
      version: plan.candidate.version, integrity: `sha512-${Buffer.from(plan.candidate.archiveSha512, "hex").toString("base64")}` } }) });
  const conservation = { ...parameters, config: record.config, expectedHead: result.head, handoff: npmHandoff, receipt,
    authenticateReceipt: async () => {}, clock: () => f.recoveryNow + 1 };
  await assert.rejects(recordNpmPublication({ ...conservation, handoff: { ...npmHandoff, recordHead: f.config.root } }),
    { code: "PUBLICATION_NPM_INTENT_INVALID" });
  const conserved = await recordNpmPublication(conservation);
  const final = await releaseRecord({ command: "read", config: conserved.config, expectedHead: conserved.head });
  assert.equal(final.checkpoint.blockingUnresolvedCalls, 1);
  assert.equal(final.operations[1].calls[0].outcome, "verified-effect");
  assert.equal(final.operations[0].calls[0].outcome, "unknown");
});

test("future publisher completes its own effects while preserving a retired UNKNOWN total", async context => {
  const f = await recoveryFixture(context); await handoff(f);
  const parameters = futurePublisher(f), record = await publicationRecord(parameters);
  for (const effect of record.effects) {
    const call = await record.intent(effect);
    await record.observe(call, effect, "verified-effect", { fixture: "separate synthetic successful call", effect: effect.identity });
  }
  await record.close("completed", { fixture: "new release complete" });
  const replay = await releaseRecord({ command: "read", config: record.config, expectedHead: record.head });
  assert.equal(replay.checkpoint.unresolvedCalls, 1); assert.equal(replay.checkpoint.blockingUnresolvedCalls, 0);
  assert.equal(replay.operations[0].closure, null); assert.equal(replay.operations[1].closure.result, "completed");
});
