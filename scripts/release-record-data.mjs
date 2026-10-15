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
    default: return [];
  }
}

export function emptyReplay() {
  return { root: null, sequence: 0, at: null, active: null,
    operations: new Map(), calls: new Map(), unresolved: new Set(), conflicts: new Set(), evidence: new Set() };
}

/** Replay preserves all call identities, including closed operations. No retry is performed. */
export function applyEvent(state, event) {
  validateEvent(event);
  requireRecord(state.at === null || state.at <= event.at, "EVENT_ORDER");
  requireRecord((state.root === null) === (event.type === "enroll"), "ROOT_INVALID");
  const operation = state.operations.get(event.operation);
  switch (event.type) {
    case "enroll":
      state.root = event;
      break;
    case "open":
      requireRecord(state.active === null && state.unresolved.size === 0, "OPERATION_UNSETTLED");
      requireRecord(!state.operations.has(event.operation), "OPERATION_REPEATED");
      state.operations.set(event.operation, { admission: event, allowedEffects: new Set(event.effects),
        calls: new Map(), closure: null, effects: new Map() });
      state.active = event.operation;
      break;
    case "intent": {
      requireRecord(operation && state.active === event.operation, "OPERATION_NOT_ACTIVE");
      requireRecord(event.at < operation.admission.window.deadline, "WINDOW_EXPIRED");
      requireRecord(state.unresolved.size === 0, "CALL_UNSETTLED");
      requireRecord(!state.calls.has(event.call), "CALL_REPEATED");
      requireRecord(operation.allowedEffects.has(event.effect), "EFFECT_NOT_ADMITTED");
      requireRecord((operation.effects.get(event.effect) ?? 0) === 0, "EFFECT_COMPLETED");
      const call = { intent: event, outcome: "unknown", observations: 0, lastObservation: null };
      operation.calls.set(event.call, call);
      state.calls.set(event.call, call);
      state.unresolved.add(event.call);
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
      state.unresolved.delete(event.call);
      state.conflicts.delete(event.call);
      if (["unknown", "conflict"].includes(call.outcome)) state.unresolved.add(event.call);
      if (call.outcome === "conflict") state.conflicts.add(event.call);
      const verified = (operation.effects.get(call.intent.effect) ?? 0)
        - Number(prior === "verified-effect") + Number(call.outcome === "verified-effect");
      operation.effects.set(call.intent.effect, verified);
      break;
    }
    case "close":
      requireRecord(operation && state.active === event.operation, "OPERATION_NOT_ACTIVE");
      requireRecord(state.unresolved.size === 0, "CALL_UNSETTLED");
      requireRecord(event.result !== "completed"
        || operation.admission.effects.every(effect => (operation.effects.get(effect) ?? 0) > 0),
      "EFFECTS_INCOMPLETE");
      operation.closure = event;
      state.active = null;
      break;
  }
  for (const evidence of eventEvidence(event)) state.evidence.add(evidence);
  state.sequence += 1;
  state.at = event.at;
  return checkpoint(state, event);
}

export function checkpoint(state, event) {
  return { sequence: state.sequence, eventSha256: sha256(canonicalBytes(event)),
    activeOperation: state.active, unresolvedCalls: state.unresolved.size, conflictingCalls: state.conflicts.size };
}

export function frameEvent(bytes) {
  const value = readCanonical(bytes);
  keys(value, ["schemaVersion", "event", "checkpoint"]);
  requireRecord(value.schemaVersion === 1, "VERSION_UNSUPPORTED");
  validateEvent(value.event);
  return value;
}

export function inputEvent(bytes) {
  const value = readCanonical(bytes);
  keys(value, ["schemaVersion", "event"]);
  requireRecord(value.schemaVersion === 1, "VERSION_UNSUPPORTED");
  return validateEvent(value.event);
}

export function publicReplay(state) {
  return { checkpoint: { sequence: state.sequence, activeOperation: state.active,
    unresolvedCalls: state.unresolved.size, conflictingCalls: state.conflicts.size },
  operations: [...state.operations].map(([operation, value]) => ({ operation, admission: value.admission,
    closure: value.closure, calls: [...value.calls].map(([call, data]) => ({ call, ...data })) })) };
}
