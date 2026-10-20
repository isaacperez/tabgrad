import {
  acquisitionFields as fields, requireAcquisition, isAcquisitionUint, isAcquisitionToken, AcquisitionRecordError,
} from "./provenance-acquisition-record.mjs";

export const HOST_ROLES = Object.freeze(["supervisor", "watchdog", "guard"]);
export const HOST_GROUPS = Object.freeze(["case", ...HOST_ROLES]);
export const HOST_ERRORS = Object.freeze(["HOST_INPUT", "HOST_PLATFORM", "HOST_FILESYSTEM", "HOST_IDENTITY",
  "HOST_TYPE", "HOST_MEMBER", "HOST_OPEN", "HOST_READ", "HOST_WRITE", "HOST_CLOSE", "HOST_CLOCK", "HOST_BUSY", "HOST_STOPPED",
  "HOST_DEADLINE", "HOST_PEER", "HOST_CHANNEL", "HOST_CONTROLLER", "HOST_PROTOCOL", "HOST_ENTRY"]);
export const HOST_READ_LIMITS = Object.freeze({ type: 32, events: 128, procs: 1024 });

export function freezeHostData(value) {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) freezeHostData(v);
    Object.freeze(value);
  }
  return value;
}

function identity(value) {
  return fields(value, ["dev", "ino"]) && isAcquisitionUint(value.dev)
    && isAcquisitionUint(value.ino) && value.ino !== "0";
}

function components(path) {
  return path.split("/").slice(1);
}

export function validateHostProfile(p) {
  requireAcquisition(fields(p, ["operationId", "t0MonotonicNs", "stopAtNs", "observeUntilNs", "pollMs", "root", "groups"])
    && isAcquisitionToken(p.operationId) && isAcquisitionUint(p.t0MonotonicNs)
    && isAcquisitionUint(p.stopAtNs) && p.stopAtNs !== "0" && isAcquisitionUint(p.observeUntilNs)
    && BigInt(p.stopAtNs) < BigInt(p.observeUntilNs)
    && Number.isInteger(p.pollMs) && p.pollMs > 0 && p.pollMs <= 5000
    && fields(p.root, ["path", "identity"]) && typeof p.root.path === "string"
    && p.root.path.startsWith("/") && Buffer.byteLength(p.root.path) <= 4096
    && !/[\x00-\x1f\x7f\\]/.test(p.root.path) && components(p.root.path).length <= 64
    && components(p.root.path).every(s => s.length > 0 && s !== "." && s !== "..")
    && identity(p.root.identity) && fields(p.groups, HOST_GROUPS), "HOST_INPUT");
  const paths = [];
  const leafIds = new Set([`${p.root.identity.dev}:${p.root.identity.ino}`]);
  const expected = new Map();
  for (const role of HOST_GROUPS) {
    const chain = p.groups[role];
    requireAcquisition(Array.isArray(chain) && Object.getPrototypeOf(chain) === Array.prototype && chain.length > 0 && chain.length <= 16
      && Object.keys(chain).length === chain.length && Reflect.ownKeys(chain).length === chain.length + 1, "HOST_INPUT");
    let path = "";
    const ancestorIds = new Set([`${p.root.identity.dev}:${p.root.identity.ino}`]);
    for (let index = 0; index < chain.length; index += 1) {
      const d = Object.getOwnPropertyDescriptor(chain, String(index));
      requireAcquisition(d && Object.hasOwn(d, "value") && d.enumerable, "HOST_INPUT");
      const part = d.value;
      requireAcquisition(fields(part, ["name", "identity"]) && typeof part.name === "string"
        && /^[A-Za-z0-9_.@-]{1,128}$/.test(part.name) && ![".", ".."].includes(part.name) && identity(part.identity), "HOST_INPUT");
      path += "/" + part.name;
      const id = `${part.identity.dev}:${part.identity.ino}`;
      requireAcquisition(!ancestorIds.has(id) && (!expected.has(path) || expected.get(path) === id), "HOST_INPUT");
      ancestorIds.add(id); expected.set(path, id);
    }
    const last = chain.at(-1).identity;
    const id = `${last.dev}:${last.ino}`;
    requireAcquisition(!leafIds.has(id) && paths.every(old => !path.startsWith(old + "/")
      && !old.startsWith(path + "/") && old !== path), "HOST_INPUT");
    leafIds.add(id); paths.push(path);
  }
  return p;
}

export function copyHostProfile(profile) {
  validateHostProfile(profile);
  return freezeHostData(JSON.parse(JSON.stringify(profile)));
}

function effect(e) {
  return fields(e, ["state", "error"]) && ["not_requested", "pending", "acknowledged", "unknown"].includes(e.state)
    && (e.state === "unknown" ? e.error === "HOST_WRITE" : e.error === null);
}

export function validateHostReport(r, role) {
  const base = ["actor", "operationId", "revoked", "lastAtNs", "firstFailure", "observation",
    "freeze", "kill", "ioClosed", "ioPending", "externalClosure", "clockAdmission", "releaseAdmission"];
  const entering = fields(r, [...base, "entry"]);
  requireAcquisition((fields(r, base) || entering)
    && r.actor === role && HOST_ROLES.includes(role) && isAcquisitionToken(r.operationId)
    && typeof r.revoked === "boolean" && (r.lastAtNs === null || isAcquisitionUint(r.lastAtNs))
    && (r.firstFailure === null || HOST_ERRORS.includes(r.firstFailure))
    && fields(r.observation, ["atNs", "populated", "frozen", "error"])
    && (r.observation.atNs === null || isAcquisitionUint(r.observation.atNs))
    && [null, false, true].includes(r.observation.populated) && [null, false, true].includes(r.observation.frozen)
    && (r.observation.error === null || HOST_ERRORS.includes(r.observation.error))
    && effect(r.freeze) && effect(r.kill) && ["open", "pending", "closed", "unknown"].includes(r.ioClosed)
    && Number.isInteger(r.ioPending) && r.ioPending >= 0 && r.ioPending <= 3
    && r.externalClosure === "unqualified" && r.clockAdmission === "unqualified" && r.releaseAdmission === "unqualified",
  "HOST_INPUT");
  if (entering) requireAcquisition(fields(r.entry, ["state", "error"])
    && ["not_requested", "pending", "acknowledged", "verified", "unknown"].includes(r.entry.state)
    && (r.entry.state === "unknown" ? r.entry.error === "HOST_ENTRY" : r.entry.error === null), "HOST_INPUT");
  requireAcquisition((r.firstFailure === null || r.revoked)
    && (r.ioClosed !== "closed" || r.ioPending === 0)
    && (r.observation.atNs !== null || r.observation.populated === null && r.observation.frozen === null)
    && (r.observation.atNs === null || r.lastAtNs !== null && BigInt(r.observation.atNs) <= BigInt(r.lastAtNs)), "HOST_INPUT");
  return r;
}

/** Monotonic evidence shared by the process and guard transports. */
export function validateHostReportProgress(old, h, code = "HOST_INPUT") {
  if (!old) return;
  requireAcquisition(h && old.actor === h.actor && old.operationId === h.operationId
    && (!old.revoked || h.revoked) && (old.firstFailure === null || h.firstFailure === old.firstFailure)
    && (h.lastAtNs === null || old.lastAtNs === null || BigInt(h.lastAtNs) >= BigInt(old.lastAtNs)), code);
  requireAcquisition(old.ioClosed === "open" || old.ioClosed === "pending" && h.ioClosed !== "open"
    || old.ioClosed === h.ioClosed, code);
  for (const effect of ["freeze", "kill"]) requireAcquisition(old[effect].state === "not_requested"
    || old[effect].state === "pending" && h[effect].state !== "not_requested"
    || old[effect].state === h[effect].state && old[effect].error === h[effect].error, code);
  if (old.entry) requireAcquisition(h.entry && JSON.stringify(old.entry) === JSON.stringify(h.entry), code);
}

/** Failed opening has no live controller; retain its known cause and cleanup uncertainty. */
export function failedHostReport(role, operationId, error) {
  const known = error instanceof AcquisitionRecordError;
  const code = known && HOST_ERRORS.includes(error.code) ? error.code : "HOST_OPEN";
  const closed = known && (error.closeError === null
    || error.closeError === undefined && ["HOST_INPUT", "HOST_PLATFORM", "HOST_CLOCK"].includes(code));
  const r = { actor: role, operationId, revoked: true, lastAtNs: null, firstFailure: code,
    observation: { atNs: null, populated: null, frozen: null, error: code },
    freeze: { state: "not_requested", error: null }, kill: { state: "not_requested", error: null },
    ioClosed: closed ? "closed" : "unknown", ioPending: 0,
    externalClosure: "unqualified", clockAdmission: "unqualified", releaseAdmission: "unqualified" };
  if (known && error.entry) r.entry = { ...error.entry };
  validateHostReport(r, role);
  return freezeHostData(r);
}
