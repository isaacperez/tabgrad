import {
  ACQUISITION_LIMITS, requireAcquisition, isAcquisitionToken, isAcquisitionUint,
  isAcquisitionHash, isAcquisitionUtc, decodeAcquisitionRecord, encodeAcquisitionRecord,
  acquisitionFields as processFields,
} from "./provenance-acquisition-record.mjs";
import { ACQUISITION_ACTOR_PARTS } from "./provenance-acquisition-record-io.mjs";
import { createAcquisitionControl } from "./provenance-acquisition-control.mjs";
import { validateHostProfile, validateHostReport } from "./provenance-acquisition-host-profile.mjs";

// Total wire budget, including base64 header, escaped setup paths and metadata.
export const ACQUISITION_PROCESS_MESSAGE_LIMIT = 2 * ACQUISITION_LIMITS.header;
export const ACQUISITION_PROCESS_CAUSES = Object.freeze([
  "startup", "protocol", "peer", "channel", "deadline", "controller", "storage", "clock", "cleanup",
]);
const controlCauses = ["protocol", "peer", "deadline", "controller", "storage", "clock", "observer"];
const ioCodes = ["PART_LIMIT", "INVALID_RECORD", "OPERATION_MISMATCH", "EVENT_ORDER", "WRITER_STOPPED",
  "WRITE_FAILED", "WRITE_EXTENT_UNKNOWN", "WRITE_NO_PROGRESS", "CLOSE_FAILED"];

export { processFields };

export function validateProcessTiming(timing) {
  requireAcquisition(processFields(timing, ["heartbeatMs", "peerTimeoutMs", "termAfterMs", "killAfterMs", "closeWaitMs"])
    && Object.values(timing).every(n => Number.isInteger(n) && n > 0 && n <= 2147483647)
    && timing.heartbeatMs < timing.peerTimeoutMs && timing.termAfterMs < timing.killAfterMs
    && timing.killAfterMs < timing.closeWaitMs, "PROCESS_INPUT");
  return Object.freeze({ ...timing });
}

export function processHeader(text) {
  requireAcquisition(typeof text === "string" && text.length <= Math.ceil(ACQUISITION_LIMITS.header / 3) * 4
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text), "PROCESS_PROTOCOL");
  const bytes = Buffer.from(text, "base64");
  requireAcquisition(bytes.length <= ACQUISITION_LIMITS.header, "PROCESS_PROTOCOL");
  decodeAcquisitionRecord("header", bytes);
  return bytes;
}

function validDestinations(destinations, actor) {
  const parts = ACQUISITION_ACTOR_PARTS[actor];
  return processFields(destinations, parts) && parts.every(role => {
    const d = destinations[role];
    return processFields(d, ["name", "identity"]) && typeof d.name === "string" && d.name.length > 0
      && Buffer.byteLength(d.name) <= 1024 && processFields(d.identity, ["dev", "ino"])
      && isAcquisitionUint(d.identity.dev) && isAcquisitionUint(d.identity.ino) && d.identity.ino !== "0";
  });
}

export function validateProcessProgress(data) {
  requireAcquisition(processFields(data, ["phase", "kind", "subject", "code", "reference", "value"]), "PROCESS_PROTOCOL");
  encodeAcquisitionRecord("progress", { recordType: "acq_event_v1", operationId: "0".repeat(32),
    sequence: "1", atNs: "0", ...data });
  return data;
}

function validWrite(w, role) {
  return processFields(w, ["role", "state", "confirmedBytes", "uncertain", "firstError", "closeError", "sha256"])
    && w.role === role && ["pending", "complete", "incomplete", "limit"].includes(w.state)
    && Number.isSafeInteger(w.confirmedBytes) && w.confirmedBytes >= 0 && w.confirmedBytes <= ACQUISITION_LIMITS[role]
    && typeof w.uncertain === "boolean" && (w.firstError === null || ioCodes.includes(w.firstError))
    && (w.closeError === null || w.closeError === "CLOSE_FAILED") && isAcquisitionHash(w.sha256);
}

function validReport(r, actor) {
  const base = ["pid", "gate", "phase", "stage", "nextActionId", "lastAtNs", "firstFailure", "localClosed", "writes"];
  const withHost = processFields(r, [...base, "host"]);
  if (withHost && r.host !== null) validateHostReport(r.host, actor);
  return (processFields(r, base) || withHost)
    && Number.isSafeInteger(r.pid) && r.pid > 0 && ["pending", "ready", "revoked"].includes(r.gate)
    && ["setup", "observe", "close"].includes(r.phase) && ["new", "written", "read", "bound"].includes(r.stage)
    && isAcquisitionUint(r.nextActionId) && r.nextActionId !== "0" && isAcquisitionUint(r.lastAtNs)
    && (r.firstFailure === null || (processFields(r.firstFailure, ["code", "atNs"])
      && controlCauses.includes(r.firstFailure.code) && (r.firstFailure.atNs === null || isAcquisitionUint(r.firstFailure.atNs))))
    && (r.firstFailure?.atNs === null || r.firstFailure === null || BigInt(r.firstFailure.atNs) <= BigInt(r.lastAtNs))
    && typeof r.localClosed === "boolean" && processFields(r.writes, ACQUISITION_ACTOR_PARTS[actor])
    && ACQUISITION_ACTOR_PARTS[actor].every(role => validWrite(r.writes[role], role))
    && (r.gate !== "ready" || (r.stage === "bound" && r.firstFailure === null))
    && (r.gate !== "revoked" || r.firstFailure !== null)
    && (r.firstFailure === null || r.gate === "revoked")
    && (!r.localClosed || (r.phase === "close" && Object.values(r.writes).every(w => w.closeError === null)));
}

function validateRequest(message) {
  const { payload: p, actor } = message;
  requireAcquisition(processFields(p, ["command", "data"]), "PROCESS_PROTOCOL");
  switch (p.command) {
    case "init": {
      const d = p.data;
      const base = ["root", "destinations", "context", "header", "timing"];
      const withHost = processFields(d, [...base, "host"]);
      requireAcquisition((processFields(d, base) || withHost)
        && typeof d.root === "string" && d.root.length > 0 && Buffer.byteLength(d.root) <= 4096
        && validDestinations(d.destinations, actor), "PROCESS_PROTOCOL");
      const state = createAcquisitionControl(d.context);
      requireAcquisition(state.context.role === actor && state.context.operationId === message.operationId, "PROCESS_PROTOCOL");
      if (withHost) {
        validateHostProfile(d.host);
        requireAcquisition(d.host.operationId === state.context.operationId
          && d.host.t0MonotonicNs === state.context.t0MonotonicNs
          && BigInt(d.host.observeUntilNs) <= BigInt(state.context.deadlineNs), "PROCESS_PROTOCOL");
      }
      validateProcessTiming(d.timing);
      if (actor === "supervisor") processHeader(d.header);
      else requireAcquisition(d.header === null, "PROCESS_PROTOCOL");
      break;
    }
    case "prepare": requireAcquisition(actor === "supervisor" && p.data === null, "PROCESS_PROTOCOL"); break;
    case "verify":
      requireAcquisition(actor === "watchdog" && processFields(p.data, ["header"]), "PROCESS_PROTOCOL");
      processHeader(p.data.header); break;
    case "ready":
      requireAcquisition(actor === "supervisor" && processFields(p.data, ["actor", "operationId", "phase", "actionId", "headerSha256"])
        && p.data.actor === "watchdog" && p.data.operationId === message.operationId && p.data.phase === "setup"
        && isAcquisitionUint(p.data.actionId) && isAcquisitionHash(p.data.headerSha256), "PROCESS_PROTOCOL"); break;
    case "append": requireAcquisition(actor === "supervisor", "PROCESS_PROTOCOL"); validateProcessProgress(p.data); break;
    case "finish": requireAcquisition(processFields(p.data, ["observedUtc"]) && isAcquisitionUtc(p.data.observedUtc), "PROCESS_PROTOCOL"); break;
    default: requireAcquisition(false, "PROCESS_PROTOCOL");
  }
}

function validateMessage(m) {
  requireAcquisition(processFields(m, ["version", "kind", "actor", "operationId", "id", "payload"])
    && m.version === 1 && Object.hasOwn(ACQUISITION_ACTOR_PARTS, m.actor)
    && isAcquisitionToken(m.operationId) && isAcquisitionUint(m.id), "PROCESS_PROTOCOL");
  if (m.kind === "request") validateRequest(m);
  else if (m.kind === "reply") {
    const p = m.payload;
    requireAcquisition(processFields(p, ["command", "ok", "report", "header"])
      && ["init", "prepare", "verify", "ready", "append", "finish"].includes(p.command)
      && typeof p.ok === "boolean" && validReport(p.report, m.actor), "PROCESS_PROTOCOL");
    if (p.header !== null) { requireAcquisition(m.actor === "supervisor" && p.command === "prepare", "PROCESS_PROTOCOL"); processHeader(p.header); }
    if (p.report.host) requireAcquisition(p.report.host.operationId === m.operationId, "PROCESS_PROTOCOL");
  } else if (m.kind === "pulse") {
    requireAcquisition(m.id !== "0" && processFields(m.payload, ["atNs"]) && isAcquisitionUint(m.payload.atNs), "PROCESS_PROTOCOL");
  } else if (m.kind === "closed") {
    requireAcquisition(m.id === "0" && processFields(m.payload, ["report"])
      && validReport(m.payload.report, m.actor) && m.payload.report.localClosed, "PROCESS_PROTOCOL");
    if (m.payload.report.host) requireAcquisition(m.payload.report.host.operationId === m.operationId, "PROCESS_PROTOCOL");
  } else {
    requireAcquisition(["stop", "fault"].includes(m.kind) && m.id === "0" && processFields(m.payload, ["code"])
      && ACQUISITION_PROCESS_CAUSES.includes(m.payload.code), "PROCESS_PROTOCOL");
  }
  return m;
}

/** Bounded string before parsing. Trusted inspected endpoints; not a native IPC allocation guard. */
export function decodeAcquisitionProcessMessage(wire) {
  requireAcquisition(typeof wire === "string" && Buffer.byteLength(wire) <= ACQUISITION_PROCESS_MESSAGE_LIMIT, "PROCESS_PROTOCOL");
  let message;
  try {
    message = JSON.parse(wire);
    requireAcquisition(JSON.stringify(message) === wire, "PROCESS_PROTOCOL");
    return validateMessage(message);
  } catch { requireAcquisition(false, "PROCESS_PROTOCOL"); }
}

export function encodeAcquisitionProcessMessage(kind, actor, operationId, id, payload) {
  const message = validateMessage({ version: 1, kind, actor, operationId, id, payload });
  const wire = JSON.stringify(message);
  requireAcquisition(Buffer.byteLength(wire) <= ACQUISITION_PROCESS_MESSAGE_LIMIT, "PROCESS_PROTOCOL");
  return wire;
}

/** Flow control callback only. A successful send does not acknowledge the peer's work. */
export function sendAcquisitionProcessMessage(endpoint, wire) {
  return new Promise((resolve, reject) => {
    try {
      requireAcquisition(endpoint.connected === true, "PROCESS_CHANNEL");
      endpoint.send(wire, error => error ? reject(new Error("PROCESS_CHANNEL")) : resolve());
    } catch { reject(new Error("PROCESS_CHANNEL")); }
  });
}
