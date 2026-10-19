import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rename, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ACQUISITION_LIMITS, inspectAcquisitionRecord, decodeAcquisitionRecord } from "../../../scripts/provenance-acquisition-record.mjs";
import { acquisitionFileIdentity } from "../../../scripts/provenance-acquisition-record-io.mjs";
import { createAcquisitionControlSession } from "../../../scripts/provenance-acquisition-control-session.mjs";

const operationId = "1".repeat(32);
const hash = "a".repeat(64);
const utc = "2026-01-02T03:04:05.006Z";
const header = () => ({ recordType: "acq_header_v1", operationId, state: "pending", authorizationRef: "2".repeat(32),
  profileSha256: hash, recipeSha256: hash, inputEvidenceSha256: hash, toolEvidenceSha256: hash,
  priorStateMode: "initial", priorStateSha256: null, declaredLimitsSha256: hash,
  t0MonotonicNs: "7", startedUtc: utc, clockEvidenceSha256: hash, deadlineUtc: "2026-01-02T03:05:05.006Z" });
const digest = createHash("sha256").update(JSON.stringify(header()) + "\n").digest("hex");
const context = (role, changes = {}) => ({ role, operationId, expectedHeaderSha256: digest,
  profileSha256: hash, t0MonotonicNs: "7", deadlineNs: "1000", ...changes });
const event = (payload = false) => ({ phase: "observe", kind: "resource", subject: "storage", code: "sample",
  reference: payload ? hash : null, value: payload ? "18446744073709551615" : null });
const write = (handle, ...args) => handle.write(...args);
const read = (handle, ...args) => handle.read(...args);

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tabgrad-control-")));
  const destinations = {};
  for (const [role, capacity] of Object.entries(ACQUISITION_LIMITS)) {
    const name = `${role}.record`;
    const file = await open(join(root, name), "wx+", 0o600);
    await file.truncate(capacity);
    destinations[role] = { name, identity: acquisitionFileIdentity(await file.stat({ bigint: true })) };
    await file.close();
  }
  let session;
  t.after(async () => {
    options.unblock?.();
    if (session) await session.finish({ observedUtc: utc });
    await rm(root, { recursive: true, force: true });
  });
  session = await createAcquisitionControlSession({ root, destinations, header: header(),
    supervisorContext: context("supervisor", options.supervisor), watchdogContext: context("watchdog", options.watchdog),
    clock: options.clock ?? (() => "1"), ...(options.transfer ? { transfer: options.transfer } : {}) });
  return { session, root, destinations };
}

test("actual-file session starts only after readback and preserves diagnostic endings without external admission", async t => {
  const handles = new Set();
  const { session } = await fixture(t, { transfer: {
    async write(handle, ...args) { handles.add(handle); return write(handle, ...args); }, read,
  } });
  assert.equal(session.snapshot().mayStart, false);
  assert.equal((await session.start()).mayStart, true);
  await session.supervisor.append(event());
  const pending = session.finish({ observedUtc: utc });
  assert.equal(session.snapshot().mayStart, false);
  assert.equal(session.finish({ observedUtc: utc }), pending);
  const result = await pending;
  assert.deepEqual(result.collection, { formatComplete: true, formatError: null });
  assert.deepEqual(result.localClose, { supervisor: true, watchdog: true });
  assert.equal(result.externalClosure, "unqualified");
  assert.equal(result.releaseAdmission, "unqualified");
  assert.equal(handles.size, 4);
  for (const handle of handles) assert.equal(handle.fd, -1);
  const records = inspectAcquisitionRecord(result.parts).records;
  assert.equal(records.progress.length, 1);
  assert.equal(records.progress[0].sequence, "1");
  assert.equal(records.supervisor[0].clientState, "not_started");
  for (const role of ["supervisor", "watchdog"]) {
    assert.equal(records[role][0].lifecycleState, "unknown");
    assert.equal(records[role][0].helperClosureState, "unknown");
  }
  assert.equal(records.watchdog[0].peerState, "unknown");
  assert.equal(records.watchdog[0].containmentState, "unconfirmed");
  const snapshot = session.snapshot();
  await assert.rejects(session.start(), { code: "SESSION_STOPPED" });
  await assert.rejects(session.supervisor.append(event()), { code: "SESSION_STOPPED" });
  assert.throws(() => session.stop("watchdog"), { code: "SESSION_STOPPED" });
  assert.deepEqual(session.snapshot(), snapshot);
});

test("watchdog receives independently frozen expectations rather than learning the received header", async t => {
  for (const watchdog of [{}, { operationId: "3".repeat(32) }, { profileSha256: "b".repeat(64) },
    { t0MonotonicNs: "8" }, { expectedHeaderSha256: "b".repeat(64) }]) {
    const { session } = await fixture(t, { watchdog });
    const started = await session.start();
    const mismatch = Object.keys(watchdog).length !== 0;
    assert.equal(started.mayStart, !mismatch);
    if (mismatch) {
      assert.equal(started.actors.watchdog.firstFailure.code, "protocol");
      assert.equal(started.actors.supervisor.firstFailure.code, "peer");
    }
    const result = await session.finish({ observedUtc: utc });
    assert.equal(result.collection.formatComplete, !mismatch);
    assert.deepEqual(result.localClose, { supervisor: true, watchdog: true });
  }
});

test("read failure preserves the writing outcome and the exact known read prefix", async t => {
  let calls = 0;
  const { session } = await fixture(t, { transfer: { write,
    async read(handle, bytes, offset, length, position) {
      if (++calls === 1) return handle.read(bytes, offset, 3, position);
      return { bytesRead: 0 };
    },
  } });
  const failed = await session.start();
  assert.equal(failed.mayStart, false);
  assert.equal(failed.headerReadback.readBytes, 3);
  assert.equal(failed.headerReadback.readError, "READ_INCOMPLETE");
  assert.equal(failed.writes.header.state, "complete");
  assert.equal(failed.writes.header.firstError, null);
  assert.equal(failed.actors.supervisor.firstFailure.code, "storage");
  const result = await session.finish({ observedUtc: utc });
  assert.equal(calls, 2);
  assert.equal(result.collection.formatComplete, false);
  assert.equal(result.writes.watchdog.state, "complete");
});

test("actual changed header bytes revoke the gate even after a successful write", async t => {
  const { session } = await fixture(t, { transfer: { read,
    async write(handle, bytes, ...args) {
      const result = await handle.write(bytes, ...args);
      if (bytes.includes(Buffer.from('"acq_header_v1"'))) {
        const position = bytes.indexOf(Buffer.from('"profileSha256":"')) + '"profileSha256":"'.length;
        await handle.write(Buffer.from("b"), 0, 1, position);
      }
      return result;
    },
  } });
  const result = await session.start();
  assert.equal(result.headerReadback.state, "complete");
  assert.equal(result.writes.header.state, "complete");
  assert.equal(result.mayStart, false);
  assert.equal(result.actors.supervisor.firstFailure.code, "protocol");
  assert.equal((await session.finish({ observedUtc: utc })).collection.formatComplete, false);
});

test("synchronous revocation and finish wait for the held read but late readiness cannot restore permission", async t => {
  let release;
  let entered;
  const held = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const { session } = await fixture(t, { unblock: release, transfer: { write,
    async read(...args) { entered(); await held; return read(...args); },
  } });
  const starting = session.start();
  await ready;
  const stopped = session.stop("supervisor", "observer");
  assert.equal(stopped.actors.supervisor.gate, "revoked");
  assert.equal(stopped.actors.watchdog.gate, "revoked");
  assert.equal(stopped.headerReadback, null);
  let finished = false;
  const finishing = session.finish({ observedUtc: utc }).then(value => { finished = true; return value; });
  await Promise.resolve();
  assert.equal(finished, false);
  release();
  assert.equal((await starting).mayStart, false);
  const result = await finishing;
  assert.equal(result.actors.supervisor.firstFailure.code, "observer");
  assert.equal(result.actors.watchdog.firstFailure.code, "peer");
  assert.equal(result.actors.watchdog.stage, "new");
  assert.deepEqual(result.localClose, { supervisor: true, watchdog: true });
});

test("a concurrent append revokes without repeating the pending write or losing its confirmed bytes", async t => {
  let release;
  let entered;
  let progressWrites = 0;
  const held = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const { session } = await fixture(t, { unblock: release, transfer: { read,
    async write(handle, bytes, ...args) {
      if (bytes.includes(Buffer.from('"acq_event_v1"'))) { progressWrites++; entered(); await held; }
      return handle.write(bytes, ...args);
    },
  } });
  await session.start();
  const first = session.supervisor.append(event());
  await ready;
  await assert.rejects(session.supervisor.append(event()), { code: "SESSION_STOPPED" });
  assert.equal(session.snapshot().mayStart, false);
  release();
  await first;
  const result = await session.finish({ observedUtc: utc });
  assert.equal(progressWrites, 1);
  assert.equal(inspectAcquisitionRecord(result.parts).records.progress.length, 1);
  assert.equal(result.collection.formatComplete, true);
  assert.equal(result.actors.supervisor.firstFailure.code, "protocol");
});

test("unreadable, regressive and expired clocks revoke; invalid clocks never fabricate a final timestamp", async t => {
  for (const invalid of [null, "0", "1001", "18446744073709551616", () => { throw Error("private clock"); }]) {
    let current = "1";
    const { session } = await fixture(t, { clock: () => typeof current === "function" ? current() : current });
    await session.start();
    current = invalid;
    const result = await session.supervisor.append(event());
    assert.equal(result.mayStart, false);
    assert.equal(result.actors.supervisor.firstFailure.code, invalid === "1001" ? "deadline" : "clock");
    const final = await session.finish({ observedUtc: utc });
    assert.deepEqual(final.localClose, { supervisor: true, watchdog: true });
    if (invalid !== "1001") {
      assert.equal(final.writes.supervisor.confirmedBytes, 0);
      assert.equal(final.writes.watchdog.confirmedBytes, 0);
    }
    assert.equal(final.collection.formatComplete, invalid === "1001");
  }
});

test("one actor's ambiguous ending never consumes the other reserve or causes an automatic retry", async t => {
  let endingWrites = 0;
  const { session } = await fixture(t, { transfer: { read,
    async write(handle, bytes, ...args) {
      const result = await handle.write(bytes, ...args);
      if (bytes.includes(Buffer.from('"acq_supervisor_end_v1"'))) { endingWrites++; throw Error("private ambiguous write"); }
      return result;
    },
  } });
  await session.start();
  const result = await session.finish({ observedUtc: utc });
  assert.equal(endingWrites, 1);
  assert.equal(result.writes.supervisor.confirmedBytes, 0);
  assert.equal(result.writes.supervisor.uncertain, true);
  assert.equal(result.parts.supervisor.bytes.length, 0);
  assert.equal(result.writes.watchdog.state, "complete");
  assert.equal(result.collection.formatComplete, false);
  await session.finish({ observedUtc: utc });
  assert.equal(endingWrites, 1);
});

test("close failure remains visible even with complete endings and successful representation", async t => {
  let captured;
  let nativeClose;
  const { session } = await fixture(t, { transfer: { read,
    async write(handle, bytes, ...args) {
      if (!captured) {
        captured = handle; nativeClose = handle.close.bind(handle);
        handle.close = async () => { throw Error("private close"); };
      }
      return handle.write(bytes, ...args);
    },
  } });
  await session.start();
  const result = await session.finish({ observedUtc: utc });
  assert.equal(result.writes.supervisor.state, "complete");
  assert.equal(result.writes.watchdog.state, "complete");
  assert.equal(result.writes.header.closeError, "CLOSE_FAILED");
  assert.equal(result.localClose.supervisor, false);
  assert.equal(result.collection.formatComplete, false);
  assert.notEqual(captured.fd, -1);
  await nativeClose();
});

test("collection replacement stays incomplete rather than substituting a reopened file", async t => {
  let root;
  const fixtureResult = await fixture(t, { transfer: { read,
    async write(handle, bytes, ...args) {
      const result = await handle.write(bytes, ...args);
      if (bytes.includes(Buffer.from('"acq_watchdog_end_v1"'))) {
        await rename(join(root, "header.record"), join(root, "original-header"));
        const file = await open(join(root, "header.record"), "wx+");
        await file.truncate(ACQUISITION_LIMITS.header); await file.close();
      }
      return result;
    },
  } });
  root = fixtureResult.root;
  const { session } = fixtureResult;
  await session.start();
  const result = await session.finish({ observedUtc: utc });
  assert.deepEqual(result.localClose, { supervisor: true, watchdog: true });
  assert.equal(result.parts.header.readError, "COLLECTION_FAILED");
  assert.equal(result.collection.formatComplete, false);
  assert.equal((await readFile(join(root, "original-header"))).subarray(0, result.writes.header.confirmedBytes).at(-1), 10);
});

test("event count, payload and transfer width vary independently without repeated whole-history reads", async t => {
  for (const count of [1, 17]) for (const payload of [false, true]) for (const width of [7, 4096]) {
    let readBytes = 0;
    let writtenBytes = 0;
    let calls = 0;
    const { session } = await fixture(t, { transfer: {
      async write(handle, bytes, offset, length, position) {
        const result = await handle.write(bytes, offset, Math.min(width, length), position);
        writtenBytes += result.bytesWritten; calls++;
        return result;
      },
      async read(handle, bytes, offset, length, position) {
        const result = await handle.read(bytes, offset, Math.min(width, length), position);
        readBytes += result.bytesRead;
        return result;
      },
    } });
    await session.start();
    for (let i = 0; i < count; i++) await session.supervisor.append(event(payload));
    const result = await session.finish({ observedUtc: utc });
    assert.equal(result.collection.formatComplete, true, JSON.stringify({ count, payload, width }));
    assert.equal(inspectAcquisitionRecord(result.parts).records.progress.length, count);
    assert.equal(readBytes, result.writes.header.confirmedBytes);
    assert.equal(writtenBytes, Object.values(result.writes).reduce((sum, part) => sum + part.confirmedBytes, 0));
    const expectedCalls = Object.values(result.parts).flatMap(part => part.bytes.toString("ascii").split("\n")
      .filter(Boolean).map(line => Math.ceil((Buffer.byteLength(line) + 1) / width))).reduce((sum, value) => sum + value, 0);
    assert.equal(calls, expectedCalls);
  }
});

test("closed progress input rejects accessors and extensions before user code can run", async t => {
  const { session } = await fixture(t);
  await session.start();
  const input = event();
  Object.defineProperty(input, "code", { get() { assert.fail("getter invoked"); }, enumerable: true });
  await assert.rejects(session.supervisor.append(input), { code: "SESSION_INPUT" });
  assert.equal(session.snapshot().actors.supervisor.firstFailure.code, "protocol");
  assert.equal((await session.finish({ observedUtc: utc })).writes.progress.confirmedBytes, 0);
});

test("factory rejects invalid role expectations before opening any destination or calling the clock", async () => {
  const input = { root: "/not-an-owned-acquisition-directory", destinations: {}, header: header(),
    supervisorContext: context("supervisor"), watchdogContext: context("watchdog"),
    clock() { assert.fail("clock must not run during creation"); } };
  await assert.rejects(createAcquisitionControlSession({ ...input, watchdogContext: context("supervisor") }), { code: "SESSION_INPUT" });
  const accessor = context("watchdog");
  Object.defineProperty(accessor, "role", { get() { assert.fail("context getter invoked"); }, enumerable: true });
  await assert.rejects(createAcquisitionControlSession({ ...input, watchdogContext: accessor }), { code: "CONTROL_CONTEXT" });
  await assert.rejects(createAcquisitionControlSession({ ...input, clock: null }), { code: "SESSION_INPUT" });
});

test("finishing without starting closes owned files and cannot manufacture a successful handshake", async t => {
  const { session } = await fixture(t);
  const result = await session.finish({ observedUtc: utc });
  assert.equal(result.mayStart, false);
  assert.equal(result.writes.header.confirmedBytes, 0);
  assert.equal(result.collection.formatComplete, false);
  assert.deepEqual(result.localClose, { supervisor: true, watchdog: true });
  assert.equal(result.actors.supervisor.stage, "new");
  assert.equal(result.actors.watchdog.stage, "new");
});

test("a supervisor expectation mismatch preserves its actual written header hash in the ending", async t => {
  const { session } = await fixture(t, { supervisor: { expectedHeaderSha256: "b".repeat(64) } });
  assert.equal((await session.start()).mayStart, false);
  const result = await session.finish({ observedUtc: utc });
  assert.equal(result.actors.supervisor.firstFailure.code, "protocol");
  const ending = decodeAcquisitionRecord("supervisor", result.parts.supervisor.bytes);
  assert.equal(ending.headerSha256, digest);
});
