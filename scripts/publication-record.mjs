import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { releaseRecord } from "./release-record.mjs";
import { canonicalBytes, planBytes, sha256 } from "./release-record-data.mjs";
import { publicationAuthorityDocument, publicationCandidateIdentity, publicationEffects, requirePublication,
  validatePublicationPlan, verifyPublicationAuthority } from "./publication-plan.mjs";
import { requireEnrolledRecord } from "./publication-authority.mjs";

/** Compose the qualified record protocol; never enroll/reset a missing root here. */
export async function publicationRecord({ config, expectedHead, policy, plan, authorityObservation, directory, clock = Date.now,
  protocol = releaseRecord }) {
  config = structuredClone(config);
  requireEnrolledRecord(config, policy);
  verifyPublicationAuthority(plan, sha256(canonicalBytes(plan)), authorityObservation, policy.writerPolicySha256, clock());
  let head = expectedHead;
  const at = () => new Date(clock()).toISOString();
  const read = () => protocol({ command: "read", config, expectedHead: head, clock });
  let replay = await read();
  requirePublication(replay.checkpoint.unresolvedCalls === 0 && replay.checkpoint.conflictingCalls === 0,
    "PUBLICATION_RECORD_UNSETTLED");
  for (const operation of replay.operations) {
    const original = await readFile(config.evidence[operation.admission.authority]);
    const document = JSON.parse(original);
    requirePublication(typeof document.publicationPlanSha256 === "string"
      && typeof config.evidence[document.publicationPlanSha256] === "string", "PUBLICATION_PLAN_EVIDENCE_MISSING");
    const raw = await readFile(config.evidence[document.publicationPlanSha256]);
    const old = JSON.parse(raw);
    // Historical parsing conserves the old approved window; it grants no new
    // publication authority and never substitutes today's expiry into that plan.
    validatePublicationPlan(old, Date.parse(old.window?.start));
    requirePublication(canonicalBytes(old).equals(raw) && sha256(raw) === document.publicationPlanSha256
      && canonicalBytes(publicationAuthorityDocument(old, document.execution)).equals(original)
      && old.operation === operation.operation && operation.admission.candidate === publicationCandidateIdentity(old)
      && operation.admission.owner === old.owner && isDeepStrictEqual(operation.admission.window, old.window)
      && operation.admission.effects.every(identity => publicationEffects(old).some(effect => effect.identity === identity)),
    "PUBLICATION_HISTORY_AUTHORITY_INVALID");
    verifyPublicationAuthority(old, document.publicationPlanSha256, document.execution, policy.writerPolicySha256,
      Date.parse(old.window.start));
  }

  async function retain(bytes) {
    const identity = sha256(bytes), path = join(directory, `${identity}.json`);
    if (config.evidence[identity] === undefined) {
      try { await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); }
      catch (error) {
        if (error.code !== "EEXIST" || !(await readFile(path)).equals(bytes)) throw error;
      }
      config.evidence[identity] = path;
    } else requirePublication((await readFile(config.evidence[identity])).equals(bytes), "PUBLICATION_EVIDENCE_CHANGED");
    return identity;
  }
  async function append(event) {
    const bytes = canonicalBytes({ schemaVersion: 1, event: { ...event, at: at() } });
    const receipt = await protocol({ command: "append", config, expectedHead: head, inputBytes: bytes,
      inspected: sha256(bytes), clock });
    requirePublication(receipt.status === "confirmed", "PUBLICATION_RECORD_UNCONFIRMED");
    head = receipt.head;
    return receipt;
  }

  const effects = publicationEffects(plan);
  const effectMap = new Map(effects.map(effect => [effect.identity, effect]));
  const prior = new Map();
  for (const operation of replay.operations.filter(value => value.operation !== plan.operation)) for (const call of operation.calls) {
    if (call.outcome === "verified-effect") prior.set(call.intent.effect, { operation: operation.operation, call: call.call });
  }
  const continuation = plan.continuation;
  if (continuation !== null) {
    const old = replay.operations.find(operation => operation.operation === continuation.operation);
    requirePublication(old?.closure && old.closure.result === "abandoned"
      && old.closure.evidence === continuation.evidenceSha256
      && config.evidence[continuation.evidenceSha256] !== undefined,
    "PUBLICATION_CONTINUATION_UNPROVEN");
    requirePublication(sha256(await readFile(config.evidence[continuation.evidenceSha256])) === continuation.evidenceSha256,
      "PUBLICATION_CONTINUATION_UNPROVEN");
  } else requirePublication(!effects.some(effect => prior.has(effect.identity)), "PUBLICATION_PRIOR_EFFECT_REQUIRES_CONTINUATION");
  const remaining = effects.filter(effect => !prior.has(effect.identity));
  requirePublication(plan.npm.mode !== "observe" || prior.has(effects[0].identity), "PUBLICATION_NPM_OUTCOME_UNPROVEN");
  const candidate = { candidate: plan.candidate, producer: { identity: plan.producer.verification.identity,
    signingDeadline: plan.producer.signingDeadline, archiveProofSha256: plan.producer.archiveProofSha256,
    inventoryProofSha256: plan.producer.inventoryProofSha256 } };
  requirePublication(await retain(canonicalBytes(candidate)) === publicationCandidateIdentity(plan), "PUBLICATION_CANDIDATE_IDENTITY");
  for (const effect of remaining) {
    const { identity, ...value } = effect;
    requirePublication(await retain(canonicalBytes(value)) === identity, "PUBLICATION_EFFECT_IDENTITY");
  }
  // Authority/owner originals are separately admitted public-safe opaque records;
  // their private authenticated originals remain with the controller.
  for (const identity of [plan.authority, plan.owner]) {
    requirePublication(typeof config.evidence[identity] === "string"
      && sha256(await readFile(config.evidence[identity])) === identity, "PUBLICATION_AUTHORITY_EVIDENCE_MISSING");
  }
  await retain(canonicalBytes(plan));
  const authority = await retain(canonicalBytes(publicationAuthorityDocument(plan, authorityObservation)));
  const admission = { type: "open", operation: plan.operation, candidate: publicationCandidateIdentity(plan),
    authority, owner: plan.owner, window: plan.window, effects: remaining.map(effect => effect.identity) };
  const journalPlan = planBytes(admission);
  admission.plan = await retain(journalPlan);
  const active = replay.operations.find(operation => operation.operation === plan.operation);
  if (active) {
    requirePublication(active.closure === null && replay.checkpoint.activeOperation === plan.operation
      && active.admission.plan === admission.plan, "PUBLICATION_RECORD_OPERATION_CHANGED");
  } else {
    requirePublication(remaining.length > 0, "PUBLICATION_ALREADY_COMPLETE");
    await append(admission);
  }
  const complete = new Set([...prior.keys(), ...(active?.calls ?? [])
    .filter(call => call.outcome === "verified-effect").map(call => call.intent.effect)]);

  return {
    effects, complete,
    get head() { return head; },
    get config() { return structuredClone(config); },
    async intent(effect) {
      requirePublication(effectMap.has(effect.identity) && !complete.has(effect.identity), "PUBLICATION_EFFECT_ALREADY_COMPLETE");
      const call = randomBytes(32).toString("hex");
      await append({ type: "intent", operation: plan.operation, call, effect: effect.identity });
      return call;
    },
    async observe(call, effect, outcome, evidence, basis = "call") {
      requirePublication(effectMap.has(effect.identity), "PUBLICATION_EFFECT_UNSUPPORTED");
      const identity = await retain(canonicalBytes(evidence));
      await append({ type: "observe", operation: plan.operation, call, outcome, basis, evidence: identity });
      if (outcome === "verified-effect") complete.add(effect.identity);
    },
    async close(result, evidence) {
      await append({ type: "close", operation: plan.operation, result,
        evidence: await retain(canonicalBytes(evidence)) });
    },
  };
}
