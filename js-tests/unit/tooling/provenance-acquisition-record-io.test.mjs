import assert from "node:assert/strict";
import { mkdtemp, open, stat, readFile, rm, link, symlink, rename, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ACQUISITION_LIMITS, acquisitionSha256, encodeAcquisitionRecord, inspectAcquisitionRecord } from "../../../scripts/provenance-acquisition-record.mjs";
import { acquisitionFileIdentity, openAcquisitionRecord, readAcquisitionPart } from "../../../scripts/provenance-acquisition-record-io.mjs";

const operationId = "1".repeat(32);
const hash = "a".repeat(64);
const utc = "2026-01-02T03:04:05.006Z";
const header = () => ({ recordType: "acq_header_v1", operationId, state: "pending", authorizationRef: "2".repeat(32),
  profileSha256: hash, recipeSha256: hash, inputEvidenceSha256: hash, toolEvidenceSha256: hash,
  priorStateMode: "initial", priorStateSha256: null, declaredLimitsSha256: hash,
  t0MonotonicNs: "0", startedUtc: utc, clockEvidenceSha256: hash, deadlineUtc: utc });
const event = (sequence = 1, payload = false) => ({ recordType: "acq_event_v1", operationId,
  sequence: String(sequence), atNs: String(sequence), phase: "acquire", kind: "resource", subject: "storage",
  code: "sample", reference: payload ? hash : null, value: payload ? "18446744073709551615" : null });
const end = (role, headerHash, progress) => ({ recordType: `acq_${role}_end_v1`, operationId, headerSha256: headerHash,
  atNs: "18446744073709551615", observedUtc: utc, phaseReached: "close", stopCode: "storage", firstStopAtNs: "2",
  observationEvidenceSha256: hash, ...(role === "watchdog" ? {
    peerState: "lost", peerObservedAtNs: "1", containmentState: "observed", containmentAtNs: "2",
    caseEmptyState: "confirmed", lifecycleState: "confirmed", helperClosureState: "confirmed",
  } : {
    clientState: "unknown", clientExitCode: null, clientSignal: null,
    stdoutState: "unknown", stdoutReceivedBytes: null, stdoutConfirmedBytes: null, stdoutSha256: null,
    stderrState: "unknown", stderrReceivedBytes: null, stderrConfirmedBytes: null, stderrSha256: null,
    progressState: progress.state === "pending" ? "incomplete" : progress.state,
    progressConfirmedBytes: String(progress.confirmedBytes), progressSha256: progress.sha256,
    preflightState: "unknown", preflightEvidenceSha256: null, validationState: "not_run", validationEvidenceSha256: null,
    inputWritersState: "unknown", lifecycleState: "unknown", caseClosureState: "unknown", helperClosureState: "unknown",
    guardsState: "unknown", guardsEvidenceSha256: null, resultEvidenceSha256: null, applicableExpiryUtc: null,
    payloadCustodyState: "unknown", payloadCustodyEvidenceSha256: null,
  }) });
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code && error.message === code);

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tabgrad-acq-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destinations = {};
  for (const [role, capacity] of Object.entries(ACQUISITION_LIMITS)) {
    const name = `${role}.record`;
    const handle = await open(join(root, name), "wx+", 0o600);
    // Logical reservation only; truncate does not demonstrate physical allocation.
    await handle.truncate(capacity);
    destinations[role] = { name, identity: acquisitionFileIdentity(await handle.stat({ bigint: true })) };
    await handle.close();
  }
  return { root, destinations };
}
const nativeWrite = (handle, bytes, offset, length, position) => handle.write(bytes, offset, length, position);
const nativeRead = (handle, bytes, offset, length, position) => handle.read(bytes, offset, length, position);
async function readParts(config, snapshots) {
  const parts = {};
  for (const role of Object.keys(ACQUISITION_LIMITS)) {
    parts[role] = await readAcquisitionPart({ ...config, role, destination: config.destinations[role], range: snapshots[role] });
  }
  return parts;
}

test("useful actual-file round trip with independent reserves and exact digests", async t => {
  const config = await fixture(t);
  const record = await openAcquisitionRecord(config);
  const h = await record.writers.header.write(header());
  await record.writers.progress.write(event());
  await record.writers.progress.write(event(2, true));
  const p = record.writers.progress.finish();
  await record.writers.supervisor.write(end("supervisor", h.sha256, p));
  await record.writers.watchdog.write(end("watchdog", h.sha256, p));
  const snapshots = await record.close();
  const parts = await readParts(config, snapshots);
  assert.equal(inspectAcquisitionRecord(parts).formatComplete, true);
  assert.deepEqual(parts.header.bytes, encodeAcquisitionRecord("header", header()));
  for (const role of Object.keys(parts)) {
    assert.equal(acquisitionSha256(parts[role].bytes), snapshots[role].sha256);
    assert.equal((await stat(join(config.root, config.destinations[role].name))).size, ACQUISITION_LIMITS[role]);
  }
});

test("short writes advance only by confirmed bytes; counts vary independently of payload and event count", async t => {
  for (const count of [1, 17]) for (const payload of [false, true]) {
    const config = await fixture(t);
    let transferred = 0;
    let calls = 0;
    const positions = [];
    const record = await openAcquisitionRecord({ ...config, transfer: { async write(handle, bytes, offset, length, position) {
      positions.push(position); calls++;
      assert.equal(position, transferred);
      const result = await nativeWrite(handle, bytes, offset, Math.min(37, length), position);
      transferred += result.bytesWritten;
      return result;
    } } });
    let expectedLength = 0;
    for (let n = 1; n <= count; n++) {
      expectedLength += encodeAcquisitionRecord("progress", event(n, payload)).length;
      await record.writers.progress.write(event(n, payload));
    }
    const p = record.writers.progress.finish();
    assert.equal(transferred, expectedLength);
    assert.equal(p.confirmedBytes, expectedLength);
    assert.equal(calls, positions.length);
    const snapshots = await record.close();
    let readBytes = 0;
    const read = await readAcquisitionPart({ ...config, role: "progress", destination: config.destinations.progress,
      range: snapshots.progress, transfer: { async read(handle, bytes, offset, length, position) {
        assert.equal(position, readBytes);
        assert.equal(bytes.length, expectedLength);
        const result = await nativeRead(handle, bytes, offset, Math.min(41, length), position);
        readBytes += result.bytesRead;
        return result;
      } } });
    assert.equal(readBytes, expectedLength);
    assert.equal(acquisitionSha256(read.bytes), p.sha256);
  }
});

test("zero, thrown and unknown-extent writes stop every role and preserve confirmed prefixes", async t => {
  for (const role of Object.keys(ACQUISITION_LIMITS)) {
    for (const mode of ["zero", "throw-before", "throw-after", "unknown", "valid-json-then-throw"]) {
      const config = await fixture(t);
      let calls = 0;
      const handles = [];
      const record = await openAcquisitionRecord({ ...config, transfer: { async write(handle, bytes, offset, length, position) {
        handles.push(handle); calls++;
        if (mode === "throw-before") throw Error("private native detail");
        if (mode === "valid-json-then-throw") {
          await nativeWrite(handle, bytes, offset, length, position);
          throw Error("unconfirmed completion");
        }
        if (calls === 1) return nativeWrite(handle, bytes, offset, 7, position);
        if (mode === "zero") return { bytesWritten: 0 };
        if (mode === "throw-after") { await nativeWrite(handle, bytes, offset, 3, position); throw Error("native"); }
        return { bytesWritten: undefined };
      } } });
      const data = role === "header" ? header() : role === "progress" ? event() : end(role, null, record.writers.progress.snapshot());
      const expectedCode = mode === "zero" ? "WRITE_NO_PROGRESS" : mode === "unknown" ? "WRITE_EXTENT_UNKNOWN" : "WRITE_FAILED";
      await rejects(record.writers[role].write(data), expectedCode);
      const snapshot = record.writers[role].snapshot();
      assert.equal(snapshot.firstError, expectedCode);
      assert.equal(snapshot.confirmedBytes, ["throw-before", "valid-json-then-throw"].includes(mode) ? 0 : 7);
      assert.equal(snapshot.uncertain, mode !== "zero");
      await rejects(record.writers[role].write(data), "WRITER_STOPPED");
      const before = calls;
      const snapshots = await record.close();
      assert.equal(calls, before);
      for (const handle of handles) assert.equal(handle.fd, -1);
      const disk = await readFile(join(config.root, config.destinations[role].name));
      assert.deepEqual(disk.subarray(0, snapshot.confirmedBytes), encodeAcquisitionRecord(role, data).subarray(0, snapshot.confirmedBytes));
      const read = await readAcquisitionPart({ ...config, role, destination: config.destinations[role], range: snapshots[role] });
      assert.equal(read.state, "incomplete");
      assert.equal(read.bytes.length, snapshot.confirmedBytes);
      if (mode === "valid-json-then-throw") assert.equal(disk.subarray(0, encodeAcquisitionRecord(role, data).length).at(-1), 10);
      for (const other of Object.keys(ACQUISITION_LIMITS).filter(name => name !== role)) {
        assert.equal((await readFile(join(config.root, config.destinations[other].name))).some(byte => byte !== 0), false);
      }
    }
  }
});

test("first valid event that does not fit stops progress while both closures remain writable", async t => {
  const config = await fixture(t);
  const record = await openAcquisitionRecord(config);
  const h = await record.writers.header.write(header());
  let sequence = 1;
  let length = 0;
  while (length + encodeAcquisitionRecord("progress", event(sequence, true)).length <= ACQUISITION_LIMITS.progress) {
    const data = event(sequence++, true);
    length += encodeAcquisitionRecord("progress", data).length;
    await record.writers.progress.write(data);
  }
  const prefixHash = record.writers.progress.snapshot().sha256;
  await rejects(record.writers.progress.write(event(sequence, true)), "PART_LIMIT");
  const p = record.writers.progress.snapshot();
  assert.equal(p.confirmedBytes, length);
  assert.equal(p.sha256, prefixHash);
  assert.equal(p.state, "limit");
  await rejects(record.writers.progress.write(event(sequence)), "WRITER_STOPPED");
  await record.writers.supervisor.write(end("supervisor", h.sha256, p));
  await record.writers.watchdog.write(end("watchdog", h.sha256, p));
  const parts = await readParts(config, await record.close());
  assert.equal(inspectAcquisitionRecord(parts).formatComplete, false);
  assert.equal(inspectAcquisitionRecord(parts).records.progress.length, sequence - 1);
  const disk = await readFile(join(config.root, config.destinations.progress.name));
  assert.equal(disk.subarray(length).every(byte => byte === 0), true);
});

test("close failure stays visible alongside the first write/read error and actual open handle", async t => {
  for (const writeFails of [false, true]) {
    const config = await fixture(t);
    let captured;
    let nativeClose;
    const record = await openAcquisitionRecord({ ...config, transfer: { async write(handle, ...args) {
      captured = handle;
      nativeClose = handle.close.bind(handle);
      handle.close = async () => { throw Error("synthetic close failure"); };
      if (writeFails) throw Error("synthetic first failure");
      return nativeWrite(handle, ...args);
    } } });
    t.after(async () => { if (captured.fd !== -1) await nativeClose(); });
    if (writeFails) await rejects(record.writers.header.write(header()), "WRITE_FAILED");
    else await record.writers.header.write(header());
    const snapshots = await record.close();
    assert.equal(snapshots.header.firstError, writeFails ? "WRITE_FAILED" : "CLOSE_FAILED");
    assert.equal(snapshots.header.closeError, "CLOSE_FAILED");
    assert.equal(snapshots.header.state, "incomplete");
    assert.notEqual(captured.fd, -1);
    assert.deepEqual(await record.close(), snapshots);
    await nativeClose();
    assert.equal(captured.fd, -1);
  }
  for (const readFails of [false, true]) {
    const config = await fixture(t);
    let captured;
    let nativeClose;
    const result = await readAcquisitionPart({ ...config, role: "header", destination: config.destinations.header,
      range: { confirmedBytes: 3, state: "complete", uncertain: false },
      transfer: { async read(handle, ...args) {
        captured = handle;
        nativeClose = handle.close.bind(handle);
        handle.close = async () => { throw Error("synthetic close failure"); };
        if (readFails) throw Error("synthetic first failure");
        return nativeRead(handle, ...args);
      } } });
    t.after(async () => { if (captured.fd !== -1) await nativeClose(); });
    assert.equal(result.readError, readFails ? "READ_FAILED" : "CLOSE_FAILED");
    assert.equal(result.state, "unknown");
    assert.equal(result.uncertain, true);
    assert.deepEqual(result.cleanup, { openedHandles: 1, closedHandles: 0 });
    assert.notEqual(captured.fd, -1);
    await nativeClose();
    assert.equal(captured.fd, -1);
  }
});

test("destination aliases, hardlinks, symlinks, wrong identity and root are rejected before writing", async t => {
  for (const mode of ["same-path", "hardlink", "symlink", "wrong-identity", "nonregular", "traversal", "root-link"]) {
    const config = await fixture(t);
    const original = { ...config.destinations };
    const watchdogPath = join(config.root, config.destinations.watchdog.name);
    if (["hardlink", "symlink"].includes(mode)) {
      await rm(watchdogPath);
      await (mode === "hardlink" ? link : symlink)(join(config.root, config.destinations.supervisor.name), watchdogPath);
      config.destinations.watchdog = { ...config.destinations.watchdog,
        identity: acquisitionFileIdentity(await stat(watchdogPath, { bigint: true })) };
    }
    if (mode === "same-path") config.destinations.watchdog = config.destinations.supervisor;
    if (mode === "wrong-identity") config.destinations.watchdog = { ...config.destinations.watchdog, identity: { dev: "0", ino: "0" } };
    if (mode === "nonregular") { await rm(watchdogPath); await symlink(config.root, watchdogPath); }
    if (mode === "traversal") config.destinations.watchdog = { ...config.destinations.watchdog, name: "../watchdog.record" };
    if (mode === "root-link") { await symlink(config.root, join(config.root, "root-link")); config.root = join(config.root, "root-link"); }
    let writes = 0;
    await assert.rejects(openAcquisitionRecord({ ...config, transfer: { write() { writes++; } } }), error => {
      assert.equal(error.cleanup.closedHandles, error.cleanup.openedHandles);
      assert.equal(error.message, error.code);
      return true;
    });
    assert.equal(writes, 0);
    const actualRoot = await realpath(config.root);
    for (const [role, destination] of Object.entries(original)) {
      if (role !== "watchdog" || !["nonregular"].includes(mode)) {
        assert.equal((await readFile(join(actualRoot, destination.name))).every(byte => byte === 0), true);
      }
    }
  }
});

test("read limits apply before allocation/open, unknown lengths do not scan padding, failures stay partial", async t => {
  const config = await fixture(t);
  let reads = 0;
  const args = { ...config, role: "progress", destination: config.destinations.progress,
    transfer: { async read(...values) { reads++; return nativeRead(...values); } } };
  for (const length of [-1, ACQUISITION_LIMITS.progress + 1, Number.MAX_SAFE_INTEGER, 1.5]) {
    await rejects(readAcquisitionPart({ ...args, root: "/does-not-exist", range: { confirmedBytes: length, state: "complete", uncertain: false } }), "READ_RANGE");
  }
  const unknown = await readAcquisitionPart({ ...args, range: { confirmedBytes: null, state: "unknown", uncertain: true } });
  assert.equal(unknown.bytes.length, 0);
  assert.equal(reads, 0);
  for (const length of [ACQUISITION_LIMITS.progress - 1, ACQUISITION_LIMITS.progress]) {
    const bounded = await readAcquisitionPart({ ...args, range: { confirmedBytes: length, state: "unknown", uncertain: true } });
    assert.equal(bounded.bytes.length, length);
    assert.equal(bounded.state, "unknown");
  }
  for (const [role, capacity] of Object.entries(ACQUISITION_LIMITS)) {
    for (const length of [capacity - 1, capacity]) {
      const bounded = await readAcquisitionPart({ ...config, role, destination: config.destinations[role],
        range: { confirmedBytes: length, state: "unknown", uncertain: true } });
      assert.equal(bounded.bytes.length, length);
      assert.equal(bounded.state, "unknown");
    }
    await rejects(readAcquisitionPart({ root: "/does-not-exist", role, destination: config.destinations[role],
      range: { confirmedBytes: capacity + 1, state: "unknown", uncertain: true } }), "READ_RANGE");
  }
  for (const mode of ["zero", "throw", "invalid"]) {
    let calls = 0;
    const read = await readAcquisitionPart({ ...args, range: { confirmedBytes: 16, state: "complete", uncertain: false },
      transfer: { async read(handle, bytes, offset, length, position) {
        if (++calls === 1) return nativeRead(handle, bytes, offset, 3, position);
        if (mode === "zero") return { bytesRead: 0 };
        if (mode === "throw") throw Error("private");
        return { bytesRead: 99 };
      } } });
    assert.equal(read.readBytes, 3);
    assert.equal(read.state, "unknown");
    assert.equal(read.uncertain, true);
  }
});

test("writers reject concurrent use, mutation cannot change committed sequence, replacement cannot redirect reads", async t => {
  const config = await fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const record = await openAcquisitionRecord({ ...config, transfer: { async write(...args) { await gate; return nativeWrite(...args); } } });
  const first = event();
  const pending = record.writers.progress.write(first);
  first.operationId = "9".repeat(32);
  first.atNs = "18446744073709551615";
  await rejects(record.writers.progress.write(event(2)), "WRITER_STOPPED");
  assert.throws(() => record.writers.progress.finish(), { code: "WRITER_STOPPED" });
  release();
  await pending;
  await rejects(record.writers.progress.write(event(3)), "EVENT_ORDER");
  await record.writers.progress.write(event(2));
  record.writers.progress.finish();
  const snapshots = await record.close();
  await rejects(record.writers.progress.write(event(3)), "WRITER_STOPPED");
  await rename(join(config.root, config.destinations.progress.name), join(config.root, "old-progress"));
  const newFile = await open(join(config.root, config.destinations.progress.name), "wx+");
  await newFile.truncate(ACQUISITION_LIMITS.progress); await newFile.close();
  await rejects(readAcquisitionPart({ ...config, role: "progress", destination: config.destinations.progress, range: snapshots.progress }), "FILE_IDENTITY");
});
