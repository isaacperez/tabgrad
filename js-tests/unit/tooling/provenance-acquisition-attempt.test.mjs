import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeAcquisitionRecord, acquisitionSha256 } from "../../../scripts/provenance-acquisition-record.mjs";
import { createAcquisitionCaptureAttempt } from "../../../scripts/provenance-acquisition-capture-attempt.mjs";
import { createAcquisitionAttempt } from "../../../scripts/provenance-acquisition-attempt.mjs";
import { captureFixture, until } from "../../fixtures/provenance-acquisition-capture-attempt.mjs";
import { attemptFixture, preparedStartup, observedUtc } from "../../fixtures/provenance-acquisition-attempt.mjs";
import { wireFrame } from "../../fixtures/provenance-acquisition-exec.mjs";

test("actual three-control startup and actual capture retain separate originals and conservative record endings", { timeout: 15000 }, async t => {
  const out = Buffer.from([0, 255, 10]); const err = Buffer.from("finite program stderr\n");
  const f = await captureFixture(t, { origin: process.hrtime.bigint().toString(), deadlineNs: "6000000000",
    workUntilNs: "4000000000", closeUntilNs: "5000000000", stdout: [out], stderr: [err] });
  f.input.exec.timing.closeWaitMs = 5000;
  const { startup, launches, headerBytes } = await preparedStartup(t, f);
  const owner = f.create((input, ports) => {
    const { gate, clock, ...capture } = ports;
    return createAcquisitionAttempt(input, { startup, ...capture });
  });
  assert.equal(f.fileHandles.length, 0); assert.deepEqual(launches, []);
  const opening = owner.open(); assert.equal(owner.open(), opening); assert.equal((await opening).opening, false);
  assert.deepEqual(launches, []); assert.equal(f.daemon.requests.length, 0);
  const running = owner.run({ observedUtc }); assert.equal(owner.run({ observedUtc }), running);
  const end = await running;
  assert.equal(end.localComplete, true); assert.equal(end.firstFailure, null); assert.equal(end.cleanupError, null);
  assert.deepEqual(launches, ["guard", "supervisor", "watchdog"]); assert.equal(f.daemon.requests.length, 4);
  assert.equal(end.captureResult.localComplete, true); assert.equal(end.controlsResult.finished, true);
  assert.deepEqual(await f.original("program.out", out.length), out); assert.deepEqual(await f.original("program.err", err.length), err);
  assert.deepEqual(await f.original("launch.control", f.control.length), f.control);
  assert.equal(end.capture.files.daemon.channels.stdout.confirmedBytes, 0);
  assert.deepEqual(end.controlsResult.process.parts.header.bytes, headerBytes);
  const ending = decodeAcquisitionRecord("supervisor", end.controlsResult.process.parts.supervisor.bytes);
  assert.equal(ending.clientState, "unknown"); assert.equal(ending.stdoutState, "unknown");
  assert.equal(ending.validationState, "not_run"); assert.equal(ending.payloadCustodyState, "unknown");
  assert.equal(end.releaseAdmission, "unqualified"); assert.equal(end.externalClosure, "unqualified");
});

test("copied immutable timing is passive and aggregate input mutation cannot redirect work or its budgets", async t => {
  const direct = await captureFixture(t); const capture = direct.create();
  const before = direct.checks; const timing = capture.timing;
  assert.equal(capture.timing, timing); assert.equal(Object.isFrozen(timing), true);
  assert.throws(() => { timing.deadlineNs = "1"; }, TypeError);
  assert.equal(direct.checks, before); assert.equal(direct.fileHandles.length, 0);
  const f = await attemptFixture(t); const owner = f.create();
  f.input.exec.timing.deadlineNs = "1"; f.input.exec.timing.pollMs = 5000;
  f.input.exec.command.argv = ["/changed"]; f.input.launcherProfile.hostPath = "/changed";
  const original = f.input.exec;
  Object.defineProperty(f.input, "exec", { get() { assert.fail("input reread"); } });
  try {
    const end = await owner.run({ observedUtc });
    assert.equal(end.localComplete, true); assert.equal(end.capture.files.program.channels.stdout.sha256, acquisitionSha256(Buffer.alloc(0)));
  } finally {
    // Restore only the fixture's own teardown lookup, not the operation input.
    Object.defineProperty(f.input, "exec", { value: original });
  }
});

test("capture's final close and permission observation precede normal startup finish", async t => {
  let f;
  f = await attemptFixture(t, { finish() {
    const c = f.owner.snapshot().capture;
    assert.equal(c.finished, true); assert.equal(c.localComplete, true); assert.equal(c.flowPending, false);
    assert(f.fileHandles.every(h => h.closes === 1));
  } });
  const owner = f.create(); const end = await owner.run({ observedUtc });
  assert.equal(end.localComplete, true); assert.deepEqual(f.events, ["start", "intent", "finish"]);
  assert.deepEqual(f.state, { starts: 1, stops: 0, finishes: 1, appends: 1 });
});

test("denied or rejected startup never starts Exec and still joins both owners", async t => {
  for (const options of [{ deny: true }, { start() { throw Error("finite private error"); } }]) {
    const f = await attemptFixture(t, options); const end = await f.create().run({ observedUtc });
    assert.equal(end.localComplete, false); assert.equal(f.daemon.requests.length, 0);
    assert.equal(f.state.starts, 1); assert.equal(f.state.stops, 1); assert.equal(f.state.finishes, 1);
    assert(f.fileHandles.every(h => h.closes === 1)); assert.equal(end.controlsClosePending, false);
    assert(!JSON.stringify(end).includes("private error"));
  }
});

test("failed and held intent cannot issue requests after revocation", async t => {
  for (const held of [false, true]) {
    let hold; const f = await attemptFixture(t, { async append() { if (held) await hold.promise; else throw Error("denied"); } });
    hold = f.hold(); const owner = f.create(); const running = owner.run({ observedUtc });
    if (held) { await until(() => f.state.appends === 1); owner.stop(); hold.resolve(); }
    const end = await running;
    assert.equal(end.localComplete, false); assert.equal(f.daemon.requests.length, 0);
    assert.equal(f.state.finishes, 1); assert(f.fileHandles.every(h => h.closes === 1));
  }
});

test("capture failure and uncertain control collection remain distinct and cannot become success", async t => {
  for (const options of [{ capture: { daemonBytes: wireFrame(1, Buffer.from("daemon diagnostic")) }, controlFailure: true },
    { badRecord: true }, { controlFailure: true }]) {
    const f = await attemptFixture(t, options); const end = await f.create().run({ observedUtc });
    assert.equal(end.localComplete, false); assert.equal(end.cleanupError, "ACQ_ATTEMPT_CONTROLS");
    assert.equal(end.firstFailure, options.capture ? "CAPTURE_ATTEMPT_DAEMON_OUTPUT" : "ACQ_ATTEMPT_CONTROLS");
    assert.equal(f.state.finishes, 1); assert.equal(end.releaseAdmission, "unqualified");
  }
});

test("reentrant run/stop during startup keeps a single promise and first cause", async t => {
  let f; let same;
  f = await attemptFixture(t, { start() { same = f.owner.run({ observedUtc }); f.owner.stop(); } });
  const owner = f.create(); const running = owner.run({ observedUtc }); const end = await running;
  assert.equal(same, running); assert.equal(end.firstFailure, "ACQ_ATTEMPT_STOPPED");
  assert.equal(end.localComplete, false); assert.equal(f.state.starts, 1); assert.equal(f.state.finishes, 1);
  assert.equal(f.daemon.requests.length, 0);
});

test("a stalled control finish expires only the original local wait and later facts cannot restore success", async t => {
  let hold; const f = await attemptFixture(t, { async finish() { await hold.promise; } }); hold = f.hold();
  const owner = f.create(); const running = owner.run({ observedUtc });
  await until(() => f.state.finishes === 1); f.time(200000000n);
  const end = await running; assert.equal(end.cleanupWaitExpired, true); assert.equal(end.controlsClosePending, true);
  assert.equal(end.localComplete, false); hold.resolve(); await until(() => !owner.snapshot().controlsClosePending);
  const late = owner.snapshot(); assert.equal(late.controlsResult.finished, true); assert.equal(late.localComplete, false);
  assert.equal(end.controlsResult, null); assert.equal(end.controlsClosePending, true);
});

test("the last control await is followed by an original clock/deadline check", async t => {
  for (const now of [99n, 3000000100n, undefined]) {
    let f; f = await attemptFixture(t, { finish() { f.time(now); } });
    const end = await f.create().run({ observedUtc });
    assert.equal(end.localComplete, false); assert.equal(end.cleanupWaitExpired, true);
    assert.equal(end.firstFailure, now === 3000000100n ? "ACQ_ATTEMPT_DEADLINE" : "ACQ_ATTEMPT_CLOCK");
  }
});

test("cancellation during the first clock callback admits no file open or control start", { timeout: 1500 }, async t => {
  let f; f = await attemptFixture(t, { capture: { clock(now) { f.owner.stop(); return now; } } });
  const end = await f.create().run({ observedUtc });
  assert.equal(end.firstFailure, "ACQ_ATTEMPT_STOPPED"); assert.equal(f.fileHandles.length, 0);
  assert.equal(f.state.starts, 0); assert.equal(f.state.finishes, 1); assert.equal(f.daemon.requests.length, 0);
});

test("unavailable original capture preparation never starts controls", async t => {
  const f = await attemptFixture(t);
  f.ports.files.open = async () => { throw Error("finite failure before native opening"); };
  const end = await f.create().run({ observedUtc });
  assert.equal(end.localComplete, false); assert.equal(f.state.starts, 0); assert.equal(f.state.finishes, 1);
  assert.equal(f.daemon.requests.length, 0); assert(f.fileHandles.every(h => h.closes === 1));
});

test("stop before open/run never starts work and repeated methods retain their promises", async t => {
  const f = await attemptFixture(t); const owner = f.create(); owner.stop(); owner.stop();
  const opening = owner.open(); assert.equal(owner.open(), opening); assert.equal((await opening).opening, false);
  const joining = owner.join(); assert.equal(owner.join(), joining);
  const running = owner.run({ observedUtc }); assert.equal(owner.run({ observedUtc }), running);
  const end = await running; assert.equal(end.firstFailure, "ACQ_ATTEMPT_STOPPED");
  assert.equal(f.state.starts, 0); assert.equal(f.state.stops, 1); assert.equal(f.state.finishes, 1);
  assert.equal(f.fileHandles.length, 0); assert.equal(f.daemon.requests.length, 0);
});

test("stop during an admitted native open owns its late handle without opening another file", async t => {
  let hold; const f = await attemptFixture(t, { capture: { async fileOpen() { await hold.promise; } } }); hold = f.hold();
  const owner = f.create(); const running = owner.run({ observedUtc });
  await until(() => f.fileHandles.length === 1); owner.stop(); hold.resolve();
  const end = await running; assert.equal(end.firstFailure, "ACQ_ATTEMPT_STOPPED");
  assert.equal(f.fileHandles.length, 1); assert.equal(f.fileHandles[0].closes, 1);
  assert.equal(f.state.starts, 0); assert.equal(f.state.finishes, 1); assert.equal(end.localComplete, false);
});

test("stalled startup is bounded; a late ready response cannot start capture", async t => {
  let hold; const f = await attemptFixture(t, { async start() { await hold.promise; } }); hold = f.hold();
  const owner = f.create(); const running = owner.run({ observedUtc });
  await until(() => f.state.starts === 1); owner.stop(); f.time(200000000n);
  const end = await running; assert.equal(end.workPending, true); assert.equal(end.cleanupWaitExpired, true);
  assert.equal(end.firstFailure, "ACQ_ATTEMPT_STOPPED"); hold.resolve();
  await until(() => !owner.snapshot().workPending);
  assert.equal(f.daemon.requests.length, 0); assert.equal(f.state.starts, 1); assert.equal(f.state.finishes, 1);
  assert.equal(owner.snapshot().localComplete, false); assert.equal(end.workPending, true);
});

test("lost current permission stops work while preserving a held program write's actual prefix", async t => {
  let hold; let writing = false; const bytes = Buffer.from([0, 255, 7]);
  const f = await attemptFixture(t, { capture: { stdout: [bytes], async write(h, b, o, n, p, name) {
    if (name === "program.out") { writing = true; await hold.promise; }
    return h.write(b, o, n, p);
  } } }); hold = f.hold(); const owner = f.create(); const running = owner.run({ observedUtc });
  await until(() => writing); f.deny(); await until(() => owner.snapshot().revoked);
  const partial = owner.snapshot(); assert.equal(partial.firstFailure, "ACQ_ATTEMPT_GATE");
  assert.equal(partial.capture.files.program.channels.stdout.confirmedBytes, 0); hold.resolve();
  const end = await running; assert.equal(end.localComplete, false); assert.equal(end.firstFailure, "ACQ_ATTEMPT_GATE");
  assert.deepEqual(await f.original("program.out", bytes.length), bytes);
  assert.equal(end.capture.files.program.channels.stdout.confirmedBytes, bytes.length);
  assert.equal(f.state.finishes, 1); assert(f.fileHandles.every(h => h.closes === 1));
});
