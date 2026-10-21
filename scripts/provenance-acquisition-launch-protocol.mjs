import {
  acquisitionFields, isAcquisitionHash, isAcquisitionToken, isAcquisitionUint, requireAcquisition,
} from "./provenance-acquisition-record.mjs";

export const LAUNCH_CONTROL_LIMITS = Object.freeze({ line: 178, total: 890, observations: 5 });
const keys = "operationId profileSha256 kind atNs launcherPid childPid attempted exitCode signal fds cause cleanupError".split(" ");
const causes = "input clock deadline open identity spawn child protocol control close stopped".split(" ");
const pid = v => isAcquisitionUint(v) && BigInt(v) > 0n && BigInt(v) <= 0xffffffffn;
const nullable = (v, predicate) => v === null || predicate(v);
const check = condition => requireAcquisition(condition, "LAUNCH_CONTROL");

function copyObservation(value) {
  check(acquisitionFields(value, keys));
  check(isAcquisitionToken(value.operationId) && isAcquisitionHash(value.profileSha256)
    && ["R", "S", "X", "F", "E"].includes(value.kind)
    && nullable(value.atNs, isAcquisitionUint) && pid(value.launcherPid) && nullable(value.childPid, pid)
    && typeof value.attempted === "boolean"
    && nullable(value.exitCode, v => Number.isInteger(v) && v >= 0 && v <= 255)
    && nullable(value.signal, v => Number.isInteger(v) && v >= 1 && v <= 64)
    && !(value.exitCode !== null && value.signal !== null)
    && typeof value.fds === "string" && /^[nopcu]{2}$/.test(value.fds)
    && nullable(value.cause, v => causes.includes(v))
    && nullable(value.cleanupError, v => ["close", "clock", "deadline"].includes(v)));
  if (!value.attempted) check(value.childPid === null && value.exitCode === null && value.signal === null);
  if (value.kind === "R") check(!value.attempted && value.fds === "oo" && value.cause === null
    && value.cleanupError === null && value.atNs !== null);
  if (value.kind === "S") check(value.attempted && value.childPid !== null
    && value.exitCode === null && value.signal === null);
  if (value.kind === "X") check(value.attempted);
  if (value.kind === "F") check(value.cause !== null);
  if (value.kind === "E") check(!/[op]/.test(value.fds));
  return Object.freeze(Object.fromEntries(keys.map(key => [key, value[key]])));
}

export function encodeLaunchObservation(value) {
  const r = copyObservation(value);
  const values = keys.map(key => r[key] === null ? "-" : key === "attempted" ? Number(r[key]) : r[key]);
  const bytes = Buffer.from(`TGL1|${values.join("|")}\n`, "ascii");
  check(bytes.length <= LAUNCH_CONTROL_LIMITS.line);
  return bytes;
}

function parseLine(bytes) {
  check(bytes.every(byte => byte === 10 || (byte >= 32 && byte <= 126)));
  const parts = bytes.toString("ascii").slice(0, -1).split("|");
  check(parts.length === 13 && parts.shift() === "TGL1");
  const data = {};
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const part = parts[i];
    if (key === "attempted") { check(part === "0" || part === "1"); data[key] = part === "1"; }
    else if (part === "-") data[key] = null;
    else if (["exitCode", "signal"].includes(key)) {
      check(/^(0|[1-9][0-9]*)$/.test(part)); data[key] = Number(part);
    } else data[key] = part;
  }
  return copyObservation(data);
}

function transition(previous, current, seen) {
  check(!seen.E && !seen[current.kind]);
  if (previous) {
    check(current.launcherPid === previous.launcherPid && (!previous.attempted || current.attempted));
    for (const key of ["childPid", "exitCode", "signal", "cause", "cleanupError"]) {
      if (previous[key] !== null) check(current[key] === previous[key]);
    }
    if (previous.atNs !== null) check(current.atNs !== null && BigInt(current.atNs) >= BigInt(previous.atNs));
    for (let i = 0; i < 2; i++) {
      const allowed = { n: "nopcu", o: "opcu", p: "pcu", c: "c", u: "u" };
      check(allowed[previous.fds[i]].includes(current.fds[i]));
    }
  }
  if (current.kind === "F") check(!seen.F);
  else check(current.cause === (previous?.cause ?? null));
  if (current.kind === "R") check(!previous);
  if (current.kind === "S") check(seen.R && !seen.X && (!seen.F || seen.F.attempted));
  if (current.kind === "X") check(seen.R && (!seen.F || seen.F.attempted));
  if (current.attempted) check(seen.R);
  if (current.kind === "E") {
    check(current.attempted ? !!seen.X : !seen.S && !seen.X);
    if (current.cause === null) check(seen.R && seen.S && seen.X && current.exitCode === 0 && current.fds === "cc"
      && current.cleanupError === null);
  }
}

/** One fixed line buffer and five fixed observation slots; no retained transcript. */
export function createLaunchControlDecoder(expected) {
  check(acquisitionFields(expected, ["operationId", "profileSha256"])
    && isAcquisitionToken(expected.operationId) && isAcquisitionHash(expected.profileSha256));
  return new LaunchControlDecoder(expected.operationId, expected.profileSha256);
}

class LaunchControlDecoder {
  constructor(operationId, profileSha256) {
    this.operationId = operationId;
    this.profileSha256 = profileSha256;
    this.line = Buffer.alloc(LAUNCH_CONTROL_LIMITS.line);
    this.length = 0;
    this.total = 0;
    this.peak = 0;
    this.seen = { R: null, S: null, X: null, F: null, E: null };
    this.previous = null;
    this.failed = false;
    this.finished = false;
  }
  push(bytes) {
    try {
      check(!this.failed && !this.finished && Buffer.isBuffer(bytes));
      requireAcquisition(this.total + bytes.length <= LAUNCH_CONTROL_LIMITS.total, "LAUNCH_CONTROL_LIMIT");
      this.total += bytes.length;
      for (const byte of bytes) {
        requireAcquisition(this.length < LAUNCH_CONTROL_LIMITS.line, "LAUNCH_CONTROL_LIMIT");
        this.line[this.length++] = byte;
        this.peak = Math.max(this.peak, this.length);
        if (byte === 10) {
          const record = parseLine(this.line.subarray(0, this.length));
          check(record.operationId === this.operationId && record.profileSha256 === this.profileSha256);
          transition(this.previous, record, this.seen);
          this.seen[record.kind] = record;
          this.previous = record;
          this.length = 0;
        }
      }
    } catch (error) { this.failed = true; throw error; }
  }
  finish() {
    try { check(!this.failed && this.length === 0 && this.seen.E !== null); this.finished = true; }
    catch (error) { this.failed = true; throw error; }
    return this.snapshot();
  }
  snapshot() {
    return Object.freeze({ totalBytes: this.total, retainedBytes: this.length, peakRetainedBytes: this.peak,
      failed: this.failed, finished: this.finished, observations: Object.freeze({ ...this.seen }) });
  }
}
