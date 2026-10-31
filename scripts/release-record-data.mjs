import { createHash } from "node:crypto";

export const RECORD_LIMIT = 65536;
const digestPattern = /^[0-9a-f]{64}$/;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class ReleaseRecordError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "ReleaseRecordError";
    this.code = code;
  }
}

export function requireRecord(condition, code = "INVALID_DATA") {
  if (!condition) throw new ReleaseRecordError(code);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
  }
  return value;
}

export function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(sorted(value))}\n`);
}

export function readCanonical(bytes) {
  requireRecord(bytes.length <= RECORD_LIMIT, "RECORD_TOO_LARGE");
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    requireRecord(canonicalBytes(value).equals(bytes));
    return value;
  } catch {
    throw new ReleaseRecordError("INVALID_DATA");
  }
}

function keys(value, names) {
  requireRecord(value !== null && typeof value === "object" && !Array.isArray(value));
  requireRecord(Object.keys(value).sort().join(",") === [...names].sort().join(","));
}

export function digest(value) {
  requireRecord(typeof value === "string" && digestPattern.test(value));
  return value;
}

export function planBytes(event) {
  return canonicalBytes({ schemaVersion: 1, operation: event.operation, candidate: event.candidate,
    authority: event.authority, owner: event.owner, window: event.window, effects: event.effects });
}

function instant(value) {
  requireRecord(typeof value === "string" && instantPattern.test(value));
  requireRecord(Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
}

function windowData(value) {
  keys(value, ["start", "deadline"]);
  instant(value.start);
  instant(value.deadline);
  requireRecord(value.start < value.deadline, "WINDOW_INVALID");
}

export function validateRecoveryDecision(value) {
  keys(value, ["schemaVersion", "operation", "candidate", "root", "expectedHead", "prefixSha256", "sequence",
    "previousWriterPolicy", "nextWriterPolicy", "window", "calls", "evidence", "risk"]);
  requireRecord(value.schemaVersion === 1, "VERSION_UNSUPPORTED");
  for (const name of ["operation", "candidate", "prefixSha256", "previousWriterPolicy", "nextWriterPolicy"]) digest(value[name]);
  requireRecord(/^[0-9a-f]{40}$/.test(value.root) && /^[0-9a-f]{40}$/.test(value.expectedHead), "RECOVERY_PREFIX_INVALID");
  requireRecord(Number.isSafeInteger(value.sequence) && value.sequence > 0, "RECOVERY_PREFIX_INVALID");
  windowData(value.window);
  requireRecord(value.risk === "late-shared-effects", "RECOVERY_RISK_REQUIRED");
  requireRecord(Array.isArray(value.calls) && value.calls.length > 0, "RECOVERY_CALL_SCOPE");
  let prior = "";
  for (const call of value.calls) {
    keys(call, ["call", "intentSha256", "observationSha256"]);
    for (const name of ["call", "intentSha256", "observationSha256"]) digest(call[name]);
    requireRecord(prior < call.call, "RECOVERY_CALL_SCOPE"); prior = call.call;
  }
  requireRecord(Array.isArray(value.evidence) && value.evidence.length > 0
    && new Set(value.evidence).size === value.evidence.length, "RECOVERY_EVIDENCE_REQUIRED");
  for (const identity of value.evidence) digest(identity);
  return value;
}

export function recoveryApprovalComment(decision) {
  validateRecoveryDecision(decision);
  return `tabgrad-release-recovery ${sha256(canonicalBytes(decision))} ${decision.root}/${decision.expectedHead}`;
}

/** Stable role/protection grant; each publisher run still pins its exact recipe. */
export function validateWriterRolePolicy(value, location) {
  keys(value, ["schemaVersion", "kind", "location", "writer", "mainRulesSha256", "recordRulesSha256",
    "bypassAllowed", "writerExcludedFrom", "sourceAdmission"]);
  requireRecord(value.schemaVersion === 2 && value.kind === "release-recorder-role"
    && value.writer === "qualified-publication-record-role" && value.location === location
    && value.bypassAllowed === false && value.sourceAdmission === "exact-qualified-approved-recipe"
    && canonicalBytes(value.writerExcludedFrom).equals(canonicalBytes(["build", "consumer", "npm", "signing"])),
  "WRITER_POLICY_INVALID");
  for (const name of ["location", "mainRulesSha256", "recordRulesSha256"]) digest(value[name]);
  return value;
}

/** A qualified controller creates this attribution only after authenticated reads. */
export function validateRecoveryApproval(value, event) {
  keys(value, ["schemaVersion", "kind", "decisionSha256", "profileSha256", "commentSha256", "actorSha256",
    "permissionSha256", "sourceRevision", "observedAt", "expiresAt"]);
  requireRecord(value.schemaVersion === 1 && value.kind === "authenticated-recovery-comment"
    && value.decisionSha256 === sha256(canonicalBytes(event.decision))
    && /^[0-9a-f]{40}$/.test(value.sourceRevision), "RECOVERY_APPROVAL_INVALID");
  for (const name of ["decisionSha256", "profileSha256", "commentSha256", "actorSha256", "permissionSha256"]) digest(value[name]);
  instant(value.observedAt); instant(value.expiresAt);
  requireRecord(event.decision.window.start <= value.observedAt && value.observedAt <= event.at
    && event.at < value.expiresAt && value.expiresAt <= event.decision.window.deadline, "RECOVERY_APPROVAL_EXPIRED");
  return value;
}

function callSnapshot(call, data) {
  requireRecord(data.lastObservation !== null, "RECOVERY_OBSERVATION_REQUIRED");
  return { call, intentSha256: data.intentSha256 ?? sha256(canonicalBytes(data.intent)),
    observationSha256: data.observationSha256 ?? sha256(canonicalBytes(data.lastObservation)) };
}

function unresolvedOperationCalls(operation) {
  return [...operation.calls].filter(([, value]) => value.outcome === "unknown")
    .map(([call, value]) => callSnapshot(call, value)).sort((a, b) => a.call < b.call ? -1 : a.call > b.call ? 1 : 0);
}

/** Public receipts are produced by the complete reader, not untrusted checkpoints. */
export function blockingRecordCalls(replay) {
  if ((replay.recordVersion ?? 1) === 1) return replay.checkpoint.unresolvedCalls;
  requireRecord(replay.recordVersion === 2 && Number.isSafeInteger(replay.checkpoint.blockingUnresolvedCalls)
    && replay.checkpoint.blockingUnresolvedCalls >= 0
    && replay.checkpoint.blockingUnresolvedCalls <= replay.checkpoint.unresolvedCalls, "CHECKPOINT_INVALID");
  return replay.checkpoint.blockingUnresolvedCalls;
}

export function prepareRecoveryDecision(replay, { operation, nextWriterPolicy, window, evidence }) {
  const target = replay.operations.find(value => value.operation === operation);
  requireRecord(target, "OPERATION_NOT_FOUND");
  const calls = target.calls.filter(value => value.outcome === "unknown")
    .map(value => callSnapshot(value.call, value)).sort((a, b) => a.call < b.call ? -1 : a.call > b.call ? 1 : 0);
  return validateRecoveryDecision({ schemaVersion: 1, operation, candidate: target.admission.candidate,
    root: replay.root, expectedHead: replay.head, prefixSha256: replay.prefixSha256,
    sequence: replay.checkpoint.sequence, previousWriterPolicy: replay.effectiveWriterPolicy,
    nextWriterPolicy, window, calls, evidence, risk: "late-shared-effects" });
}

function applyHandoff(state, event, context) {
  const decision = event.decision, operation = state.operations.get(decision.operation);
  requireRecord(context?.root === decision.root && context?.previousHead === decision.expectedHead
    && state.sequence === decision.sequence && state.prefixSha256 === decision.prefixSha256, "RECOVERY_PREFIX_CHANGED");
  requireRecord(operation && operation.admission.candidate === decision.candidate, "RECOVERY_OPERATION_CHANGED");
  requireRecord(state.writerPolicy === decision.previousWriterPolicy, "RECOVERY_POLICY_CHANGED");
  requireRecord(operation.admission.window.deadline <= decision.window.start
    && decision.window.start <= event.at && event.at < decision.window.deadline, "WINDOW_EXPIRED");
  requireRecord(![...operation.calls.values()].some(call => call.outcome === "conflict"), "RECOVERY_CONFLICT");
  requireRecord(canonicalBytes(unresolvedOperationCalls(operation)).equals(canonicalBytes(decision.calls)), "RECOVERY_CALL_SCOPE");
  requireRecord(decision.calls.some(call => state.blocking.has(call.call)), "RECOVERY_ALREADY_APPLIED");
  for (const call of decision.calls) {
    state.acceptedUnknown.set(call.call, call);
    state.blocking.delete(call.call);
    state.retiredEffects.add(state.calls.get(call.call).intent.effect);
  }
  operation.retirement = event;
  state.handoffs.push(event);
  state.retiredCandidates.add(decision.candidate);
  if (state.active === decision.operation) state.active = null;
  state.writerPolicy = decision.nextWriterPolicy;
  state.recordVersion = 2;
}

export function validateEvent(event) {
  const common = ["type", "at"];
  switch (event?.type) {
    case "enroll":
      keys(event, [...common, "location", "writerPolicy", "priorEffects"]);
      for (const name of ["location", "writerPolicy", "priorEffects"]) digest(event[name]);
      break;
    case "open":
      keys(event, [...common, "operation", "plan", "candidate", "authority", "owner", "window", "effects"]);
      for (const name of ["operation", "plan", "candidate", "authority", "owner"]) digest(event[name]);
      keys(event.window, ["start", "deadline"]);
      instant(event.window.start);
      instant(event.window.deadline);
      requireRecord(event.window.start <= event.at && event.at < event.window.deadline, "WINDOW_INVALID");
      requireRecord(Array.isArray(event.effects) && event.effects.length > 0);
      for (const effect of event.effects) digest(effect);
      requireRecord(new Set(event.effects).size === event.effects.length);
      requireRecord(sha256(planBytes(event)) === event.plan, "PLAN_MISMATCH");
      break;
    case "intent":
      keys(event, [...common, "operation", "call", "effect"]);
      for (const name of ["operation", "call", "effect"]) digest(event[name]);
      break;
    case "observe":
      keys(event, [...common, "operation", "call", "outcome", "basis", "evidence"]);
      for (const name of ["operation", "call", "evidence"]) digest(event[name]);
      requireRecord(["unknown", "verified-effect", "verified-no-effect"].includes(event.outcome));
      requireRecord(["call", "destination", "reconciliation"].includes(event.basis));
      requireRecord(event.basis !== "destination" || event.outcome === "unknown", "DESTINATION_IS_NOT_OUTCOME");
      break;
    case "close":
      keys(event, [...common, "operation", "result", "evidence"]);
      digest(event.operation);
      digest(event.evidence);
      requireRecord(["completed", "abandoned"].includes(event.result));
      break;
    case "handoff":
      keys(event, [...common, "decision", "approval"]);
      validateRecoveryDecision(event.decision);
      digest(event.approval);
      break;
    default:
      throw new ReleaseRecordError("EVENT_UNSUPPORTED");
  }
  instant(event.at);
  return event;
}

/** These are retained documents, never executable inputs or authenticated claims. */
export function eventEvidence(event) {
  switch (event.type) {
    case "enroll": return [event.location, event.writerPolicy, event.priorEffects];
    case "open": return [event.plan, event.candidate, event.authority, event.owner, ...event.effects];
    case "observe":
    case "close": return [event.evidence];
    case "handoff": return [sha256(canonicalBytes(event.decision)), event.approval,
      event.decision.previousWriterPolicy, event.decision.nextWriterPolicy, ...event.decision.evidence];
    default: return [];
  }
}

export function emptyReplay() {
  return { root: null, sequence: 0, at: null, active: null,
    recordVersion: 1, writerPolicy: null, prefixSha256: sha256(canonicalBytes({ schemaVersion: 1 })),
    handoffs: [], retiredCandidates: new Set(), retiredEffects: new Set(), acceptedUnknown: new Map(), blocking: new Set(),
    operations: new Map(), calls: new Map(), unresolved: new Set(), conflicts: new Set(), evidence: new Set() };
}

/** Replay preserves all call identities, including closed operations. No retry is performed. */
export function applyEvent(state, event, context) {
  validateEvent(event);
  requireRecord(state.at === null || state.at <= event.at, "EVENT_ORDER");
  requireRecord((state.root === null) === (event.type === "enroll"), "ROOT_INVALID");
  const operation = state.operations.get(event.operation);
  switch (event.type) {
    case "enroll":
      state.root = event;
      state.writerPolicy = event.writerPolicy;
      break;
    case "open":
      requireRecord(state.active === null && state.blocking.size === 0, "OPERATION_UNSETTLED");
      requireRecord(!state.operations.has(event.operation), "OPERATION_REPEATED");
      requireRecord(!state.retiredCandidates.has(event.candidate), "CANDIDATE_RETIRED");
      requireRecord(!event.effects.some(effect => state.retiredEffects.has(effect)), "EFFECT_RETIRED");
      state.operations.set(event.operation, { admission: event, allowedEffects: new Set(event.effects),
        writerPolicyAtAdmission: state.writerPolicy, calls: new Map(), closure: null, retirement: null, effects: new Map() });
      state.active = event.operation;
      break;
    case "intent": {
      requireRecord(operation && state.active === event.operation, "OPERATION_NOT_ACTIVE");
      requireRecord(event.at < operation.admission.window.deadline, "WINDOW_EXPIRED");
      requireRecord(state.blocking.size === 0, "CALL_UNSETTLED");
      requireRecord(!state.calls.has(event.call), "CALL_REPEATED");
      requireRecord(operation.allowedEffects.has(event.effect), "EFFECT_NOT_ADMITTED");
      requireRecord((operation.effects.get(event.effect) ?? 0) === 0, "EFFECT_COMPLETED");
      const call = { intent: event, intentCommit: context?.commit, intentSha256: sha256(canonicalBytes(event)), observationSha256: null,
        outcome: "unknown", observations: 0, lastObservation: null };
      operation.calls.set(event.call, call);
      state.calls.set(event.call, call);
      state.unresolved.add(event.call);
      state.blocking.add(event.call);
      break;
    }
    case "observe": {
      const call = state.calls.get(event.call);
      requireRecord(operation && call?.intent.operation === event.operation, "CALL_NOT_FOUND");
      const prior = call.outcome;
      const conflict = prior === "conflict"
        || (prior !== "unknown" && event.outcome !== "unknown" && prior !== event.outcome);
      call.outcome = event.basis !== "reconciliation" && conflict ? "conflict" : event.outcome;
      call.observations += 1;
      call.lastObservation = event;
      call.observationSha256 = sha256(canonicalBytes(event));
      state.unresolved.delete(event.call);
      state.blocking.delete(event.call);
      state.conflicts.delete(event.call);
      if (["unknown", "conflict"].includes(call.outcome)) {
        state.unresolved.add(event.call);
        const accepted = state.acceptedUnknown.get(event.call);
        if (call.outcome !== "unknown" || accepted?.intentSha256 !== call.intentSha256
          || accepted?.observationSha256 !== call.observationSha256) state.blocking.add(event.call);
      }
      if (call.outcome === "conflict") state.conflicts.add(event.call);
      const verified = (operation.effects.get(call.intent.effect) ?? 0)
        - Number(prior === "verified-effect") + Number(call.outcome === "verified-effect");
      operation.effects.set(call.intent.effect, verified);
      break;
    }
    case "close":
      requireRecord(operation && state.active === event.operation, "OPERATION_NOT_ACTIVE");
      requireRecord(state.blocking.size === 0, "CALL_UNSETTLED");
      requireRecord(event.result !== "completed"
        || operation.admission.effects.every(effect => (operation.effects.get(effect) ?? 0) > 0),
      "EFFECTS_INCOMPLETE");
      operation.closure = event;
      state.active = null;
      break;
    case "handoff":
      applyHandoff(state, event, context);
      break;
  }
  for (const evidence of eventEvidence(event)) state.evidence.add(evidence);
  state.sequence += 1;
  state.at = event.at;
  state.prefixSha256 = sha256(canonicalBytes({ previous: state.prefixSha256, event }));
  return checkpoint(state, event);
}

export function checkpoint(state, event) {
  const legacy = { sequence: state.sequence, eventSha256: sha256(canonicalBytes(event)),
    activeOperation: state.active, unresolvedCalls: state.unresolved.size, conflictingCalls: state.conflicts.size };
  return state.recordVersion === 1 ? legacy : { ...legacy, blockingUnresolvedCalls: state.blocking.size,
    effectiveWriterPolicy: state.writerPolicy };
}

export function frameEvent(bytes) {
  const value = readCanonical(bytes);
  keys(value, ["schemaVersion", "event", "checkpoint"]);
  requireRecord([1, 2].includes(value.schemaVersion)
    && (value.event?.type !== "handoff" || value.schemaVersion === 2), "VERSION_UNSUPPORTED");
  validateEvent(value.event);
  return value;
}

export function inputEvent(bytes) {
  const value = readCanonical(bytes);
  keys(value, ["schemaVersion", "event"]);
  requireRecord(value.schemaVersion === (value.event?.type === "handoff" ? 2 : 1), "VERSION_UNSUPPORTED");
  return validateEvent(value.event);
}

export function publicReplay(state) {
  return { recordVersion: state.recordVersion, effectiveWriterPolicy: state.writerPolicy, prefixSha256: state.prefixSha256,
    checkpoint: { sequence: state.sequence, activeOperation: state.active,
      unresolvedCalls: state.unresolved.size, conflictingCalls: state.conflicts.size,
      ...(state.recordVersion === 2 ? { blockingUnresolvedCalls: state.blocking.size } : {}) },
  operations: [...state.operations].map(([operation, value]) => ({ operation, admission: value.admission,
    writerPolicyAtAdmission: value.writerPolicyAtAdmission, closure: value.closure, retirement: value.retirement,
    calls: [...value.calls].map(([call, data]) => ({ call, intent: data.intent,
      ...(data.intentCommit ? { intentCommit: data.intentCommit } : {}), outcome: data.outcome,
      observations: data.observations, lastObservation: data.lastObservation })) })) };
}
