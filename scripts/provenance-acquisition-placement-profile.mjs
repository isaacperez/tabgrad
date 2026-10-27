import { isAbsolute, resolve } from "node:path";
import { constants as bufferConstants } from "node:buffer";
import { acquisitionFields as fields, isAcquisitionHash, isAcquisitionToken, isAcquisitionUint,
  requireAcquisition } from "./provenance-acquisition-record.mjs";
import { freezeHostData } from "./provenance-acquisition-host-profile.mjs";

const check = value => requireAcquisition(value, "PLACEMENT_INPUT");
const path = value => typeof value === "string" && value.isWellFormed() && isAbsolute(value) && resolve(value) === value
  && value !== "/" && !/[\x00-\x1f\x7f\\]/.test(value) && Buffer.byteLength(value) <= 4096;
const identity = value => fields(value, ["dev", "ino"]) && isAcquisitionUint(value.dev)
  && isAcquisitionUint(value.ino) && value.ino !== "0";
const anchor = value => fields(value, ["path", "identity"]) && path(value.path) && identity(value.identity);
const budget = value => Number.isSafeInteger(value) && value > 0 && value < bufferConstants.MAX_LENGTH;
export const PLACEMENT_ERRORS = Object.freeze(["PLACEMENT_INPUT", "PLACEMENT_OPEN", "PLACEMENT_IDENTITY", "PLACEMENT_READ",
  "PLACEMENT_CLOSE", "PLACEMENT_PLATFORM", "PLACEMENT_FILESYSTEM", "PLACEMENT_BUSY", "PLACEMENT_STOPPED",
  "PLACEMENT_PROTOCOL", "PLACEMENT_GATE", "PLACEMENT_CLOCK", "PLACEMENT_DEADLINE", "PLACEMENT_LIMIT"]);

/** Specific cgroupfs, single-leaf laboratory expectations; no discovery or authority. */
export function copyPlacementProfile(input) {
  check(fields(input, ["context", "containerId", "preparedContainerSha256", "launcherProfileSha256",
    "hierarchy", "proc", "namespaces", "limits"])
    && fields(input.context, ["operationId", "t0MonotonicNs", "deadlineNs", "root"])
    && isAcquisitionToken(input.context.operationId) && isAcquisitionUint(input.context.t0MonotonicNs)
    && isAcquisitionUint(input.context.deadlineNs) && input.context.deadlineNs !== "0"
    && BigInt(input.context.deadlineNs) <= 180000000000n && path(input.context.root)
    && isAcquisitionHash(input.containerId) && isAcquisitionHash(input.preparedContainerSha256)
    && isAcquisitionHash(input.launcherProfileSha256) && anchor(input.proc)
    && fields(input.hierarchy, ["root", "case"]) && anchor(input.hierarchy.root)
    && fields(input.namespaces, ["pid", "cgroup", "time"]) && Object.values(input.namespaces).every(identity)
    && fields(input.limits, ["procsBytes", "procBytes", "maxProcesses"]) && Object.values(input.limits).every(budget));
  const chain = input.hierarchy.case;
  check(Array.isArray(chain) && Object.getPrototypeOf(chain) === Array.prototype
    && chain.length > 0 && chain.length <= 16 && Object.keys(chain).length === chain.length
    && Reflect.ownKeys(chain).length === chain.length + 1);
  const ids = new Set([`${input.hierarchy.root.identity.dev}:${input.hierarchy.root.identity.ino}`]);
  for (let i = 0; i < chain.length; i++) {
    const d = Object.getOwnPropertyDescriptor(chain, String(i)); check(d && Object.hasOwn(d, "value") && d.enumerable);
    const part = d.value;
    check(fields(part, ["name", "identity"]) && typeof part.name === "string"
      && /^[A-Za-z0-9_.@-]{1,128}$/.test(part.name) && ![".", ".."].includes(part.name) && identity(part.identity));
    const key = `${part.identity.dev}:${part.identity.ino}`; check(!ids.has(key)); ids.add(key);
  }
  return freezeHostData(JSON.parse(JSON.stringify(input)));
}

export function parsePlacementPids(bytes, maxProcesses) {
  check(Buffer.isBuffer(bytes) && Number.isSafeInteger(maxProcesses) && maxProcesses > 0);
  requireAcquisition(bytes.every(b => b === 10 || b >= 48 && b <= 57), "PLACEMENT_READ");
  const text = bytes.toString("ascii");
  requireAcquisition(text === "" || text.endsWith("\n"), "PLACEMENT_READ");
  const values = text === "" ? [] : text.slice(0, -1).split("\n");
  requireAcquisition(values.every(pid => isAcquisitionUint(pid) && pid !== "0"), "PLACEMENT_READ");
  // Linux permits duplicates and unstable order in cgroup.procs.
  const pids = [...new Set(values)];
  requireAcquisition(pids.length <= maxProcesses, "PLACEMENT_LIMIT");
  return Object.freeze(pids);
}

export function parsePlacementStat(bytes) {
  requireAcquisition(Buffer.isBuffer(bytes), "PLACEMENT_READ");
  const text = bytes.toString("latin1");
  // comm can contain whitespace, newlines and ')'; numeric fields follow the last ') '.
  const first = text.indexOf(" ("); const last = text.lastIndexOf(") ");
  requireAcquisition(first > 0 && last > first && text.endsWith("\n"), "PLACEMENT_READ");
  const pid = text.slice(0, first); const parts = text.slice(last + 2, -1).split(" ");
  requireAcquisition(isAcquisitionUint(pid) && pid !== "0" && parts.length >= 20
    && /^[A-Za-z]$/.test(parts[0]) && parts.slice(1).every(v => /^-?(0|[1-9][0-9]*)$/.test(v))
    && isAcquisitionUint(parts[1]) && isAcquisitionUint(parts[19]), "PLACEMENT_READ");
  return Object.freeze({ pid, ppid: parts[1], state: parts[0], starttime: parts[19] });
}

export function parsePlacementStatus(bytes) {
  requireAcquisition(Buffer.isBuffer(bytes) && bytes.at(-1) === 10, "PLACEMENT_READ");
  const found = {};
  for (const line of bytes.toString("latin1").split("\n")) {
    const match = /^(Pid|Tgid|NSpid|NStgid):[\t ]+(.+)$/.exec(line);
    if (!match) continue;
    requireAcquisition(!Object.hasOwn(found, match[1]), "PLACEMENT_READ");
    const vector = match[2].split(/[\t ]+/);
    requireAcquisition(vector.every(v => isAcquisitionUint(v) && v !== "0"), "PLACEMENT_READ");
    found[match[1]] = vector;
  }
  requireAcquisition(["Pid", "Tgid", "NSpid", "NStgid"].every(k => Object.hasOwn(found, k))
    && found.Pid.length === 1 && found.Tgid.length === 1
    && found.Pid[0] === found.Tgid[0] && found.NSpid.length === found.NStgid.length
    && found.NSpid.every((v, i) => v === found.NStgid[i]) && found.NSpid[0] === found.Pid[0], "PLACEMENT_READ");
  return freezeHostData({ pid: found.Pid[0], namespacePids: found.NSpid });
}
