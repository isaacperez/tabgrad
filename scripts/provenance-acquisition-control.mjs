import {
  ACQUISITION_LIMITS, acquisitionSha256, decodeAcquisitionRecord, requireAcquisition,
  isAcquisitionHash, isAcquisitionToken, isAcquisitionUint,
} from "./provenance-acquisition-record.mjs";

const roles = ["supervisor", "watchdog"];
const causes = new Set(["protocol", "clock", "deadline", "storage", "observer", "controller", "peer"]);
const contextKeys = ["role", "operationId", "expectedHeaderSha256", "profileSha256", "t0MonotonicNs", "deadlineNs"];
const envelope = ["kind", "actor", "operationId", "phase", "actionId", "atNs"];
export const ACQUISITION_CONTROL_PHASES = Object.freeze({
  write_header: "setup", read_header: "setup", verify_header: "setup", peer_ready: "setup",
  write_progress: "observe", finish_progress: "close", write_ending: "close", close_writer: "close",
});
const effects = ACQUISITION_CONTROL_PHASES;

/** Closed own-data input; no coercion, accessors, extensions or symbol fields. */
function hasFields(value, keys) {
  if (value === null || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).length === keys.length && keys.every(key => descriptors[key]
    && Object.hasOwn(descriptors[key], "value") && descriptors[key].enumerable);
}

function freezeState(state) {
  return Object.freeze({ ...state, pending: state.pending && Object.freeze(state.pending),
    firstFailure: state.firstFailure && Object.freeze(state.firstFailure) });
}

function revoked(state, code, atNs) {
  return freezeState({ ...state, gate: "revoked", firstFailure: state.firstFailure ?? { code, atNs } });
}

function result(state, actions = []) { return Object.freeze({ state, actions: Object.freeze(actions) }); }

/** One actor's local state, not a wire format, authenticated identity or authority. */
export function createAcquisitionControl(context) {
  requireAcquisition(hasFields(context, contextKeys) && roles.includes(context.role)
    && isAcquisitionToken(context.operationId) && isAcquisitionHash(context.expectedHeaderSha256)
    && isAcquisitionHash(context.profileSha256) && isAcquisitionUint(context.t0MonotonicNs)
    && isAcquisitionUint(context.deadlineNs) && context.deadlineNs !== "0", "CONTROL_CONTEXT");
  return freezeState({ context: Object.freeze({ ...context }), gate: "pending", phase: "setup", stage: "new",
    nextActionId: "1", pending: null, lastAtNs: "0", firstFailure: null,
    progressFinished: false, progressFinishAttempted: false, endingWritten: false, endingAttempted: false,
    closeAttempted: false, localClosed: false });
}

function validEnvelope(state, event) {
  const kind = event !== null && typeof event === "object" ? Object.getOwnPropertyDescriptor(event, "kind")?.value : null;
  const extra = kind === "request" ? ["effect"] : kind === "complete"
    ? ["ok", "code", "bytes", "peer"] : kind === "stop" ? ["code"] : kind === "tick" ? [] : null;
  return extra !== null && hasFields(event, [...envelope, ...extra])
    && event.actor === state.context.role && event.operationId === state.context.operationId
    && ["setup", "observe", "close"].includes(event.phase);
}

function actionAllowed(state, effect) {
  if (!Object.hasOwn(effects, effect) || state.pending || state.localClosed) return false;
  const supervisor = state.context.role === "supervisor";
  if (effect === "close_writer") return !state.closeAttempted;
  if (effect === "finish_progress") return supervisor && !state.progressFinishAttempted && !state.endingAttempted;
  if (effect === "write_ending") return !state.endingAttempted
    && (!supervisor || state.progressFinished || state.gate === "revoked");
  if (state.gate === "revoked" || state.phase === "close") return false;
  switch (effect) {
    case "write_header": return supervisor && state.stage === "new";
    case "read_header": return supervisor && state.stage === "written";
    case "peer_ready": return supervisor && state.stage === "read";
    case "verify_header": return !supervisor && state.stage === "new";
    case "write_progress": return supervisor && state.gate === "ready";
    default: return false;
  }
}

function boundHeader(bytes, context) {
  if (!Buffer.isBuffer(bytes) || bytes.length > ACQUISITION_LIMITS.header) return false;
  try {
    const header = decodeAcquisitionRecord("header", bytes);
    return header.operationId === context.operationId && header.profileSha256 === context.profileSha256
      && header.t0MonotonicNs === context.t0MonotonicNs && acquisitionSha256(bytes) === context.expectedHeaderSha256;
  } catch { return false; }
}

function boundPeer(peer, action, context) {
  return hasFields(peer, ["actor", "operationId", "phase", "actionId", "headerSha256"])
    && peer.actor === "watchdog" && peer.operationId === context.operationId && peer.phase === "setup"
    && peer.actionId === action.actionId && peer.headerSha256 === context.expectedHeaderSha256;
}

function completed(state, event) {
  const action = state.pending;
  let next = { ...state, pending: null };
  if (typeof event.ok !== "boolean" || (event.ok ? event.code !== null : !causes.has(event.code))) {
    return revoked(next, "protocol", state.lastAtNs);
  }
  if (!event.ok) return revoked(next, event.bytes === null && event.peer === null ? event.code : "protocol", state.lastAtNs);
  const headerRead = ["read_header", "verify_header"].includes(action.kind);
  if ((!headerRead && event.bytes !== null) || (action.kind !== "peer_ready" && event.peer !== null)) {
    return revoked(next, "protocol", state.lastAtNs);
  }
  // A late completion can account for cleanup, never restore an admission.
  if (state.gate === "revoked" && !["finish_progress", "write_ending", "close_writer"].includes(action.kind)) return freezeState(next);
  if (headerRead && !boundHeader(event.bytes, state.context)) return revoked(next, "protocol", state.lastAtNs);
  if (action.kind === "peer_ready" && !boundPeer(event.peer, action, state.context)) return revoked(next, "protocol", state.lastAtNs);
  switch (action.kind) {
    case "write_header": next.stage = "written"; break;
    case "read_header": next.stage = "read"; break;
    case "verify_header": case "peer_ready": next.stage = "bound"; next.gate = "ready"; break;
    case "finish_progress": next.progressFinished = true; break;
    case "write_ending": next.endingWritten = true; break;
    case "close_writer": next.localClosed = true; break;
  }
  return freezeState(next);
}

/**
 * Closed request/completion/stop/tick protocol. State must come from this module.
 * Returns at most one effect; it never performs I/O or retains an event history.
 * Times are elapsed uint64 nanoseconds from context.T0; deadline is never renewed.
 */
export function advanceAcquisitionControl(state, event) {
  if (!validEnvelope(state, event)) return result(revoked(state, "protocol", null));
  if (event.kind === "complete" && (!state.pending || event.actionId !== state.pending.actionId
    || event.phase !== state.pending.phase)) return result(revoked(state, "protocol", null));
  if (["stop", "tick"].includes(event.kind) && (event.actionId !== null || event.phase !== state.phase)) {
    return result(revoked(state, "protocol", null));
  }
  const clockValid = isAcquisitionUint(event.atNs) && BigInt(event.atNs) >= BigInt(state.lastAtNs);
  let next = clockValid ? freezeState({ ...state, lastAtNs: event.atNs }) : revoked(state, "clock", null);
  if (clockValid && BigInt(event.atNs) > BigInt(state.context.deadlineNs)) next = revoked(next, "deadline", event.atNs);
  if (event.kind === "stop") return result(revoked(next, causes.has(event.code) ? event.code : "protocol", clockValid ? event.atNs : null));
  if (event.kind === "tick") return result(next);
  if (event.kind === "complete") return result(completed(next, event));
  const cleanup = ["finish_progress", "close_writer"].includes(event.effect);
  if ((!clockValid || next.gate === "revoked") && !cleanup && event.effect !== "write_ending") return result(next);
  if (!clockValid && event.effect === "write_ending") return result(next);
  if (typeof event.effect !== "string" || event.actionId !== next.nextActionId
    || event.phase !== effects[event.effect] || !actionAllowed(next, event.effect)) {
    return result(revoked(next, "protocol", clockValid ? event.atNs : null));
  }
  const action = { actor: next.context.role, operationId: next.context.operationId,
    phase: event.phase, actionId: event.actionId, kind: event.effect };
  const successor = BigInt(event.actionId) + 1n;
  if (!isAcquisitionUint(successor.toString())) return result(revoked(next, "protocol", event.atNs));
  next = freezeState({ ...next, phase: event.phase, pending: action, nextActionId: successor.toString(),
    progressFinishAttempted: next.progressFinishAttempted || event.effect === "finish_progress",
    endingAttempted: next.endingAttempted || event.effect === "write_ending",
    closeAttempted: next.closeAttempted || event.effect === "close_writer" });
  return result(next, [next.pending]);
}
