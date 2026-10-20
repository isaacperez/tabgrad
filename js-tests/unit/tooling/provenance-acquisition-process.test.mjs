import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ACQUISITION_LIMITS, inspectAcquisitionRecord } from "../../../scripts/provenance-acquisition-record.mjs";
import { acquisitionFileIdentity } from "../../../scripts/provenance-acquisition-record-io.mjs";
import { createAcquisitionProcessSession } from "../../../scripts/provenance-acquisition-process.mjs";
import { decodeAcquisitionProcessMessage } from "../../../scripts/provenance-acquisition-process-protocol.mjs";
import { hostProfile } from "../../fixtures/provenance-acquisition-host.mjs";

const operationId = "1".repeat(32);
const hash = "a".repeat(64);
const utc = "2026-01-02T03:04:05.006Z";
const progress = () => ({ phase: "observe", kind: "resource", subject: "storage", code: "sample", reference: null, value: "7" });

function rewriteReply(rewrite, role, wire) {
  const message = decodeAcquisitionProcessMessage(wire);
  return message.kind === "reply" ? rewrite(role, message) ?? wire : wire;
}

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tabgrad-process-")));
  const destinations = {};
  const children = {};
  const sent = [];
  const received = [];
  let session;
  t.after(async () => {
    for (const child of Object.values(children)) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    if (session) await session.finish({ observedUtc: utc });
    await rm(root, { recursive: true, force: true });
  });
  for (const [role, capacity] of Object.entries(ACQUISITION_LIMITS)) {
    const name = `${role}.record`;
    const file = await open(join(root, name), "wx+", 0o600);
    await file.truncate(capacity);
    destinations[role] = { name, identity: acquisitionFileIdentity(await file.stat({ bigint: true })) };
    await file.close();
  }
  const origin = process.hrtime.bigint().toString();
  const header = { recordType: "acq_header_v1", operationId, state: "pending", authorizationRef: "2".repeat(32),
    profileSha256: hash, recipeSha256: hash, inputEvidenceSha256: hash, toolEvidenceSha256: hash,
    priorStateMode: "initial", priorStateSha256: null, declaredLimitsSha256: hash,
    t0MonotonicNs: origin, startedUtc: utc, clockEvidenceSha256: hash, deadlineUtc: "2026-01-02T03:05:05.006Z" };
  const original = Buffer.from(JSON.stringify(header) + "\n");
  const digest = createHash("sha256").update(original).digest("hex");
  const context = role => ({ role, operationId, expectedHeaderSha256: digest, profileSha256: hash,
    t0MonotonicNs: origin, deadlineNs: "30000000000", ...(options[role] ?? {}) });
  const input = { root, destinations, header, supervisorContext: context("supervisor"), watchdogContext: context("watchdog"),
    timing: { heartbeatMs: 50, peerTimeoutMs: 3000, termAfterMs: 500, killAfterMs: 1000, closeWaitMs: 2000, ...(options.timing ?? {}) } };
  const forkActor = (role, entry, settings) => {
    options.beforeFork?.(role, settings);
    const child = options.forkActor ? options.forkActor(role, entry, settings) : fork(entry, [], settings);
    children[role] = child;
    options.onChild?.(role, child);
    if (options.rewriteReply) {
      const emit = child.emit.bind(child);
      child.emit = (event, ...args) => {
        if (event === "message") args[0] = rewriteReply(options.rewriteReply, role, args[0]);
        return emit(event, ...args);
      };
    }
    const send = child.send.bind(child);
    child.send = (wire, callback) => { sent.push(decodeAcquisitionProcessMessage(wire)); return send(wire, callback); };
    child.on("message", wire => { received.push({ role, wire }); });
    return child;
  };
  options.beforeCreate?.(input);
  session = await createAcquisitionProcessSession(input, { forkActor });
  return { session, children, root, destinations, original, input, sent, received };
}

function hostOptions(options = {}) {
  return { ...options,
    beforeCreate(input) {
      input.host = hostProfile(input.supervisorContext.t0MonotonicNs);
      input.host.stopAtNs = "20000000000";
      input.host.observeUntilNs = "25000000000";
      options.beforeCreate?.(input);
    },
    forkActor: (role, entry, settings) => fork(new URL("../../fixtures/provenance-acquisition-host-actor.mjs", import.meta.url), [], settings),
  };
}

test("parent admits actual host-bound actors, preserves the profile and joins their native-port closure", { timeout: 15000 }, async t => {
  const f = await fixture(t, hostOptions());
  f.input.host.root.path = "/changed";
  f.input.host.stopAtNs = "1";
  assert.equal((await f.session.start()).mayStart, true);
  for (const role of ["supervisor", "watchdog"]) {
    const host = f.session.snapshot().actors[role].host;
    assert.equal(host.actor, role);
    assert.equal(host.operationId, operationId);
    assert.equal(host.firstFailure, null);
    assert.notEqual(host.observation.atNs, null);
    assert.equal(host.observation.error, null);
    const init = f.sent.find(m => m.actor === role && m.kind === "request" && m.payload.command === "init");
    assert.equal(init.payload.data.host.root.path, "/owned");
    assert.equal(init.payload.data.host.stopAtNs, "20000000000");
    assert.equal(init.payload.data.host.t0MonotonicNs, f.input.header.t0MonotonicNs);
  }
  assert.equal((await f.session.supervisor.append(progress())).mayStart, true);
  const result = await f.session.finish({ observedUtc: utc });
  assert.equal(result.firstFailure, null);
  assert.equal(result.collection.formatComplete, true);
  assert.deepEqual(result.parts.header.bytes, f.original);
  for (const role of ["supervisor", "watchdog"]) {
    assert.equal(result.children[role].finishAck, true);
    assert.equal(result.actors[role].host.ioClosed, "closed");
    assert.equal(result.actors[role].host.firstFailure, null);
    assert.equal(result.actors[role].host.externalClosure, "unqualified");
  }
  assert.equal(result.externalClosure, "unqualified");
});

test("parent rejects a current host-bound reply with absent, revoked, failed or unobserved capability", { timeout: 15000 }, async t => {
  for (const change of [r => { delete r.host; }, r => { r.host.revoked = true; },
    r => { r.host.observation.error = "HOST_READ"; },
    r => { r.host.observation = { atNs: null, populated: null, frozen: null, error: null }; }]) {
    let changed = false;
    const f = await fixture(t, hostOptions({ rewriteReply(role, m) {
      if (changed || role !== "supervisor" || m.payload.command !== "init") return null;
      assert.equal(m.payload.ok, true);
      changed = true;
      change(m.payload.report);
      const wire = JSON.stringify(m);
      decodeAcquisitionProcessMessage(wire); // Valid DTO: admission must reject it, not the codec.
      return wire;
    } }));
    assert.equal((await f.session.start()).mayStart, false);
    assert.equal(changed, true);
    const result = await f.session.finish({ observedUtc: utc });
    assert.deepEqual(result.firstFailure, { actor: "supervisor", code: "protocol" });
  }
});

test("parent rejects a host clock regression on an otherwise current successful append", { timeout: 15000 }, async t => {
  let changed = false;
  const f = await fixture(t, hostOptions({ rewriteReply(role, m) {
    if (role !== "supervisor" || m.payload.command !== "append") return null;
    assert(BigInt(f.session.snapshot().actors.supervisor.host.lastAtNs) > 0n);
    m.payload.report.host.lastAtNs = "0";
    m.payload.report.host.observation.atNs = "0";
    changed = true;
    const wire = JSON.stringify(m);
    decodeAcquisitionProcessMessage(wire);
    return wire;
  } }));
  assert.equal((await f.session.start()).mayStart, true);
  assert.equal((await f.session.supervisor.append(progress())).mayStart, false);
  assert.equal(changed, true);
  assert.deepEqual((await f.session.finish({ observedUtc: utc })).firstFailure, { actor: "supervisor", code: "protocol" });
});

test("parent retains host terminal facts across independent closure and correlated finish receipts", { timeout: 15000 }, async t => {
  for (const [seed, regress] of [
    [h => {}, h => { delete h.report.host; }],
    [h => {}, h => { h.report.host.revoked = false; }],
    [h => { h.firstFailure = "HOST_CHANNEL"; }, h => { h.report.host.firstFailure = "HOST_PEER"; }],
    [h => {}, h => { h.report.host.ioClosed = "open"; }],
    ...["freeze", "kill"].map(effect => [h => { h[effect].state = "acknowledged"; },
      h => { h.report.host[effect].state = "not_requested"; }]),
  ]) {
    let changed = false;
    const f = await fixture(t, hostOptions({ rewriteReply(role, m) {
      if (changed || role !== "supervisor" || m.payload.command !== "finish") return null;
      assert.equal(m.payload.report.localClosed, true);
      assert.equal(m.payload.report.host.ioClosed, "closed");
      assert.equal(m.payload.report.host.revoked, true);
      // Use an actual actor's completed local report. The transport adversary
      // varies only host facts to test the parent's independent monotonic gate;
      // these injected facts make no claim about actual native effects.
      seed(m.payload.report.host);
      const closed = { ...m, kind: "closed", id: "0", payload: { report: structuredClone(m.payload.report) } };
      const receipt = JSON.stringify(closed);
      decodeAcquisitionProcessMessage(receipt);
      f.children.supervisor.emit("message", receipt);
      assert.equal(f.session.snapshot().children.supervisor.finalReceipt, true);
      regress(m.payload);
      const wire = JSON.stringify(m);
      decodeAcquisitionProcessMessage(wire);
      changed = true;
      return wire;
    } }));
    assert.equal((await f.session.start()).mayStart, true);
    const result = await f.session.finish({ observedUtc: utc });
    assert.equal(changed, true);
    assert.deepEqual(result.firstFailure, { actor: "supervisor", code: "protocol" });
    assert.equal(result.children.supervisor.finishAck, false);
  }
});

test("two actual actors own only their parts, bind exact bytes and close without external admission", { timeout: 15000 }, async t => {
  const f = await fixture(t, { beforeFork(role, settings) {
    assert.deepEqual(settings.env, {});
    assert.deepEqual(settings.execArgv, []);
    assert.deepEqual(settings.stdio, ["ignore", "ignore", "ignore", "ipc"]);
    assert.equal(settings.execPath, process.execPath);
  } });
  assert.deepEqual(Object.keys(f.children), []);
  assert.equal((await f.session.start()).mayStart, true);
  assert.notEqual(f.children.supervisor.pid, f.children.watchdog.pid);
  assert.notEqual(f.children.supervisor.pid, process.pid);
  assert.notEqual(f.children.watchdog.pid, process.pid);
  assert.equal(f.session.snapshot().children.supervisor.spawnObserved, true);
  assert.equal(f.session.snapshot().children.watchdog.spawnObserved, true);
  for (const role of ["supervisor", "watchdog"]) {
    const init = f.sent.find(m => m.actor === role && m.kind === "request" && m.payload.command === "init");
    assert.deepEqual(Object.keys(init.payload.data.destinations), role === "supervisor" ? ["header", "progress", "supervisor"] : ["watchdog"]);
    assert.equal(init.payload.data.context.role, role);
    if (role === "watchdog") assert.equal(init.payload.data.header, null);
  }
  await f.session.supervisor.append(progress());
  const closing = f.session.finish({ observedUtc: utc });
  assert.equal(f.session.snapshot().mayStart, false);
  assert.equal(f.session.finish({ observedUtc: utc }), closing);
  const result = await closing;
  assert.deepEqual(result.collection, { formatComplete: true, formatError: null });
  assert.equal(result.firstFailure, null);
  assert.deepEqual(result.parts.header.bytes, f.original);
  const records = inspectAcquisitionRecord(result.parts).records;
  assert.equal(records.progress.length, 1);
  assert.equal(records.progress[0].value, "7");
  for (const role of ["supervisor", "watchdog"]) {
    assert.equal(result.children[role].state, "closed");
    assert.equal(result.children[role].finishAck, true);
    assert.equal(result.children[role].termRequested, false);
    assert.equal(records[role][0].lifecycleState, "unknown");
  }
  assert.equal(result.externalClosure, "unqualified");
  assert.equal(result.clockAdmission, "unqualified");
  assert.equal(result.releaseAdmission, "unqualified");
  await assert.rejects(f.session.start(), { code: "PROCESS_STOPPED" });
  await assert.rejects(f.session.supervisor.append(progress()), { code: "PROCESS_STOPPED" });
});

test("watchdog's independent header expectation rejects the handoff and preserves originals", { timeout: 15000 }, async t => {
  const f = await fixture(t, { watchdog: { expectedHeaderSha256: "b".repeat(64) } });
  assert.equal((await f.session.start()).mayStart, false);
  const result = await f.session.finish({ observedUtc: utc });
  assert.equal(result.firstFailure.actor, "watchdog");
  assert.equal(result.firstFailure.code, "protocol");
  assert.equal(result.actors.watchdog.firstFailure.code, "protocol");
  assert.equal(result.children.supervisor.state, "closed");
  assert.equal(result.children.watchdog.state, "closed");
  const actual = await readFile(join(f.root, "header.record"));
  assert.deepEqual(actual.subarray(0, f.original.length), f.original);
});

test("partial startup adopts and closes the already launched actor, without writing records", { timeout: 15000 }, async t => {
  const f = await fixture(t, { beforeFork(role) { if (role === "watchdog") throw new Error("private detail must not escape"); } });
  const started = await f.session.start();
  assert.equal(started.mayStart, false);
  const result = await f.session.finish({ observedUtc: utc });
  assert.deepEqual(result.firstFailure, { actor: "watchdog", code: "startup" });
  assert.equal(result.children.supervisor.state, "closed");
  assert.equal(result.children.watchdog.state, "not_started");
  assert.equal(result.collection.formatComplete, false);
  assert.equal((await readFile(join(f.root, "header.record"))).every(b => b === 0), true);
});

for (const lost of ["supervisor", "watchdog"]) {
  test(`loss of the actual ${lost} revokes admission and leaves its missing ending unknown`, { timeout: 15000 }, async t => {
    const f = await fixture(t);
    assert.equal((await f.session.start()).mayStart, true);
    await f.session.supervisor.append(progress());
    const ended = once(f.children[lost], "close");
    f.children[lost].kill("SIGKILL");
    await ended;
    const result = await f.session.finish({ observedUtc: utc });
    assert.equal(result.mayStart, false);
    assert.notEqual(result.firstFailure, null);
    assert.equal(result.collection.formatComplete, false);
    assert.equal(result.children[lost].finishAck, false);
    assert.equal(result.parts[lost].state, "unknown");
    assert.equal(result.parts[lost].uncertain, true);
    assert.equal(result.parts[lost].readBytes, 0);
    for (const role of ["supervisor", "watchdog"]) assert.equal(result.children[role].state, "closed");
    if (lost === "supervisor") {
      assert.deepEqual(result.parts.header.bytes, f.original);
      assert.equal(inspectAcquisitionRecord(result.parts).records.progress[0].value, "7");
    }
    assert.equal(result.externalClosure, "unqualified");
  });
}

test("an old reply cannot reopen readiness, even while the actors remain alive", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.session.start();
  const old = f.received.find(({ wire }) => {
    const m = decodeAcquisitionProcessMessage(wire);
    return m.kind === "reply" && m.payload.command === "prepare";
  });
  f.children.supervisor.emit("message", old.wire);
  assert.equal(f.session.snapshot().mayStart, false);
  const result = await f.session.finish({ observedUtc: utc });
  assert.deepEqual(result.firstFailure, { actor: "supervisor", code: "protocol" });
  assert.deepEqual(result.parts.header.bytes, f.original);
  for (const role of ["supervisor", "watchdog"]) assert.equal(result.children[role].state, "closed");
});

test("parent-channel loss records actual exit separately from unconfirmed transport and record closure", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.session.start();
  const ended = once(f.children.watchdog, "exit");
  f.children.watchdog.disconnect();
  await ended;
  const result = await f.session.finish({ observedUtc: utc });
  assert.equal(result.mayStart, false);
  assert.equal(result.children.watchdog.exitObserved, true);
  assert.equal(result.children.watchdog.exitCode, 0);
  assert.equal(result.children.watchdog.termRequested, false);
  assert.equal(result.children.watchdog.killRequested, false);
  assert.equal(result.children.watchdog.finishAck, false);
  assert.equal(result.children.watchdog.finalReceipt, false);
  assert.equal(result.parts.watchdog.state, "unknown");
  assert.equal(result.collection.formatComplete, false);
  assert.equal(result.externalClosure, "unqualified");
});

test("stop is immediate and idempotent while actual actors are starting", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const starting = f.session.start();
  f.session.stop("supervisor", "controller");
  assert.equal(f.session.snapshot().mayStart, false);
  f.session.stop("watchdog", "protocol");
  await starting;
  const result = await f.session.finish({ observedUtc: utc });
  assert.deepEqual(result.firstFailure, { actor: "supervisor", code: "controller" });
  assert.equal(result.collection.formatComplete, false);
  for (const role of ["supervisor", "watchdog"]) assert.equal(result.children[role].state, "closed");
});

test("the independent watchdog observes a suspended peer and preserves the loss in its own record", { timeout: 15000 }, async t => {
  const f = await fixture(t, { timing: { termAfterMs: 100, killAfterMs: 250, closeWaitMs: 1500 } });
  await f.session.start();
  const lost = new Promise(resolve => f.children.watchdog.on("message", wire => {
    const m = decodeAcquisitionProcessMessage(wire);
    if (m.kind === "fault" && m.payload.code === "peer") resolve();
  }));
  f.children.supervisor.kill("SIGSTOP");
  await lost;
  const result = await f.session.finish({ observedUtc: utc });
  assert.deepEqual(result.firstFailure, { actor: "watchdog", code: "peer" });
  assert.equal(result.children.supervisor.killRequested, true);
  assert.equal(result.children.supervisor.state, "closed");
  assert.equal(result.actors.watchdog.firstFailure.code, "peer");
  const record = inspectAcquisitionRecord(result.parts).records.watchdog[0];
  assert.equal(record.stopCode, "observer");
  assert.equal(record.peerState, "lost");
  assert.equal(record.containmentState, "unconfirmed");
  assert.equal(result.collection.formatComplete, false);
});

test("caller mutations after creation cannot change handoff paths, expectations or timing", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  f.input.destinations.header.name = "other";
  f.input.header.authorizationRef = "9".repeat(32);
  f.input.supervisorContext.expectedHeaderSha256 = "b".repeat(64);
  f.input.timing.heartbeatMs = 0;
  assert.equal((await f.session.start()).mayStart, true);
  const result = await f.session.finish({ observedUtc: utc });
  assert.equal(result.collection.formatComplete, true);
  assert.deepEqual(result.parts.header.bytes, f.original);
});

test("finish before launch closes no imaginary actors and cannot admit or fabricate records", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const result = await f.session.finish({ observedUtc: utc });
  assert.equal(result.collection.formatComplete, false);
  assert.equal(result.children.supervisor.state, "not_started");
  assert.equal(result.children.watchdog.state, "not_started");
  assert.deepEqual(Object.keys(f.children), []);
  await assert.rejects(f.session.start(), { code: "PROCESS_STOPPED" });
});

test("an unconfirmed child is never collected or promoted by successful signal API returns", { timeout: 15000 }, async t => {
  const signals = [];
  const f = await fixture(t, { timing: { termAfterMs: 10, killAfterMs: 20, closeWaitMs: 50 },
    forkActor(role) {
      const child = new EventEmitter();
      child.pid = role === "supervisor" ? 100001 : 100002;
      child.connected = true;
      child.send = (wire, callback) => { queueMicrotask(() => callback(null)); return true; };
      child.kill = signal => { signals.push([role, signal]); return true; };
      return child;
    } });
  const starting = f.session.start();
  const result = await f.session.finish({ observedUtc: utc });
  await starting;
  assert.equal(result.collection.formatComplete, false);
  assert.equal(result.firstFailure.code, "cleanup");
  assert.equal(signals.filter(([, signal]) => signal === "SIGTERM").length, 2);
  assert.equal(signals.filter(([, signal]) => signal === "SIGKILL").length, 2);
  for (const role of ["supervisor", "watchdog"]) {
    assert.equal(result.children[role].state, "unconfirmed");
    assert.equal(result.children[role].exitObserved, false);
  }
  for (const part of Object.values(result.parts)) {
    assert.equal(part.readError, "OWNER_UNCONFIRMED");
    assert.equal(part.readBytes, 0);
    assert.equal(part.uncertain, true);
  }
});

test("finish joins an already admitted append and retains its original progress", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.session.start();
  const appending = f.session.supervisor.append(progress());
  const finishing = f.session.finish({ observedUtc: utc });
  assert.equal(f.session.snapshot().mayStart, false);
  await appending;
  const result = await finishing;
  assert.equal(result.firstFailure, null);
  assert.equal(result.collection.formatComplete, true);
  assert.equal(inspectAcquisitionRecord(result.parts).records.progress[0].value, "7");
});

test("concurrent requests revoke without enqueueing a second progress effect", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.session.start();
  const first = f.session.supervisor.append(progress());
  await assert.rejects(f.session.supervisor.append({ ...progress(), value: "9" }), { code: "PROCESS_STOPPED" });
  await first;
  const result = await f.session.finish({ observedUtc: utc });
  assert.deepEqual(result.firstFailure, { actor: "supervisor", code: "protocol" });
  const progressRecords = inspectAcquisitionRecord(result.parts).records.progress;
  assert(progressRecords.length <= 1);
  for (const record of progressRecords) assert.equal(record.value, "7");
});

test("asynchronous native launch failure is a closed startup diagnostic and joins the other actor", { timeout: 15000 }, async t => {
  const f = await fixture(t, { beforeFork(role, settings) {
    if (role === "watchdog") settings.execPath = join(settings.cwd, "absent-node");
  } });
  assert.equal((await f.session.start()).mayStart, false);
  const result = await f.session.finish({ observedUtc: utc });
  assert.deepEqual(result.firstFailure, { actor: "watchdog", code: "startup" });
  assert.equal(result.children.supervisor.state, "closed");
  assert.equal(result.children.watchdog.state, "closed");
  assert.equal(result.children.watchdog.firstError, "startup");
  assert.equal(result.collection.formatComplete, false);
  assert.equal(JSON.stringify(result).includes("absent-node"), false);
});

test("role, operation, native PID, request and phase mismatches each reject a current reply", { timeout: 15000 }, async t => {
  for (const change of [m => { m.actor = "watchdog"; }, m => { m.operationId = "9".repeat(32); },
    m => { m.payload.report.pid += 1; }, m => { m.id = "999"; },
    m => { m.payload.report.phase = "observe"; }, m => { m.payload.report.stage = "bound"; }]) {
    let changed = false;
    const f = await fixture(t, { rewriteReply(role, message) {
      if (changed || role !== "supervisor" || message.payload.command !== "prepare") return null;
      changed = true;
      change(message);
      return JSON.stringify(message);
    } });
    assert.equal((await f.session.start()).mayStart, false);
    assert.equal(changed, true);
    const result = await f.session.finish({ observedUtc: utc });
    assert.deepEqual(result.firstFailure, { actor: "supervisor", code: "protocol" });
  }
});

test("collection detects changed original bytes instead of accepting the actor's earlier hash", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.session.start();
  const handle = await open(join(f.root, "header.record"), "r+");
  const at = f.original.indexOf('"authorizationRef":"') + '"authorizationRef":"'.length;
  await handle.write(Buffer.from("3"), 0, 1, at);
  await handle.close();
  const result = await f.session.finish({ observedUtc: utc });
  assert.equal(result.parts.header.readError, "PREFIX_MISMATCH");
  assert.equal(result.parts.header.uncertain, true);
  assert.equal(result.collection.formatComplete, false);
  assert.equal(result.firstFailure.code, "storage");
});

test("complete-set aliases are rejected before any process is launched", async t => {
  let launched = 0;
  await assert.rejects(fixture(t, { beforeCreate(input) {
    input.destinations.watchdog = input.destinations.supervisor;
  }, beforeFork() { launched++; } }), { code: "FILE_ALIAS" });
  assert.equal(launched, 0);
});

test("invalid timing and destination accessors fail before launch without evaluating getters", async t => {
  let reads = 0;
  let launched = 0;
  await assert.rejects(fixture(t, { beforeCreate(input) { input.timing.heartbeatMs = 0; },
    beforeFork() { launched++; } }), { code: "PROCESS_INPUT" });
  await assert.rejects(fixture(t, { beforeCreate(input) {
    Object.defineProperty(input.destinations, "header", { enumerable: true, get() { reads++; return {}; } });
  }, beforeFork() { launched++; } }), { code: "PROCESS_INPUT" });
  assert.equal(reads, 0);
  assert.equal(launched, 0);
});

test("an expired common origin prevents launch and is never renewed at start", { timeout: 15000 }, async t => {
  const f = await fixture(t, { beforeCreate(input) {
    const origin = (process.hrtime.bigint() / 2n).toString();
    input.header.t0MonotonicNs = origin;
    const digest = createHash("sha256").update(JSON.stringify(input.header) + "\n").digest("hex");
    for (const role of ["supervisorContext", "watchdogContext"]) {
      input[role].t0MonotonicNs = origin;
      input[role].deadlineNs = "1";
      input[role].expectedHeaderSha256 = digest;
    }
  } });
  assert.equal((await f.session.start()).mayStart, false);
  const result = await f.session.finish({ observedUtc: utc });
  assert.deepEqual(result.firstFailure, { actor: "supervisor", code: "deadline" });
  assert.deepEqual(Object.keys(f.children), []);
});
