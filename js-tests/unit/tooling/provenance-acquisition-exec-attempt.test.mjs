import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createAcquisitionExecAttempt } from "../../../scripts/provenance-acquisition-exec-attempt.mjs";
import { openAcquisitionCapture } from "../../../scripts/provenance-acquisition-capture.mjs";
import { AcquisitionRecordError, acquisitionSha256 } from "../../../scripts/provenance-acquisition-record.mjs";
import { deferred } from "../../fixtures/provenance-acquisition-host.mjs";
import { fakeExecDaemon, execProfile, inspectBody, jsonReply, upgradeReply,
  wireOutput, output, errors, containerId, execId } from "../../fixtures/provenance-acquisition-exec.mjs";

async function until(predicate) {
  for (let i = 0; i < 400 && !predicate(); i++) await delay(5);
  assert.ok(predicate(), "finite local observation did not arrive");
}

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp("/tmp/tabgrad-exec-attempt-"));
  let attempt; let capture;
  t.after(async () => {
    attempt?.stop();
    if (attempt) await attempt.join();
    if (capture) { capture.stop(); await capture.close(); }
    await rm(root, { recursive: true, force: true });
  });
  const daemon = await fakeExecDaemon(t, root, options.reply);
  const input = await execProfile(root, daemon.socket);
  capture = await openAcquisitionCapture({ ...input.capture, t0MonotonicNs: "100", deadlineNs: input.timing.deadlineNs },
    { clock: () => 101n, ...(options.transfer ? { transfer: options.transfer } : {}) });
  let now = 101n;
  const state = { ready: true, checks: 0, intents: [], revocations: [], writes: 0, eof: 0 };
  const gate = { context: Object.freeze({ operationId: input.operationId, t0MonotonicNs: "100", deadlineNs: input.timing.deadlineNs, root }),
    check() { state.checks++; if (!state.ready) throw new AcquisitionRecordError("EXEC_GATE"); return now; },
    async appendIntent(event) { state.intents.push(event); await options.append?.(); },
    revoke(code) { state.revocations.push(code); state.ready = false; options.revoke?.(code); } };
  const sink = { async write(bytes) { state.writes++; await capture.write(bytes); },
    finish() { state.eof++; return capture.finish(); },
    stop() { assert.fail("borrowed capture stop is not attempt authority"); },
    close() { assert.fail("borrowed capture close is not attempt authority"); } };
  const create = () => { attempt = createAcquisitionExecAttempt(input, { gate, capture: sink, ...(options.request ? { request: options.request } : {}) }); return attempt; };
  return { input, gate, sink, state, daemon, capture, create, now: value => { now = value; },
    prefix: async (role, length) => (await readFile(join(root, `${role}.payload`))).subarray(0, length) };
}

test("borrowed attempt completes the same four phases without startup or global capture closure", async t => {
  const f = await fixture(t); const a = f.create();
  const initial = a.snapshot(); await a.join();
  assert.equal(f.state.checks, 0); assert.equal(f.daemon.requests.length, 0);
  f.input.command.argv[0] = "/mutated"; f.input.command.env[0] = "MUTATED=yes";
  f.input.socket.path = "/mutated"; f.input.limits.controlBytes = 1;
  f.gate.check = () => assert.fail("port replacement after creation");
  const run = a.run(); assert.equal(a.run(), run);
  const s = await run; await a.join();
  assert.equal(s.protocolComplete, true); assert.equal(s.firstFailure, null); assert.equal(s.workPending, false);
  assert.equal(f.state.ready, true); assert.deepEqual(f.state.revocations, []);
  assert.equal(f.state.eof, 1); assert.equal(f.capture.snapshot().ioClosed, "open");
  assert.deepEqual(f.daemon.requests.map(r => [r.method, r.route]), [
    ["POST", `/v1.56/containers/${containerId}/exec`], ["GET", `/v1.56/exec/${execId}/json`],
    ["POST", `/v1.56/exec/${execId}/start`], ["GET", `/v1.56/exec/${execId}/json`] ]);
  const body = f.daemon.requests[0].body;
  assert.deepEqual(JSON.parse(body).Cmd, ["/usr/bin/fixture", "--finite"]);
  assert.deepEqual(f.state.intents, [{ phase: "acquire", kind: "transition", subject: "client", code: "begun",
    reference: acquisitionSha256(body), value: null }]);
  assert.deepEqual(await f.prefix("stdout", 3), output); assert.deepEqual(await f.prefix("stderr", 2), errors);
  assert.equal(initial.createState, "not_requested"); assert.ok(Object.isFrozen(s)); assert.ok(Object.isFrozen(s.transport));
  assert.equal(s.payloadOrigin, "unqualified"); assert.equal(s.releaseAdmission, "unqualified");
});

test("closed gate/context rejects before callbacks or HTTP, without requiring a startup facade", async t => {
  for (const mutate of [
    f => { f.gate.start = () => assert.fail(); },
    f => { f.gate.context = { ...f.gate.context, operationId: "2".repeat(32) }; },
    f => { f.gate.context = { ...f.gate.context, root: "/elsewhere" }; },
    f => { f.gate.context = { ...f.gate.context, t0MonotonicNs: "99" }; },
    f => { f.gate.context = { ...f.gate.context, deadlineNs: "1" }; },
    f => { f.gate.appendIntent = undefined; },
    f => { Object.defineProperty(f.gate, "check", { enumerable: true, get() { assert.fail("accessor invoked"); } }); },
    f => { f.sink.finish = undefined; },
  ]) {
    const f = await fixture(t); mutate(f);
    assert.throws(f.create, { code: "EXEC_INPUT" });
    assert.equal(f.state.checks, 0); assert.equal(f.state.intents.length, 0); assert.equal(f.daemon.requests.length, 0);
  }
});

test("permission denial and rejected intent leave zero daemon effects and notify once", async t => {
  for (const kind of ["denied", "rejected"]) {
    const f = await fixture(t, { append: kind === "rejected" ? () => { throw Error("private"); } : undefined });
    if (kind === "denied") f.state.ready = false;
    const a = f.create(); const s = await a.run(); a.stop(); await a.join();
    const code = kind === "denied" ? "EXEC_GATE" : "EXEC_PROTOCOL";
    assert.equal(s.firstFailure, code); assert.equal(s.protocolComplete, false);
    assert.deepEqual(f.state.revocations, [code]); assert.equal(f.daemon.requests.length, 0);
    assert.equal(f.capture.snapshot().ioClosed, "open");
  }
});

test("stop before run and while ACK is held never await or replay borrowed work", async t => {
  for (const begun of [false, true]) {
    const held = deferred(); const f = await fixture(t, { append: () => held.promise }); const a = f.create();
    const run = begun ? a.run() : null;
    if (begun) await until(() => f.state.intents.length === 1);
    a.stop(); a.stop(); const s = await (run ?? a.run()); await a.join();
    assert.equal(s.firstFailure, "EXEC_STOPPED"); assert.equal(s.workPending, begun);
    assert.equal(f.state.revocations.length, 1); assert.equal(f.daemon.requests.length, 0);
    assert.equal(f.state.eof, 0); assert.equal(f.capture.snapshot().ioClosed, "open");
    held.resolve(); await until(() => !a.snapshot().workPending);
    assert.equal(f.daemon.requests.length, 0); assert.equal(a.run(), run ?? a.run());
  }
});

test("each pending HTTP phase stops once, preserving identity and confirmed prefixes", async t => {
  for (const phase of [0, 1, 2, 3]) {
    const f = await fixture(t, { reply(r) { return r.index === phase; } }); const a = f.create();
    const run = a.run(); await until(() => f.daemon.requests.length === phase + 1);
    a.stop(); a.stop(); const s = await run; await a.join();
    assert.equal(s.firstFailure, "EXEC_STOPPED"); assert.equal(s.protocolComplete, false);
    assert.equal(s.execId, phase ? execId : null); assert.equal(f.daemon.requests.length, phase + 1);
    assert.equal(f.capture.snapshot().channels.stdout.confirmedBytes, phase === 3 ? output.length : 0);
    assert.equal(f.state.revocations.length, 1); assert.equal(a.snapshot().transportClosed, true);
  }
});

test("borrowed framing EOF must pass before the after-inspect request", async t => {
  const f = await fixture(t, { reply(r) { if (r.index === 2) { upgradeReply(r.socket, wireOutput.subarray(0, 6), 0); return true; } } });
  const s = await f.create().run();
  assert.equal(s.firstFailure, "EXEC_PROTOCOL"); assert.equal(f.state.eof, 1);
  assert.equal(f.daemon.requests.length, 3); assert.equal(s.after, null); assert.equal(s.startState, "unknown");
  assert.equal(f.capture.snapshot().firstError, "CAPTURE_TRUNCATED");
});

test("one accepted clock enforces independent operation and process cutoffs, invalidity and regression", async t => {
  for (const [value, phase, code, budget] of [[100n, 0, "EXEC_CLOCK"], ["invalid", 0, "EXEC_CLOCK"],
    [5000000100n, 0, "EXEC_DEADLINE"], [5000000101n, 0, "EXEC_DEADLINE"],
    [1101n, 2, "EXEC_DEADLINE", "1000"]]) {
    let f;
    f = await fixture(t, { reply(r) { if (r.index === phase) f.now(value); } });
    if (budget) f.input.timing.processBudgetNs = budget;
    const s = await f.create().run();
    assert.equal(s.firstFailure, code); assert.equal(f.daemon.requests.length, phase + 1);
    assert.equal(s.protocolComplete, false); assert.equal(f.state.revocations.length, 1);
  }
  let f;
  f = await fixture(t, { reply(r) { if (r.index === 0) f.now(500n); if (r.index === 1) f.now(400n); } });
  assert.equal((await f.create().run()).firstFailure, "EXEC_CLOCK");
});

test("poll revokes an idle pending attempt on permission loss or the original cutoff", async t => {
  for (const kind of ["gate", "time"]) {
    const f = await fixture(t, { reply() { return true; } }); const a = f.create(); const run = a.run();
    await until(() => f.daemon.requests.length === 1);
    if (kind === "gate") f.state.ready = false; else f.now(5000000100n);
    const s = await run;
    assert.equal(s.firstFailure, kind === "gate" ? "EXEC_GATE" : "EXEC_DEADLINE");
    assert.equal(f.daemon.requests.length, 1);
  }
});

test("held borrowed write survives local stop as pending, without a later inspect or repeated write", async t => {
  const held = deferred(); let entered = false;
  const f = await fixture(t, { transfer: { async write(h, ...args) { entered = true; await held.promise; return h.write(...args); } } });
  const a = f.create(); const run = a.run(); await until(() => entered);
  a.stop(); const s = await run; await a.join();
  assert.equal(s.workPending, true); assert.equal(f.capture.snapshot().channels.stdout.confirmedBytes, 0);
  const writes = f.state.writes;
  held.resolve(); await until(() => !a.snapshot().workPending);
  assert.ok(f.capture.snapshot().channels.stdout.confirmedBytes > 0);
  assert.equal(f.state.writes, writes); assert.equal(f.daemon.requests.length, 3);
  assert.equal(s.workPending, true); assert.equal(a.snapshot().firstFailure, "EXEC_STOPPED");
});

test("late daemon response can invalidate prior known-handle closure without rewriting the snapshot", async t => {
  for (const event of ["response", "upgrade"]) {
    let request; let destroys = 0;
    const f = await fixture(t, { request() {
      request = new EventEmitter(); request.end = () => {};
      request.destroy = () => { request.emit("close"); }; return request;
    } });
    const a = f.create(); const run = a.run(); await until(() => request);
    a.stop(); await run; await a.join(); const prior = a.snapshot();
    const stream = new PassThrough(); stream.destroy = () => { destroys++; return stream; };
    request.emit(event, stream, stream, Buffer.alloc(0));
    assert.equal(prior.transportClosed, true); assert.equal(a.snapshot().transportClosed, false); assert.equal(destroys, 1);
    stream.emit("close"); await a.join(); assert.equal(a.snapshot().transportClosed, true);
    assert.equal(a.snapshot().firstFailure, "EXEC_STOPPED");
  }
});

test("reported nonzero exit is protocol data; failed parent notification remains explicit", async t => {
  const f = await fixture(t, { reply(r) { if (r.index === 3) { jsonReply(r.socket, inspectBody(false, { ExitCode: 7 })); return true; } } });
  const s = await f.create().run();
  assert.equal(s.protocolComplete, true); assert.equal(s.after.reportedExitCode, 7); assert.equal(f.state.ready, true);
  const g = await fixture(t, { revoke() { throw Error("private callback"); } });
  g.state.ready = false; const failed = await g.create().run();
  assert.equal(failed.firstFailure, "EXEC_GATE"); assert.equal(failed.revocationError, "EXEC_GATE");
  assert.equal(g.daemon.requests.length, 0); assert.equal(failed.externalClosure, "unqualified");
});

test("a synchronous intent callback can repeat run without creating a second attempt", async t => {
  let a; let repeated; let entered = false;
  const f = await fixture(t, { append() { if (!entered) { entered = true; repeated = a.run(); } } });
  a = f.create(); const run = a.run(); const s = await run;
  assert.equal(repeated, run); assert.equal(f.state.intents.length, 1);
  assert.equal(f.daemon.requests.length, 4); assert.equal(s.protocolComplete, true);
});

test("stop inside permission check prevents a later intent or borrowed stream write", async t => {
  for (const phase of ["intent", "stream"]) {
    const f = await fixture(t); let a;
    f.gate.check = () => {
      if (phase === "intent" || f.daemon.requests.length === 3) a.stop();
      return 101n;
    };
    a = f.create(); const s = await a.run(); await a.join();
    assert.equal(s.firstFailure, "EXEC_STOPPED"); assert.equal(s.protocolComplete, false);
    assert.equal(f.state.intents.length, phase === "intent" ? 0 : 1);
    assert.equal(f.daemon.requests.length, phase === "intent" ? 0 : 3);
    assert.equal(f.state.writes, 0); assert.equal(f.state.eof, 0); assert.equal(f.state.revocations.length, 1);
  }
});
