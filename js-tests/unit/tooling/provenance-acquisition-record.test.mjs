import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACQUISITION_EVENT_LIMIT, ACQUISITION_LIMITS, AcquisitionRecordError,
  acquisitionSha256, decodeAcquisitionRecord, encodeAcquisitionRecord, inspectAcquisitionRecord,
} from "../../../scripts/provenance-acquisition-record.mjs";

const hash = "a".repeat(64);
const operationId = "1".repeat(32);
const time = "2026-01-02T03:04:05.006Z";
const header = () => ({ recordType: "acq_header_v1", operationId, state: "pending",
  authorizationRef: "2".repeat(32), profileSha256: hash, recipeSha256: "b".repeat(64),
  inputEvidenceSha256: "c".repeat(64), toolEvidenceSha256: "d".repeat(64),
  priorStateMode: "initial", priorStateSha256: null, declaredLimitsSha256: "e".repeat(64),
  t0MonotonicNs: "18446744073709551615", startedUtc: time,
  clockEvidenceSha256: "f".repeat(64), deadlineUtc: time });
const event = () => ({ recordType: "acq_event_v1", operationId, sequence: "1", atNs: "0",
  phase: "setup", kind: "gate", subject: "operation", code: "permitted", reference: hash, value: null });
const common = () => ({ operationId, headerSha256: acquisitionSha256(encodeAcquisitionRecord("header", header())),
  atNs: "2", observedUtc: time, phaseReached: "close", stopCode: "normal", firstStopAtNs: null,
  observationEvidenceSha256: hash });
const watchdog = () => ({ recordType: "acq_watchdog_end_v1", ...common(),
  peerState: "planned_end", peerObservedAtNs: "1", containmentState: "not_needed", containmentAtNs: null,
  caseEmptyState: "confirmed", lifecycleState: "confirmed", helperClosureState: "confirmed" });
const supervisor = () => ({ recordType: "acq_supervisor_end_v1", ...common(),
  clientState: "exited", clientExitCode: "0", clientSignal: null,
  stdoutState: "complete", stdoutReceivedBytes: "0", stdoutConfirmedBytes: "0", stdoutSha256: acquisitionSha256(Buffer.alloc(0)),
  stderrState: "incomplete", stderrReceivedBytes: "9007199254740993", stderrConfirmedBytes: "1", stderrSha256: hash,
  progressState: "complete", progressConfirmedBytes: String(encodeAcquisitionRecord("progress", event()).length),
  progressSha256: acquisitionSha256(encodeAcquisitionRecord("progress", event())),
  preflightState: "passed", preflightEvidenceSha256: hash, validationState: "passed", validationEvidenceSha256: hash,
  inputWritersState: "confirmed", lifecycleState: "confirmed", caseClosureState: "confirmed", helperClosureState: "confirmed",
  guardsState: "passed", guardsEvidenceSha256: hash, resultEvidenceSha256: hash, applicableExpiryUtc: time,
  payloadCustodyState: "checked", payloadCustodyEvidenceSha256: hash });
const fixtures = { header, progress: event, supervisor, watchdog };
const part = bytes => ({ bytes, state: "complete", uncertain: false });
const parts = () => Object.fromEntries(Object.entries(fixtures).map(([role, make]) => [role, part(encodeAcquisitionRecord(role, make()))]));
const rejects = action => assert.throws(action, error => error instanceof AcquisitionRecordError && error.message === error.code);

test("literal vector preserves original order and exact bytes; neither parser nor hash canonicalizes", () => {
  const literal = Buffer.from('{"value":null,"reference":null,"code":"begun","subject":"client","kind":"transition","phase":"acquire","atNs":"9007199254740993","sequence":"1","operationId":"11111111111111111111111111111111","recordType":"acq_event_v1"}\n');
  const decoded = decodeAcquisitionRecord("progress", literal);
  assert.equal(decoded.atNs, "9007199254740993");
  assert.deepEqual(encodeAcquisitionRecord("progress", decoded), literal);
  // Independently checked using shasum -a 256 on these literal bytes.
  assert.equal(acquisitionSha256(literal), "c2ae0015b5b2a6bc5ea73e3c38c0df58b2b55d327ab2454af2afa094aa19a068");
});

test("all role schemas round trip without inventing observation truth", () => {
  assert.equal(Object.values(ACQUISITION_LIMITS).reduce((sum, n) => sum + n, 0), 1048576);
  for (const [role, make] of Object.entries(fixtures)) {
    const record = make();
    const decoded = decodeAcquisitionRecord(role, encodeAcquisitionRecord(role, record));
    assert.deepEqual({ ...decoded }, record);
  }
  // A structurally complete failure or inconsistent normal claim is still not admission.
  const inspected = inspectAcquisitionRecord(parts());
  assert.equal(inspected.formatComplete, true);
  assert.equal(inspected.records.supervisor[0].stderrState, "incomplete");
  assert.equal(Object.hasOwn(inspected, "admitted"), false);
});

test("closed keys, descriptors, role, tokens and references", () => {
  for (const [role, make] of Object.entries(fixtures)) {
    for (const name of Object.keys(make())) {
      const missing = make(); delete missing[name]; rejects(() => encodeAcquisitionRecord(role, missing));
      rejects(() => encodeAcquisitionRecord(role, { ...make(), [name]: undefined }));
    }
    rejects(() => encodeAcquisitionRecord(role, { ...make(), extra: null }));
    rejects(() => decodeAcquisitionRecord(role, Buffer.from(JSON.stringify({ ...make(), extra: null }) + "\n")));
    const accessor = make();
    let reads = 0;
    Object.defineProperty(accessor, "operationId", { enumerable: true, get() { reads++; return operationId; } });
    rejects(() => encodeAcquisitionRecord(role, accessor));
    assert.equal(reads, 0);
    rejects(() => encodeAcquisitionRecord(role, { ...make(), operationId: "1".repeat(31) }));
  }
  rejects(() => encodeAcquisitionRecord("unknown", header()));
  for (const role of ["toString", "constructor", "__proto__"]) {
    rejects(() => encodeAcquisitionRecord(role, {}));
    rejects(() => decodeAcquisitionRecord(role, Buffer.from("{}\n")));
  }
  rejects(() => encodeAcquisitionRecord("header", { ...header(), profileSha256: "A".repeat(64) }));
  rejects(() => encodeAcquisitionRecord("header", { ...header(), priorStateMode: "continuation" }));
  assert.doesNotThrow(() => encodeAcquisitionRecord("header", { ...header(), priorStateMode: "continuation", priorStateSha256: hash }));
});

test("byte grammar rejects duplicate keys, escapes, non-ASCII, whitespace, nesting, bad LF and tails", () => {
  const original = encodeAcquisitionRecord("progress", event()).toString();
  const invalid = [
    original.replace('{', '{"sequence":"1",'),
    original.replace('"1"', '1'), original.replace('null', 'true'),
    original.replace('null', '[]'), original.replace('null', '{}'),
    original.replace('"setup"', '"set\\u0075p"'), original.replace('"setup"', '"set\\up"'),
    original.replace('"setup"', '"sétup"'), original.replace('"setup"', '"set\tup"'),
    original.replace(':', ': '), original.replace('}', ',}'),
    original.slice(0, -1), original.replace('\n', '\r\n'), original + "\n", original + "x",
  ];
  for (const text of invalid) rejects(() => decodeAcquisitionRecord("progress", Buffer.from(text)));
  for (const length of [0, 1, original.length - 2, original.length - 1]) {
    rejects(() => decodeAcquisitionRecord("progress", Buffer.from(original.slice(0, length))));
  }
  rejects(() => decodeAcquisitionRecord("progress", Buffer.alloc(ACQUISITION_EVENT_LIMIT + 1)));
  rejects(() => decodeAcquisitionRecord("header", Buffer.alloc(ACQUISITION_LIMITS.header + 1)));
});

test("uint64, null versus zero, independent payload size and calendar boundaries", () => {
  for (const value of ["0", "1", "9007199254740993", "18446744073709551615"]) {
    assert.equal(decodeAcquisitionRecord("progress", encodeAcquisitionRecord("progress", { ...event(), value })).value, value);
  }
  for (const value of [0, false, "", "00", "01", "-1", "1.0", "1e2", "18446744073709551616", "9".repeat(65)]) {
    rejects(() => encodeAcquisitionRecord("progress", { ...event(), value }));
  }
  assert.equal(decodeAcquisitionRecord("progress", encodeAcquisitionRecord("progress", event())).value, null);
  for (const valid of ["2000-02-29T00:00:00.000Z", "0000-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z"]) {
    assert.doesNotThrow(() => encodeAcquisitionRecord("header", { ...header(), startedUtc: valid }));
  }
  for (const invalid of ["1900-02-29T00:00:00.000Z", "2026-02-30T00:00:00.000Z", "2026-01-01T24:00:00.000Z", "2026-01-01T00:00:00Z"]) {
    rejects(() => encodeAcquisitionRecord("header", { ...header(), startedUtc: invalid }));
  }
});

test("reachable maximum-width records stay within each closed role's byte budget", () => {
  const max = "18446744073709551615";
  const maximumHeader = { ...header(), priorStateMode: "continuation", priorStateSha256: hash };
  const maximumEvent = { ...event(), sequence: max, atNs: max, phase: "validate", kind: "containment",
    subject: "supervisor", code: "unconfirmed", reference: hash, value: max };
  const maximumCommon = { atNs: max, phaseReached: "validate", stopCode: "validation", firstStopAtNs: max };
  const maximumSupervisor = { ...supervisor(), ...maximumCommon, clientState: "unknown", clientExitCode: max, clientSignal: max,
    stdoutState: "incomplete", stdoutReceivedBytes: max, stdoutConfirmedBytes: max,
    stderrState: "incomplete", stderrReceivedBytes: max, stderrConfirmedBytes: max,
    progressState: "incomplete", progressConfirmedBytes: max,
    preflightState: "unknown", validationState: "not_run", guardsState: "unknown", payloadCustodyState: "unknown",
    inputWritersState: "unconfirmed", lifecycleState: "unconfirmed", caseClosureState: "unconfirmed", helperClosureState: "unconfirmed" };
  const maximumWatchdog = { ...watchdog(), ...maximumCommon, peerObservedAtNs: max,
    containmentState: "unconfirmed", containmentAtNs: max,
    caseEmptyState: "unconfirmed", lifecycleState: "unconfirmed", helperClosureState: "unconfirmed" };
  for (const [role, record] of Object.entries({ header: maximumHeader, progress: maximumEvent,
    supervisor: maximumSupervisor, watchdog: maximumWatchdog })) {
    // Each chosen scalar has its maximum allowed width for these closed fields/relationships.
    // Count the JSON framing independently; no forbidden padding fields are introduced.
    const expected = 3 + Object.entries(record).reduce((sum, [key, value], index) => sum
      + key.length + 3 + (value === null ? 4 : value.length + 2) + Number(index > 0), 0);
    const encoded = encodeAcquisitionRecord(role, record);
    assert.equal(encoded.length, expected);
    assert.ok(encoded.length < (role === "progress" ? ACQUISITION_EVENT_LIMIT : ACQUISITION_LIMITS[role]));
    assert.deepEqual({ ...decodeAcquisitionRecord(role, encoded) }, record);
  }
});

test("kind/code, evidence, capture and closure relationships preserve diagnostic unknowns", () => {
  rejects(() => encodeAcquisitionRecord("progress", { ...event(), code: "passed" }));
  rejects(() => encodeAcquisitionRecord("progress", { ...event(), reference: null }));
  assert.doesNotThrow(() => encodeAcquisitionRecord("progress", { ...event(), code: "unknown", reference: null }));
  rejects(() => encodeAcquisitionRecord("supervisor", { ...supervisor(), clientState: "running" }));
  rejects(() => encodeAcquisitionRecord("supervisor", { ...supervisor(), stdoutConfirmedBytes: null }));
  rejects(() => encodeAcquisitionRecord("supervisor", { ...supervisor(), stderrConfirmedBytes: "9007199254740994" }));
  rejects(() => encodeAcquisitionRecord("supervisor", { ...supervisor(), preflightEvidenceSha256: null }));
  rejects(() => encodeAcquisitionRecord("watchdog", { ...watchdog(), firstStopAtNs: "1" }));
  rejects(() => encodeAcquisitionRecord("watchdog", { ...watchdog(), peerObservedAtNs: "3" }));
  rejects(() => encodeAcquisitionRecord("watchdog", { ...watchdog(), containmentAtNs: "1" }));
  assert.doesNotThrow(() => encodeAcquisitionRecord("watchdog", { ...watchdog(), stopCode: "controller", firstStopAtNs: null,
    peerState: "lost", containmentState: "unconfirmed", containmentAtNs: null }));
});

test("association detects mixed operation, header, sequence and a prefix masquerading as complete", () => {
  const change = (role, record) => { const value = parts(); value[role] = part(encodeAcquisitionRecord(role, record)); return value; };
  rejects(() => inspectAcquisitionRecord(change("watchdog", { ...watchdog(), operationId: "3".repeat(32) })));
  rejects(() => inspectAcquisitionRecord(change("watchdog", { ...watchdog(), headerSha256: hash })));
  rejects(() => inspectAcquisitionRecord(change("progress", { ...event(), sequence: "2" })));
  rejects(() => inspectAcquisitionRecord(change("supervisor", { ...supervisor(), progressConfirmedBytes: "0" })));
  rejects(() => inspectAcquisitionRecord(change("supervisor", { ...supervisor(), progressSha256: hash })));
  const unavailable = parts();
  unavailable.progress = { bytes: Buffer.alloc(0), state: "unknown", uncertain: true,
    confirmedBytes: 256, readBytes: 0, readError: "READ_FAILED" };
  assert.equal(inspectAcquisitionRecord(unavailable).formatComplete, false);
  assert.equal(inspectAcquisitionRecord(unavailable).records.supervisor.length, 1);
  const duplicate = parts(); duplicate.header.bytes = Buffer.concat([duplicate.header.bytes, duplicate.header.bytes]);
  rejects(() => inspectAcquisitionRecord(duplicate));
  const partial = parts(); partial.watchdog.state = "unknown"; partial.watchdog.uncertain = true;
  assert.equal(inspectAcquisitionRecord(partial).formatComplete, false);
  assert.equal(inspectAcquisitionRecord(partial).records.watchdog.length, 1);
  delete partial.watchdog;
  assert.equal(inspectAcquisitionRecord(partial).formatComplete, false);
  const beforeHeader = change("watchdog", { ...watchdog(), headerSha256: null, stopCode: "preflight" });
  delete beforeHeader.header;
  assert.equal(inspectAcquisitionRecord(beforeHeader).formatComplete, false);
});

test("unconfirmed trailing bytes remain diagnostic without manufacturing a complete line", () => {
  const value = parts();
  value.watchdog.bytes = value.watchdog.bytes.subarray(0, -1);
  value.watchdog.state = "incomplete";
  assert.equal(inspectAcquisitionRecord(value).records.watchdog.length, 0);
  value.watchdog.state = "complete";
  rejects(() => inspectAcquisitionRecord(value));
});
