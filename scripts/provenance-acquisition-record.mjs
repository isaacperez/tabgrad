import { createHash } from "node:crypto";

/** Internal experimental JSONL profile. All byte limits include the final LF. */
export const ACQUISITION_LIMITS = Object.freeze({
  header: 32 * 1024, progress: 960 * 1024, supervisor: 16 * 1024, watchdog: 16 * 1024,
});
export const ACQUISITION_EVENT_LIMIT = 1024;
const uintMax = (1n << 64n) - 1n;
const phases = "setup acquire observe validate freeze close";
const closure = "confirmed unconfirmed unknown";
const verdict = "passed failed unknown";
const kinds = {
  transition: "begun completed failed", gate: "permitted denied unknown",
  identity: "observed mismatch unavailable", capture: "confirmed complete lost limit",
  resource: "sample limit unavailable", deadline: "checked expired shortened unavailable",
  validation: "passed failed unknown", containment: "requested observed unconfirmed",
  liveness: "observed planned_end lost unknown", custody: "checked failed unknown",
};

/** Diagnostics contain a closed code only, never input, paths, or native errors. */
export class AcquisitionRecordError extends Error {
  constructor(code) {
    super(code);
    this.name = "AcquisitionRecordError";
    this.code = code;
  }
}

export function requireAcquisition(condition, code = "INVALID_RECORD") {
  if (!condition) throw new AcquisitionRecordError(code);
}

/** Closed ordinary-data shape; do not invoke accessors while admitting inputs. */
export function acquisitionFields(value, keys) {
  if (value === null || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).length === keys.length && keys.every(key => descriptors[key]
    && Object.hasOwn(descriptors[key], "value") && descriptors[key].enumerable);
}

export function acquisitionSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const enumeration = values => value => values.split(" ").includes(value);
const literal = expected => value => value === expected;
const nullable = validator => value => value === null || validator(value);
const hash = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const token = value => typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
const uint = value => typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value)
  && BigInt(value) <= uintMax;
// The control protocol uses the same scalar domain without another wire codec.
export { hash as isAcquisitionHash, token as isAcquisitionToken, uint as isAcquisitionUint };
const utc = value => typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export { utc as isAcquisitionUtc };
const commonEnd = {
  operationId: token, headerSha256: nullable(hash), atNs: uint, observedUtc: utc,
  phaseReached: enumeration(phases),
  stopCode: enumeration("normal preflight client capture validation resource storage deadline observer controller lifecycle custody protocol unknown"),
  firstStopAtNs: nullable(uint), observationEvidenceSha256: nullable(hash),
};
const schemas = {
  header: {
    recordType: literal("acq_header_v1"), operationId: token, state: literal("pending"),
    authorizationRef: token, profileSha256: hash, recipeSha256: hash,
    inputEvidenceSha256: hash, toolEvidenceSha256: hash,
    priorStateMode: enumeration("initial continuation"), priorStateSha256: nullable(hash),
    declaredLimitsSha256: hash, t0MonotonicNs: uint, startedUtc: utc,
    clockEvidenceSha256: hash, deadlineUtc: utc,
  },
  progress: {
    recordType: literal("acq_event_v1"), operationId: token, sequence: uint, atNs: uint,
    phase: enumeration(phases), kind: enumeration(Object.keys(kinds).join(" ")),
    subject: enumeration("operation client validator group network storage stdout stderr supervisor watchdog custody"),
    code: enumeration([...new Set(Object.values(kinds).join(" ").split(" "))].join(" ")),
    reference: nullable(hash), value: nullable(uint),
  },
  supervisor: {
    recordType: literal("acq_supervisor_end_v1"), ...commonEnd,
    clientState: enumeration("not_started running exited unknown"),
    clientExitCode: nullable(uint), clientSignal: nullable(uint),
    stdoutState: enumeration("complete incomplete unknown"), stdoutReceivedBytes: nullable(uint),
    stdoutConfirmedBytes: nullable(uint), stdoutSha256: nullable(hash),
    stderrState: enumeration("complete incomplete unknown"), stderrReceivedBytes: nullable(uint),
    stderrConfirmedBytes: nullable(uint), stderrSha256: nullable(hash),
    progressState: enumeration("complete incomplete limit unknown"),
    progressConfirmedBytes: nullable(uint), progressSha256: nullable(hash),
    preflightState: enumeration(verdict), preflightEvidenceSha256: nullable(hash),
    validationState: enumeration("not_run passed failed unknown"), validationEvidenceSha256: nullable(hash),
    inputWritersState: enumeration(closure), lifecycleState: enumeration(closure),
    caseClosureState: enumeration(closure), helperClosureState: enumeration(closure),
    guardsState: enumeration(verdict), guardsEvidenceSha256: nullable(hash),
    resultEvidenceSha256: nullable(hash), applicableExpiryUtc: nullable(utc),
    payloadCustodyState: enumeration("checked failed unknown"), payloadCustodyEvidenceSha256: nullable(hash),
  },
  watchdog: {
    recordType: literal("acq_watchdog_end_v1"), ...commonEnd,
    peerState: enumeration("alive planned_end lost unknown"), peerObservedAtNs: nullable(uint),
    containmentState: enumeration("not_needed requested observed unconfirmed"), containmentAtNs: nullable(uint),
    caseEmptyState: enumeration(closure), lifecycleState: enumeration(closure),
    helperClosureState: enumeration(closure),
  },
};

function relationships(role, record) {
  if (role === "header") {
    requireAcquisition((record.priorStateMode === "initial") === (record.priorStateSha256 === null));
  } else if (role === "progress") {
    requireAcquisition(record.sequence !== "0" && kinds[record.kind].split(" ").includes(record.code));
    if (["permitted", "passed", "checked"].includes(record.code)) requireAcquisition(record.reference !== null);
  } else {
    if (["normal", "unknown"].includes(record.stopCode)) requireAcquisition(record.firstStopAtNs === null);
    if (record.firstStopAtNs !== null) requireAcquisition(BigInt(record.firstStopAtNs) <= BigInt(record.atNs));
    if (role === "supervisor") {
      if (["not_started", "running"].includes(record.clientState)) {
        requireAcquisition(record.clientExitCode === null && record.clientSignal === null);
      }
      for (const channel of ["stdout", "stderr"]) {
        const received = record[`${channel}ReceivedBytes`];
        const confirmed = record[`${channel}ConfirmedBytes`];
        if (received !== null && confirmed !== null) requireAcquisition(BigInt(confirmed) <= BigInt(received));
        if (record[`${channel}Sha256`] !== null) requireAcquisition(confirmed !== null);
        if (record[`${channel}State`] === "complete") {
          requireAcquisition(received !== null && received === confirmed && record[`${channel}Sha256`] !== null);
        }
      }
      if (record.progressSha256 !== null) requireAcquisition(record.progressConfirmedBytes !== null);
      if (record.progressState === "complete") {
        requireAcquisition(record.progressConfirmedBytes !== null && record.progressSha256 !== null);
      }
      for (const [state, evidence, positive] of [
        ["preflightState", "preflightEvidenceSha256", "passed"],
        ["validationState", "validationEvidenceSha256", "passed"],
        ["guardsState", "guardsEvidenceSha256", "passed"],
        ["payloadCustodyState", "payloadCustodyEvidenceSha256", "checked"],
      ]) if (record[state] === positive) requireAcquisition(record[evidence] !== null);
    } else {
      for (const name of ["peerObservedAtNs", "containmentAtNs"]) {
        if (record[name] !== null) requireAcquisition(BigInt(record[name]) <= BigInt(record.atNs));
      }
      if (record.containmentState === "not_needed") requireAcquisition(record.containmentAtNs === null);
    }
  }
}

/** Validates a plain own-data object; getters, symbols and extensions are rejected. */
function validate(role, record) {
  requireAcquisition(Object.hasOwn(schemas, role));
  const schema = schemas[role];
  requireAcquisition(schema && record !== null && typeof record === "object" && !Array.isArray(record));
  requireAcquisition([Object.prototype, null].includes(Object.getPrototypeOf(record)));
  const descriptors = Object.getOwnPropertyDescriptors(record);
  requireAcquisition(Reflect.ownKeys(record).length === Object.keys(schema).length);
  for (const [name, validator] of Object.entries(schema)) {
    const descriptor = descriptors[name];
    requireAcquisition(descriptor && Object.hasOwn(descriptor, "value") && descriptor.enumerable);
    requireAcquisition(validator(descriptor.value));
  }
  relationships(role, record);
  return record;
}

/** Encode one record, preserving the caller's key order. Never hashes a re-encoding. */
export function encodeAcquisitionRecord(role, record) {
  validate(role, record);
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "ascii");
  requireAcquisition(bytes.length <= (role === "progress" ? ACQUISITION_EVENT_LIMIT : ACQUISITION_LIMITS[role]), "PART_LIMIT");
  return bytes;
}

/** Parse a bounded compact ASCII object directly, so duplicate keys cannot disappear. */
export function decodeAcquisitionRecord(role, bytes) {
  requireAcquisition(Buffer.isBuffer(bytes) && Object.hasOwn(schemas, role), "INVALID_RECORD");
  requireAcquisition(bytes.length <= (role === "progress" ? ACQUISITION_EVENT_LIMIT : ACQUISITION_LIMITS[role]), "PART_LIMIT");
  const text = bytes.toString("latin1");
  requireAcquisition(text.startsWith("{") && text.endsWith("}\n"));
  const record = Object.create(null);
  const pair = /"([\x20-\x21\x23-\x5b\x5d-\x7e]{1,32})":(?:"([\x20-\x21\x23-\x5b\x5d-\x7e]{0,64})"|(null))/y;
  let offset = 1;
  while (offset < text.length - 2) {
    pair.lastIndex = offset;
    const match = pair.exec(text);
    requireAcquisition(match && !Object.hasOwn(record, match[1]));
    record[match[1]] = match[3] === "null" ? null : match[2];
    offset = pair.lastIndex;
    if (text[offset] === ",") { offset += 1; requireAcquisition(text[offset] === '"'); }
    else requireAcquisition(offset === text.length - 2);
  }
  requireAcquisition(offset === text.length - 2);
  return validate(role, record);
}

/**
 * Inspect confirmed prefixes supplied by an owner. {bytes: Buffer, state:
 * pending|complete|incomplete|limit|unknown, uncertain: boolean} per role.
 * Missing/partial parts remain diagnostic. Throws closed format/association errors.
 * formatComplete describes representation only; it never admits observations.
 */
export function inspectAcquisitionRecord(parts) {
  const records = {};
  let formatComplete = true;
  for (const role of Object.keys(ACQUISITION_LIMITS)) {
    const part = parts[role];
    if (!part) { records[role] = []; formatComplete = false; continue; }
    requireAcquisition(Buffer.isBuffer(part.bytes) && part.bytes.length <= ACQUISITION_LIMITS[role], "PART_LIMIT");
    requireAcquisition(["pending", "complete", "incomplete", "limit", "unknown"].includes(part.state)
      && typeof part.uncertain === "boolean");
    const complete = part.state === "complete" && !part.uncertain;
    formatComplete &&= complete;
    const lines = [];
    let start = 0;
    for (let end = part.bytes.indexOf(10); end !== -1; end = part.bytes.indexOf(10, start)) {
      lines.push(decodeAcquisitionRecord(role, part.bytes.subarray(start, end + 1)));
      start = end + 1;
    }
    if (complete) requireAcquisition(start === part.bytes.length && (role === "progress" || lines.length === 1));
    else formatComplete = false;
    if (role !== "progress") requireAcquisition(lines.length <= 1);
    records[role] = lines;
  }
  const header = records.header[0];
  const all = Object.values(records).flat();
  if (all.length) requireAcquisition(all.every(record => record.operationId === all[0].operationId), "OPERATION_MISMATCH");
  let sequence = 1n;
  let at = 0n;
  for (const event of records.progress) {
    requireAcquisition(BigInt(event.sequence) === sequence++ && BigInt(event.atNs) >= at, "EVENT_ORDER");
    at = BigInt(event.atNs);
  }
  const headerKnown = header && parts.header.state === "complete" && !parts.header.uncertain;
  for (const end of [...records.supervisor, ...records.watchdog]) {
    if (headerKnown) requireAcquisition(end.headerSha256 === acquisitionSha256(parts.header.bytes), "HEADER_MISMATCH");
    if (end.headerSha256 === null) formatComplete = false;
  }
  const supervisor = records.supervisor[0];
  if (supervisor && parts.progress?.state === "complete" && !parts.progress.uncertain) {
    if (supervisor.progressConfirmedBytes !== null) {
      requireAcquisition(BigInt(supervisor.progressConfirmedBytes) === BigInt(parts.progress.bytes.length), "PROGRESS_MISMATCH");
    }
    if (supervisor.progressSha256 !== null) {
      requireAcquisition(supervisor.progressSha256 === acquisitionSha256(parts.progress.bytes), "PROGRESS_MISMATCH");
    }
  }
  if (supervisor?.progressState !== "complete") formatComplete = false;
  return { formatComplete, records };
}
