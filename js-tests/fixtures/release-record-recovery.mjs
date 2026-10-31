import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { publicationRecordFixture } from "./publication-record.mjs";
import { publicationRecord } from "../../scripts/publication-record.mjs";
import { locationIdentity, releaseRecord } from "../../scripts/release-record.mjs";
import { canonicalBytes, prepareRecoveryDecision, sha256 } from "../../scripts/release-record-data.mjs";

export async function retainRecoveryOriginal(fixture, value) {
  const bytes = canonicalBytes(value), identity = sha256(bytes);
  const path = fixture.config.evidence[identity] ?? join(fixture.directory, `${identity}.json`);
  if (fixture.config.evidence[identity]) assert.deepEqual(await readFile(path), bytes);
  else await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  fixture.config.evidence[identity] = path;
  return identity;
}

export async function recoveryFixture(context) {
  const f = await publicationRecordFixture(context);
  const record = await publicationRecord(f), effect = record.effects[0];
  const call = await record.intent(effect);
  await record.observe(call, effect, "unknown", { fixture: "old client stopped without a causal result" });
  f.config = record.config;
  f.expectedHead = record.head;
  f.oldWriterPolicy = f.config.writerPolicy;
  f.recoveryNow = Date.parse(f.plan.window.deadline) + 1000;
  f.recoveryClock = () => f.recoveryNow;
  f.window = { start: new Date(f.recoveryNow).toISOString(), deadline: new Date(f.recoveryNow + 600000).toISOString() };
  f.nextWriterPolicy = await retainRecoveryOriginal(f, { schemaVersion: 2, kind: "release-recorder-role",
    location: locationIdentity(f.config), writer: "qualified-publication-record-role",
    mainRulesSha256: "a".repeat(64), recordRulesSha256: "b".repeat(64), bypassAllowed: false,
    writerExcludedFrom: ["build", "consumer", "npm", "signing"], sourceAdmission: "exact-qualified-approved-recipe" });
  const facts = await retainRecoveryOriginal(f, { fixture: "independently verified separate manual delivery and stopped actors" });
  const replay = await releaseRecord({ command: "read", config: f.config, expectedHead: f.expectedHead, clock: f.recoveryClock });
  f.decision = prepareRecoveryDecision(replay, { operation: f.plan.operation, nextWriterPolicy: f.nextWriterPolicy,
    window: f.window, evidence: [facts] });
  await retainRecoveryOriginal(f, f.decision);
  f.call = call;
  return f;
}

export async function recoveryEvent(f, changes = {}, approvalChanges = {}) {
  const at = new Date(f.recoveryNow).toISOString();
  const approval = await retainRecoveryOriginal(f, { schemaVersion: 1, kind: "authenticated-recovery-comment",
    decisionSha256: sha256(canonicalBytes(f.decision)), profileSha256: "c".repeat(64),
    commentSha256: "d".repeat(64), actorSha256: "e".repeat(64), permissionSha256: "f".repeat(64),
    sourceRevision: "a".repeat(40), observedAt: at, expiresAt: f.window.deadline, ...approvalChanges });
  return { type: "handoff", at, decision: f.decision, approval, ...changes };
}

export async function invokeRecovery(f, event, options = {}) {
  const inputBytes = canonicalBytes({ schemaVersion: 2, event });
  return releaseRecord({ command: "append", config: f.config, expectedHead: f.expectedHead,
    inputBytes, inspected: sha256(inputBytes), clock: f.recoveryClock,
    // This is an explicit synthetic controller port, not real maintainer authentication.
    authenticateRecovery: async () => {}, ...options });
}
