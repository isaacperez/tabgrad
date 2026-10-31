import { blockingRecordCalls, canonicalBytes, sha256 } from "./release-record-data.mjs";
import { isDeepStrictEqual } from "node:util";
import { exactPublicationKeys, publicationAuthorityDocument, publicationCandidateIdentity, publicationEffects, requirePublication } from "./publication-plan.mjs";

/** A read observation never settles an earlier write's outcome. */
export function checkPublicationGithubState(plan, state, complete, notes) {
  const effects = publicationEffects(plan);
  const done = kind => complete.has(effects.find(effect => effect.kind === kind).identity);
  const tagExpected = done("github-tag") ? plan.candidate.sourceRevision : plan.github.before.tagRevision;
  requirePublication(state.tagRevision === tagExpected, "PUBLICATION_TAG_CONFLICT");
  if (state.release === null) {
    requirePublication(!done("github-draft") && plan.github.before.releaseId === null
      && state.assets.length === 0, "PUBLICATION_RELEASE_CONFLICT");
    return;
  }
  const r = state.release;
  requirePublication((done("github-draft") || String(r.id) === plan.github.before.releaseId)
    && r.tag_name === plan.github.tag && r.name === plan.github.tag && r.body === notes
    && r.prerelease === false && r.draft === !done("github-public")
    && (!r.immutable || done("github-public")), "PUBLICATION_RELEASE_CONFLICT");
  const assets = new Map(state.assets.map(asset => [asset.name, asset]));
  for (const effect of effects.filter(value => value.kind === "github-asset")) {
    requirePublication(assets.has(effect.asset.name) === complete.has(effect.identity), "PUBLICATION_ASSET_CONFLICT");
  }
  requirePublication(!done("github-public") || (plan.github.latest ? state.latestId === String(r.id) : state.latestId !== String(r.id)),
    "PUBLICATION_LATEST_CONFLICT");
  requirePublication(!done("github-public") || r.immutable === true, "PUBLICATION_RELEASE_NOT_FROZEN");
}

/** Confirmation is selected by the admitted call owner, never by client output. */
export function npmCallReceipt(plan, handoff, client, result, error, confirmation = "npm-json") {
  const raw = canonicalBytes(result ?? error?.privateClientEvidence ?? { dispatched: false, code: error?.code ?? "LOCAL_FAILURE" });
  let verified = false;
  if (!error && result?.status === 0 && confirmation === "human-terminal-exit") {
    verified = plan.npm.mode === "bootstrap" && result.signal === null && result.dispatched === true
      && result.outputMode === "inherited-terminal" && result.stdout === null && result.stderr === null;
  } else if (!error && result?.status === 0 && confirmation === "npm-json") {
    try {
      const body = JSON.parse(result.stdout)[plan.candidate.name];
      verified = body.name === plan.candidate.name && body.version === plan.candidate.version
        && Buffer.from(body.integrity.slice(7), "base64").toString("hex") === plan.candidate.archiveSha512;
    } catch { /* An unrecognized success response remains unknown. */ }
  }
  const confirmedCode = confirmation === "human-terminal-exit"
    ? "PUBLICATION_NPM_HUMAN_PROCESS_SUCCESS" : "PUBLICATION_NPM_CLIENT_SUCCESS";
  return { schemaVersion: 1, status: "failed", cleanup: "unobserved", operation: plan.operation, planSha256: sha256(canonicalBytes(plan)),
    call: handoff.call, effect: handoff.effect, clientSha256: client.manifestSha256,
    dispatched: result?.dispatched ?? error?.dispatched ?? false,
    outcome: verified ? "verified-effect" : error?.dispatched === false ? "verified-no-effect" : "unknown",
    receiptSha256: sha256(raw), code: verified ? confirmedCode : error?.code ?? "PUBLICATION_NPM_OUTCOME_UNKNOWN" };
}

export function requireNpmCallReceipt(plan, handoff, receipt) {
  requirePublication(exactPublicationKeys(receipt, ["schemaVersion", "status", "cleanup", "operation", "planSha256", "call", "effect", "clientSha256",
    "dispatched", "outcome", "receiptSha256", "code"]) && receipt.schemaVersion === 1 && receipt.operation === plan.operation
    && ["passed", "failed"].includes(receipt.status) && ["completed", "failed", "unobserved"].includes(receipt.cleanup)
    && (receipt.status !== "passed" || (receipt.outcome === "verified-effect" && receipt.cleanup === "completed"))
    && receipt.planSha256 === sha256(canonicalBytes(plan)) && receipt.call === handoff.call
    && receipt.effect === handoff.effect && receipt.clientSha256 === plan.publisher.clientSha256
    && ["verified-effect", "verified-no-effect", "unknown"].includes(receipt.outcome)
    && [true, false, null].includes(receipt.dispatched) && (receipt.outcome !== "verified-effect" || receipt.dispatched === true)
    && (receipt.outcome !== "verified-no-effect" || receipt.dispatched === false)
    && typeof receipt.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(receipt.code)
    && (receipt.code !== "PUBLICATION_NPM_HUMAN_PROCESS_SUCCESS" || plan.npm.mode === "bootstrap")
    && typeof receipt.receiptSha256 === "string" && /^[0-9a-f]{64}$/.test(receipt.receiptSha256),
  "PUBLICATION_NPM_RECEIPT_INVALID");
}

export async function prepareNpmCall({ plan, record, fresh, inspectNpm, inspectGithub, notes }) {
  await fresh();
  await inspectNpm("before");
  const state = await inspectGithub();
  checkPublicationGithubState(plan, state, record.complete, notes);
  const effect = record.effects.find(value => value.kind === "npm-publish");
  if (record.complete.has(effect.identity)) return null;
  requirePublication(plan.npm.mode !== "observe", "PUBLICATION_NPM_OUTCOME_UNPROVEN");
  await fresh();
  const call = await record.intent(effect);
  return { schemaVersion: 1, operation: plan.operation, planSha256: sha256(canonicalBytes(plan)),
    call, effect: effect.identity, recordHead: record.head };
}

function publicationRecordOperation(plan, replay, authorityObservation) {
  const operation = replay.operations.find(value => value.operation === plan.operation);
  requirePublication(authorityObservation?.planSha256 === sha256(canonicalBytes(plan)), "PUBLICATION_RECORD_ADMISSION_INVALID");
  const authority = sha256(canonicalBytes(publicationAuthorityDocument(plan, authorityObservation)));
  requirePublication(operation && operation.admission.authority === authority && operation.admission.owner === plan.owner
    && operation.admission.candidate === publicationCandidateIdentity(plan)
    && isDeepStrictEqual(operation.admission.window, plan.window), "PUBLICATION_RECORD_ADMISSION_INVALID");
  return operation;
}

export function requirePublicationRecordAdmission(plan, replay, authorityObservation) {
  const operation = publicationRecordOperation(plan, replay, authorityObservation);
  requirePublication(operation.closure === null && !operation.retirement && replay.checkpoint.activeOperation === plan.operation,
    "PUBLICATION_RECORD_ADMISSION_INVALID");
  return operation;
}

/** An authenticated existing-call fact can be conserved despite later blockers. */
export function requireNpmConservationCall(plan, replay, handoff, authorityObservation) {
  const effect = publicationEffects(plan).find(value => value.kind === "npm-publish");
  const operation = publicationRecordOperation(plan, replay, authorityObservation);
  const call = operation.calls.find(value => value.call === handoff?.call);
  requirePublication(handoff?.schemaVersion === 1 && handoff.operation === plan.operation
    && handoff.planSha256 === sha256(canonicalBytes(plan)) && handoff.effect === effect.identity
    && call?.intent.effect === effect.identity && typeof call.intentCommit === "string"
    && call.intentCommit === handoff.recordHead, "PUBLICATION_NPM_INTENT_INVALID");
}

/** The writer is launched only after its separate recorder's confirmed intent. */
export function requireNpmIntent(plan, replay, handoff, authorityObservation) {
  const effect = publicationEffects(plan).find(value => value.kind === "npm-publish");
  const operation = requirePublicationRecordAdmission(plan, replay, authorityObservation);
  const call = operation.calls.find(value => value.call === handoff?.call);
  requirePublication(handoff?.schemaVersion === 1 && handoff.operation === plan.operation
    && handoff.planSha256 === sha256(canonicalBytes(plan)) && handoff.effect === effect.identity
    && replay.head === handoff.recordHead && replay.checkpoint.activeOperation === plan.operation
    && blockingRecordCalls(replay) === 1 && replay.checkpoint.conflictingCalls === 0
    && call?.intent.effect === effect.identity && call.outcome === "unknown" && call.observations === 0,
  "PUBLICATION_NPM_INTENT_INVALID");
}

/** GitHub-only trusted controller; no npm credential or OIDC identity is passed. */
export async function completeGithubPublication({ plan, record, fresh, inspectNpm, inspectGithub, write, notes,
  verifyRegistry, clock = Date.now }) {
  const npm = record.effects.find(effect => effect.kind === "npm-publish");
  requirePublication(record.complete.has(npm.identity), "PUBLICATION_NPM_NOT_CONFIRMED");
  await fresh();
  const verification = await verifyRegistry();
  requirePublication(verification.status === "passed", "PUBLICATION_REGISTRY_NOT_VERIFIED");
  const registryEvidenceSha256 = sha256(canonicalBytes(verification));
  for (const effect of record.effects.filter(value => value.kind !== "npm-publish")) {
    if (record.complete.has(effect.identity)) continue;
    await fresh();
    await inspectNpm("after");
    let current = await inspectGithub(effect);
    checkPublicationGithubState(plan, current, record.complete, notes);
    requirePublication(Date.parse(plan.window.start) <= clock() && clock() < Date.parse(plan.window.deadline),
      "PUBLICATION_WINDOW_EXPIRED");
    const call = await record.intent(effect);
    let result, failure;
    try {
      await fresh();
      requirePublication(clock() < Date.parse(plan.window.deadline), "PUBLICATION_WINDOW_EXPIRED");
      result = await write(effect, current);
    } catch (error) { failure = error; }
    const dispatched = result !== undefined || failure?.dispatched === true;
    const outcome = !failure && result !== undefined ? "verified-effect" : dispatched ? "unknown" : "verified-no-effect";
    // A response is call evidence; final state is checked separately. Neither a
    // destination match nor a late timeout is substituted for this observation.
    await record.observe(call, effect, outcome, { schemaVersion: 1, operation: plan.operation,
      effect: effect.identity, outcome, code: failure?.code ?? "PUBLICATION_GITHUB_CLIENT_SUCCESS",
      receiptSha256: sha256(canonicalBytes(result ?? { code: failure?.code ?? "LOCAL_FAILURE" })) });
    if (failure || outcome !== "verified-effect") throw failure ?? new Error("PUBLICATION_EFFECT_UNKNOWN");
    current = await inspectGithub(effect);
    checkPublicationGithubState(plan, current, record.complete, notes);
  }
  await fresh();
  await inspectNpm("after");
  const final = await inspectGithub();
  checkPublicationGithubState(plan, final, record.complete, notes);
  const result = { schemaVersion: 1, status: "passed", operation: plan.operation,
    candidate: plan.candidate, registryEvidenceSha256, githubEvidenceSha256: sha256(canonicalBytes(final)) };
  await record.close("completed", result);
  return result;
}
