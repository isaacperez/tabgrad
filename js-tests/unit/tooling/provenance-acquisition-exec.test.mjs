import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay, setImmediate as turn } from "node:timers/promises";
import { request as nativeRequest } from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createAcquisitionExec } from "../../../scripts/provenance-acquisition-exec.mjs";
import { acquisitionSha256 } from "../../../scripts/provenance-acquisition-record.mjs";
import { deferred } from "../../fixtures/provenance-acquisition-host.mjs";
import { fakeExecDaemon, execProfile, inspectBody, jsonReply, upgradeReply,
  wireFrame, wireOutput, output, errors, observedUtc, containerId, execId } from "../../fixtures/provenance-acquisition-exec.mjs";

async function until(predicate) {
  for (let i = 0; i < 400 && !predicate(); i++) await delay(5);
  assert.ok(predicate(), "finite local observation did not arrive");
}

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp("/tmp/tabgrad-exec-"));
  let exec;
  const state = { ready: false, starts: 0, stops: 0, ends: 0, events: [] };
  let now = 101n;
  t.after(async () => { if (exec) { exec.stop(); if (!options.abandon) await exec.run({ observedUtc }); } await rm(root, { recursive: true, force: true }); });
  const daemon = await fakeExecDaemon(t, root, options.reply);
  const input = await execProfile(root, daemon.socket);
  const startup = { context: Object.freeze({ operationId: input.operationId, t0MonotonicNs: "100", deadlineNs: input.timing.deadlineNs, root }),
    async start() { state.starts++; await options.start?.(); state.ready = options.deny !== true; return this.snapshot(); },
    supervisor: { async append(event) { state.events.push(event); await options.append?.(); } },
    snapshot() { return { mayStart: state.ready }; },
    stop() { state.ready = false; state.stops++; },
    async finish() { state.ready = false; state.ends++; await options.finish?.();
      return { firstFailure: options.controlFailure ? {} : null, process: { collection: { formatComplete: !options.badRecord } } }; } };
  const create = async () => { exec = await createAcquisitionExec(input, { startup, clock: () => { if (now instanceof Error) throw now; return now; },
    ...(options.request ? { request: options.request } : {}), ...(options.transfer ? { transfer: options.transfer } : {}) }); return exec; };
  return { input, startup, state, daemon, create, now: value => { now = value; },
    prefix: async (role, length) => (await readFile(join(root, `${role}.payload`))).subarray(0, length) };
}

test("one exact local Exec sequence preserves early upgrade bytes and separate original channels", async t => {
  const f = await fixture(t); const e = await f.create();
  f.input.command.argv[0] = "/mutated"; f.input.command.env[0] = "MUTATED=yes";
  f.input.containerId = "b".repeat(64); f.input.socket.path = "/not-the-socket";
  assert.equal(f.daemon.requests.length, 0);
  const running = e.run({ observedUtc }); assert.equal(e.run({ observedUtc }), running);
  const s = await running;
  assert.equal(s.locallyComplete, true); assert.equal(s.firstFailure, null);
  assert.equal(s.after.reportedExitCode, 0); assert.equal(s.after.pid, 421);
  assert.deepEqual(f.daemon.requests.map(r => [r.method, r.route]), [
    ["POST", `/v1.56/containers/${containerId}/exec`], ["GET", `/v1.56/exec/${execId}/json`],
    ["POST", `/v1.56/exec/${execId}/start`], ["GET", `/v1.56/exec/${execId}/json`] ]);
  assert.deepEqual(JSON.parse(f.daemon.requests[0].body), { AttachStdin: false, AttachStdout: true, AttachStderr: true,
    Tty: false, Privileged: false, Cmd: ["/usr/bin/fixture", "--finite"], Env: ["FIXTURE=finite"], User: "1000:1000", WorkingDir: "/work" });
  assert.deepEqual(JSON.parse(f.daemon.requests[2].body), { Detach: false, Tty: false });
  assert.match(f.daemon.requests[2].headers, /Connection: Upgrade\r\nUpgrade: tcp/);
  assert.deepEqual(await f.prefix("stdout", 3), output); assert.deepEqual(await f.prefix("stderr", 2), errors);
  assert.equal(s.capture.channels.stdout.sha256, acquisitionSha256(output));
  assert.equal(s.capture.channels.stderr.sha256, acquisitionSha256(errors));
  assert.equal(f.state.events.length, 1); assert.equal(f.state.events[0].subject, "client");
  assert.equal(s.payloadOrigin, "unqualified"); assert.equal(s.externalClosure, "unqualified");
  assert.equal(s.releaseAdmission, "unqualified");
  assert.equal(Object.keys(s.transport).length, 4); assert.equal(s.transportClosed, true);
});

test("daemon diagnostics remain exact raw channel bytes even with reported zero exit", async t => {
  const diagnostic = Buffer.from("exec attach failed: synthetic\r\n");
  const f = await fixture(t, { reply(r) { if (r.index === 2) { upgradeReply(r.socket, wireFrame(1, diagnostic), 11); return true; } } });
  const s = await (await f.create()).run({ observedUtc });
  assert.equal(s.locallyComplete, true); assert.equal(s.after.reportedExitCode, 0);
  assert.deepEqual(await f.prefix("stdout", diagnostic.length), diagnostic);
  assert.equal(s.capture.channels.stdout.sha256, acquisitionSha256(diagnostic));
  assert.equal(s.payloadOrigin, "unqualified"); assert.equal(s.releaseAdmission, "unqualified");
});

test("missing readiness and failed intent prevent every daemon effect", async t => {
  for (const opts of [{ deny: true }, { append: async () => { throw Error("private detail"); } }]) {
    const f = await fixture(t, opts); const s = await (await f.create()).run({ observedUtc });
    assert.equal(s.locallyComplete, false); assert.equal(f.daemon.requests.length, 0);
    assert.ok(["EXEC_GATE", "EXEC_PROTOCOL"].includes(s.firstFailure)); assert.equal(f.state.stops, 1);
  }
});

test("metadata rejects wrong identities, prior execution, duplicate keys and invalid UTF8 before start", async t => {
  const cases = [
    { phase: 0, body: Buffer.from('{"Id":"' + execId + '","\\u0049d":"' + execId + '"}') },
    { phase: 0, body: Buffer.from([123, 34, 73, 100, 34, 58, 34, 255, 34, 125]) },
    ...[{ ID: "a".repeat(64) }, { ContainerID: "a".repeat(64) }, { Running: true }, { ExitCode: 0 }, { Pid: 5 },
      { OpenStdin: true }, { ProcessConfig: { ...inspectBody(true).ProcessConfig, tty: true } }]
      .map(body => ({ phase: 1, body: inspectBody(true, body) })),
  ];
  for (const c of cases) {
    const f = await fixture(t, { reply(r) { if (r.index === c.phase) { jsonReply(r.socket, c.body, c.phase ? 200 : 201); return true; } } });
    const s = await (await f.create()).run({ observedUtc });
    assert.equal(s.locallyComplete, false); assert.ok(["EXEC_PROTOCOL", "EXEC_IDENTITY"].includes(s.firstFailure));
    assert.equal(f.daemon.requests.length, c.phase + 1); assert.equal(s.startState, "not_requested");
    assert.equal(s.capture.channels.stdout.confirmedBytes, 0);
  }
});

test("control body/header budgets and HTTP redirects or malformed replies never reach payload files", async t => {
  for (const response of [
    Buffer.from('HTTP/1.1 302 redirect\r\nContent-Type: application/json\r\nContent-Length: 0\r\n\r\n'),
    Buffer.from('HTTP/1.1 201 created\r\nContent-Type: application/json\r\nX-Large: ' + "x".repeat(2048) + '\r\n\r\n'),
    Buffer.from('HTTP/1.1 201 created\r\nContent-Type: application/json\r\nContent-Length: 3000\r\n\r\n' + "x".repeat(3000)),
    Buffer.from('HTTP/1.1 201 created\r\nContent-Type: application/json\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}'),
    Buffer.from('HTTP/1.1 201 created\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{}'),
  ]) {
    const f = await fixture(t, { reply(r) { r.socket.end(response); return true; } });
    const s = await (await f.create()).run({ observedUtc });
    assert.equal(s.locallyComplete, false); assert.equal(f.daemon.requests.length, 1);
    assert.equal(s.capture.channels.stdout.confirmedBytes, 0); assert.equal(s.createState, "unknown");
  }
});

test("unexpected upgrade, partial frames and excess announced payload preserve failure without retries", async t => {
  const over = Buffer.from([1, 0, 0, 0, 0, 16, 0, 1]);
  for (const c of [{ contentType: "application/vnd.docker.raw-stream" },
    { payload: wireOutput.subarray(0, 6) }, { payload: Buffer.concat([wireFrame(1, output), wireFrame(2, errors).subarray(0, 9)]) },
    { payload: over }, { raw: true }]) {
    const f = await fixture(t, { reply(r) {
      if (r.index !== 2) return;
      if (c.raw) r.socket.end('HTTP/1.1 200 OK\r\nContent-Type: application/vnd.docker.raw-stream\r\n\r\n');
      else upgradeReply(r.socket, c.payload ?? wireOutput, 9, c.contentType);
      return true;
    } });
    const s = await (await f.create()).run({ observedUtc });
    assert.equal(s.locallyComplete, false); assert.equal(f.daemon.requests.length, 3);
    assert.equal(s.payloadOrigin, "unqualified"); assert.ok(s.firstFailure);
  }
});

test("stream EOF and reported process state remain independent observations", async t => {
  for (const after of [{ Running: true }, { Pid: 0 }, { ExitCode: null }]) {
    const f = await fixture(t, { reply(r) { if (r.index === 3) { jsonReply(r.socket, inspectBody(false, after)); return true; } } });
    const s = await (await f.create()).run({ observedUtc });
    assert.equal(s.locallyComplete, false); assert.equal(s.startState, "stream_ended");
    assert.equal(s.capture.state, "complete"); assert.equal(s.after, null); assert.equal(s.firstFailure, "EXEC_PROTOCOL");
    assert.equal(s.externalClosure, "unqualified");
  }
});

test("a pending create is cancelled once and cannot be retried by repeated run", async t => {
  const f = await fixture(t, { reply() { return true; } }); const e = await f.create();
  const run = e.run({ observedUtc }); await until(() => f.daemon.requests.length === 1);
  e.stop(); e.stop(); assert.equal(e.run({ observedUtc }), run);
  const s = await run;
  assert.equal(s.firstFailure, "EXEC_STOPPED"); assert.equal(s.createState, "unknown");
  assert.equal(f.daemon.requests.length, 1); assert.equal(f.state.stops, 1); assert.equal(s.transportClosed, true);
});

test("loss of gate during pending start stops without a second effect", async t => {
  const f = await fixture(t, { reply(r) { return r.index === 2; } }); const e = await f.create();
  const run = e.run({ observedUtc }); await until(() => f.daemon.requests.length === 3);
  f.state.ready = false;
  const s = await run;
  assert.equal(s.firstFailure, "EXEC_GATE"); assert.equal(s.startState, "unknown");
  assert.equal(f.daemon.requests.length, 3); assert.equal(s.capture.channels.stdout.confirmedBytes, 0);
});

test("stop during either inspect keeps known identity/prefixes and launches no later phase", async t => {
  for (const phase of [1, 3]) {
    const f = await fixture(t, { reply(r) { return r.index === phase; } }); const e = await f.create();
    const run = e.run({ observedUtc }); await until(() => f.daemon.requests.length === phase + 1);
    e.stop(); const s = await run;
    assert.equal(s.firstFailure, "EXEC_STOPPED"); assert.equal(s.execId, execId);
    assert.equal(f.daemon.requests.length, phase + 1); assert.equal(s.after, null);
    assert.equal(s.capture.channels.stdout.confirmedBytes, phase === 3 ? output.length : 0);
    assert.equal(s.locallyComplete, false); assert.equal(s.releaseAdmission, "unqualified");
  }
});

test("exact metadata byte budget and nonzero reported exit do not imply admission", async t => {
  let f;
  f = await fixture(t, { reply(r) {
    if (r.index === 0) {
      const json = JSON.stringify({ Id: execId });
      jsonReply(r.socket, Buffer.from(json + " ".repeat(2048 - json.length)), 201); return true;
    }
    if (r.index === 3) { jsonReply(r.socket, inspectBody(false, { ExitCode: 2, CanRemove: true })); return true; }
  } });
  const e = await f.create(); f.input.limits.controlBytes = 1;
  const s = await e.run({ observedUtc });
  assert.equal(s.locallyComplete, true); assert.equal(s.after.reportedExitCode, 2); assert.equal(s.releaseAdmission, "unqualified");
});

test("cleanup failure and original absolute cutoff retain incomplete observations", async t => {
  const f = await fixture(t, { controlFailure: true });
  const s = await (await f.create()).run({ observedUtc });
  assert.equal(s.cleanupError, "EXEC_CLEANUP"); assert.equal(s.locallyComplete, false);
  const missing = await fixture(t, { badRecord: true });
  const record = await (await missing.create()).run({ observedUtc });
  assert.equal(record.controls.firstFailure, null); assert.equal(record.cleanupError, "EXEC_CLEANUP");
  assert.equal(record.locallyComplete, false);
  let g;
  g = await fixture(t, { reply(r) { if (r.index === 0) { g.now(5000000100n); return true; } } });
  const p = await (await g.create()).run({ observedUtc });
  assert.equal(p.firstFailure, "EXEC_DEADLINE"); assert.equal(p.createState, "unknown");
  assert.equal(g.daemon.requests.length, 1); assert.equal(p.locallyComplete, false);
});

test("regression above origin and process allowance use the original observed clock", async t => {
  let f;
  f = await fixture(t, { reply(r) { if (r.index === 0) f.now(500n); if (r.index === 1) f.now(400n); } });
  const s = await (await f.create()).run({ observedUtc });
  assert.equal(s.firstFailure, "EXEC_CLOCK"); assert.equal(f.daemon.requests.length, 2);
  let g;
  g = await fixture(t, { reply(r) { if (r.index === 2) g.now(1101n); } });
  g.input.timing.processBudgetNs = "1000";
  const p = await (await g.create()).run({ observedUtc });
  assert.equal(p.firstFailure, "EXEC_DEADLINE"); assert.equal(g.daemon.requests.length, 3);
  assert.equal(p.capture.channels.stdout.confirmedBytes, 0);
});

test("the clock sample accepted by file opening governs the first daemon effect too", async t => {
  const f = await fixture(t); const e = await f.create();
  f.now(100n);
  const s = await e.run({ observedUtc });
  assert.equal(s.firstFailure, "EXEC_CLOCK"); assert.equal(f.daemon.requests.length, 0);
  assert.equal(s.locallyComplete, false);
});

test("late control closure preserves facts but cannot upgrade an expired cleanup wait", async t => {
  const held = deferred();
  const f = await fixture(t, { finish: () => held.promise }); f.input.timing.closeWaitMs = 5;
  const e = await f.create(); const s = await e.run({ observedUtc });
  assert.equal(s.locallyComplete, false); assert.equal(s.controlsClosePending, true);
  held.resolve(); await until(() => !e.snapshot().controlsClosePending);
  assert.equal(e.snapshot().locallyComplete, false); assert.equal(s.controlsClosePending, true);
});

test("cleanup reobserves the original clock after awaited closure without losing reports or the first failure", async t => {
  for (const [now, code] of [[5000000100n, "EXEC_DEADLINE"], [5000000101n, "EXEC_DEADLINE"],
    [100n, "EXEC_CLOCK"], ["invalid", "EXEC_CLOCK"], [Error("controlled clock"), "EXEC_CLOCK"]]) {
    let f;
    f = await fixture(t, { finish: () => { f.now(now); } });
    const s = await (await f.create()).run({ observedUtc });
    assert.equal(s.firstFailure, code); assert.equal(s.locallyComplete, false);
    assert.equal(s.after.reportedExitCode, 0); assert.equal(s.capture.ioClosed, "closed");
    assert.equal(s.controls.process.collection.formatComplete, true);
  }
  let f;
  f = await fixture(t, { reply() { return true; }, finish: () => { f.now(5000000100n); } });
  const e = await f.create(); const run = e.run({ observedUtc });
  await until(() => f.daemon.requests.length === 1); e.stop();
  const s = await run;
  assert.equal(s.firstFailure, "EXEC_STOPPED"); assert.equal(s.locallyComplete, false);
  assert.equal(s.controls.process.collection.formatComplete, true);
});

test("stop before run disposes owned files once without starting controls or HTTP", async t => {
  for (const outcome of ["closed", "pending", "failed"]) {
    const held = deferred(); const handles = [];
    const f = await fixture(t, { abandon: true, transfer: { write: (h, ...args) => h.write(...args),
      async close(h) { handles.push(h); if (outcome === "pending") await held.promise;
        await h.close(); if (outcome === "failed") throw Error("controlled close"); } } });
    const e = await f.create(); const initial = e.stop(); e.stop();
    await until(() => handles.length === 2);
    assert.equal(initial.firstFailure, "EXEC_STOPPED");
    assert.equal(f.state.starts, 0); assert.equal(f.state.ends, 0); assert.equal(f.state.stops, 1);
    assert.equal(f.daemon.requests.length, 0); assert.equal(e.snapshot().locallyComplete, false);
    if (outcome === "pending") {
      assert.equal(e.snapshot().captureClosePending, true); assert.equal(e.snapshot().capture.ioClosed, "pending");
      held.resolve();
    }
    await until(() => !e.snapshot().captureClosePending);
    assert.equal(e.snapshot().capture.ioClosed, outcome === "failed" ? "unknown" : "closed");
    for (const h of handles) await assert.rejects(h.stat(), { code: "EBADF" });
    e.stop(); assert.equal(handles.length, 2); assert.equal(f.state.starts, 0);
  }
});

test("responses arriving after cancellation retain their own close uncertainty", async t => {
  for (const event of ["response", "upgrade"]) for (const throwDestroy of [false, true]) {
    let request; let requestCloses = 0; let streamDestroys = 0;
    const f = await fixture(t, { request() {
      request = new EventEmitter(); request.end = () => {};
      request.destroy = () => { requestCloses++; request.emit("close"); };
      return request;
    } });
    const e = await f.create(); const run = e.run({ observedUtc }); await until(() => request);
    e.stop(); const prior = await run;
    assert.equal(prior.transportClosed, true); assert.equal(prior.firstFailure, "EXEC_STOPPED");
    const stream = new PassThrough();
    stream.destroy = () => { streamDestroys++; if (throwDestroy) throw Error("controlled destroy"); return stream; };
    request.emit(event, stream, stream, Buffer.alloc(0));
    const late = e.snapshot();
    assert.equal(late.transport.create.responseObserved, true); assert.equal(late.transportClosed, false);
    assert.equal(late.transport.create.streamClosed, false); assert.equal(streamDestroys, 1);
    if (throwDestroy) assert.equal(late.transport.create.cleanupError, "EXEC_CLEANUP");
    assert.equal(prior.transportClosed, true); assert.equal(late.locallyComplete, false);
    stream.emit("close");
    assert.equal(e.snapshot().transportClosed, true); assert.equal(e.snapshot().firstFailure, "EXEC_STOPPED");
    assert.equal(requestCloses, 1); assert.equal(f.daemon.requests.length, 0);
  }
});

test("stop never waits behind a payload write; late effects retain the prefix without reopening", async t => {
  const held = deferred(); let entered = false;
  const f = await fixture(t, { transfer: { async write(h, b, o, l, p) { entered = true; await held.promise; return h.write(b, o, l, p); } } });
  f.input.timing.closeWaitMs = 10;
  const e = await f.create(); const run = e.run({ observedUtc }); await until(() => entered);
  e.stop(); assert.equal(f.state.stops, 1);
  const s = await run;
  assert.equal(s.workPending, true); assert.equal(s.captureClosePending, true); assert.equal(s.locallyComplete, false);
  assert.equal(s.capture.channels.stdout.confirmedBytes, 0);
  held.resolve(); await until(() => !e.snapshot().workPending && !e.snapshot().captureClosePending);
  const late = e.snapshot(); assert.equal(late.firstFailure, "EXEC_STOPPED"); assert.equal(late.locallyComplete, false);
  assert.ok(late.capture.channels.stdout.confirmedBytes > 0); assert.equal(f.daemon.requests.length, 3);
  assert.equal(s.capture.channels.stdout.confirmedBytes, 0);
});

test("unobserved request close and failed file close cannot become local completion", async t => {
  const f = await fixture(t, { request(opts) {
    const req = nativeRequest(opts); const emit = req.emit;
    if (opts.method === "GET") req.emit = function(event, ...args) { return event === "close" ? false : emit.call(this, event, ...args); };
    return req;
  } });
  f.input.timing.closeWaitMs = 5;
  const s = await (await f.create()).run({ observedUtc });
  assert.equal(s.after.reportedExitCode, 0); assert.equal(s.capture.state, "complete");
  assert.equal(s.transportClosed, false); assert.equal(s.locallyComplete, false);
  const g = await fixture(t, { transfer: { write: (h, ...args) => h.write(...args), async close(h) { await h.close(); throw Error("controlled"); } } });
  const p = await (await g.create()).run({ observedUtc });
  assert.equal(p.capture.ioClosed, "unknown"); assert.equal(p.locallyComplete, false);
  assert.equal(p.capture.channels.stdout.closeError, "CLOSE_FAILED");
});

test("closed input rejects accessors, sparse commands, mismatched context and socket identity", async t => {
  for (const mutate of [
    x => { Object.defineProperty(x.command, "user", { enumerable: true, get() { throw Error("invoked accessor"); } }); },
    x => { x.command.argv = new Array(2); }, x => { x.operationId = "2".repeat(32); },
    x => { x.timing.t0MonotonicNs = "99"; }, x => { x.command.env = ["A=1", "A=2"]; },
  ]) {
    const f = await fixture(t); mutate(f.input);
    await assert.rejects(f.create, { code: "EXEC_INPUT" }); assert.equal(f.daemon.requests.length, 0);
  }
  const f = await fixture(t); f.input.socket.identity = { ...f.input.socket.identity, ino: "1" };
  const s = await (await f.create()).run({ observedUtc });
  assert.equal(s.firstFailure, "EXEC_IDENTITY"); assert.equal(f.daemon.requests.length, 0);
});

test("independent wire partitions and payload sizes preserve both channel prefixes", async t => {
  for (const size of [0, 1, 4097]) for (const split of [0, 7, 19]) {
    const payload = Buffer.alloc(size, 201); const wire = Buffer.concat([wireFrame(2, errors), wireFrame(1, payload)]);
    const f = await fixture(t, { reply(r) { if (r.index === 2) { upgradeReply(r.socket, wire, split); return true; } } });
    const s = await (await f.create()).run({ observedUtc });
    assert.equal(s.locallyComplete, true); assert.equal(s.capture.channels.stdout.confirmedBytes, size);
    assert.equal(s.capture.channels.stdout.sha256, acquisitionSha256(payload));
    assert.deepEqual(await f.prefix("stdout", size), payload); assert.deepEqual(await f.prefix("stderr", 2), errors);
    await turn();
  }
});

test("profile validation preserves startup getter order and copies command before final scalar fields", async t => {
  const invalid = await fixture(t);
  Object.defineProperty(invalid.startup, "context", { get() { assert.fail("invalid data must reject first"); } });
  invalid.input.command.argv = new Array(2);
  await assert.rejects(invalid.create, { code: "EXEC_INPUT" });
  const f = await fixture(t); const observations = [];
  for (const name of ["context", "start", "stop", "finish", "snapshot", "supervisor"]) {
    const value = f.startup[name];
    Object.defineProperty(f.startup, name, { get() {
      observations.push(name);
      if (name === "context") {
        f.input.command.argv[0] = "/changed"; f.input.command.user = "changed"; f.input.containerId = "b".repeat(64);
      }
      return value;
    } });
  }
  const e = await f.create();
  assert.deepEqual(observations, ["context", "start", "stop", "finish", "snapshot", "supervisor"]);
  const s = await e.run({ observedUtc });
  assert.equal(s.firstFailure, "EXEC_IDENTITY");
  assert.equal(f.daemon.requests[0].route, `/v1.56/containers/${"b".repeat(64)}/exec`);
  assert.deepEqual(JSON.parse(f.daemon.requests[0].body).Cmd, ["/usr/bin/fixture", "--finite"]);
  assert.equal(JSON.parse(f.daemon.requests[0].body).User, "1000:1000");
});

test("stopping a held startup or intent does not make cleanup wait for borrowed work", async t => {
  for (const phase of ["start", "append"]) {
    const held = deferred(); let entered = false;
    const f = await fixture(t, { [phase]: () => { entered = true; return held.promise; } });
    f.input.timing.closeWaitMs = 100;
    const e = await f.create(); const run = e.run({ observedUtc }); await until(() => entered);
    e.stop(); const s = await run;
    assert.equal(s.workPending, true); assert.equal(s.captureClosePending, false);
    assert.equal(s.cleanupWaitExpired, false); assert.equal(s.cleanupError, null);
    assert.equal(f.state.ends, 1); assert.equal(f.daemon.requests.length, 0);
    held.resolve(); await until(() => !e.snapshot().workPending);
    assert.equal(f.daemon.requests.length, 0); assert.equal(f.state.ends, 1);
  }
});

test("HTTP abort callbacks still observe capture revocation before control notification", async t => {
  let e; let f; let request; let aborts = 0; let observed;
  f = await fixture(t, { request() {
    request = new EventEmitter(); request.end = () => {};
    request.destroy = () => {
      aborts++; const capture = e.snapshot().capture;
      observed = { capture: capture.state, firstError: capture.firstError, controlStops: f.state.stops };
      request.emit("close");
    };
    return request;
  } });
  e = await f.create(); const run = e.run({ observedUtc }); await until(() => request);
  f.state.ready = false;
  const s = await run;
  assert.equal(s.firstFailure, "EXEC_GATE"); assert.equal(aborts, 1); assert.equal(f.state.stops, 1);
  assert.deepEqual(observed, { capture: "incomplete", firstError: "CAPTURE_STOPPED", controlStops: 0 });
});

for (const phase of ["factory", "listeners", "end"]) for (const close of ["closed", "held", "throws"]) {
  test(`stop during request ${phase} adopts the handle and preserves ${close} closure`, async t => {
    let e; let request; let ends = 0; let destroys = 0;
    const f = await fixture(t, { request() {
      request = new EventEmitter();
      request.end = () => { ends++; if (phase === "end") e.stop(); };
      request.destroy = () => {
        destroys++;
        if (close === "throws") throw Error("synthetic close failure");
        if (close === "closed") request.emit("close");
      };
      if (phase === "listeners") request.on("newListener", name => { if (name === "response") e.stop(); });
      if (phase === "factory") e.stop();
      return request;
    } });
    e = await f.create(); const s = await e.run({ observedUtc });
    assert.equal(s.firstFailure, "EXEC_STOPPED");
    assert.equal(ends, phase === "end" ? 1 : 0);
    assert.equal(destroys, 1);
    assert.equal(f.daemon.requests.length, 0);
    assert.equal(s.transport.create.requestClosed, close === "closed");
    assert.equal(s.transport.create.cleanupError, close === "throws" ? "EXEC_CLEANUP" : null);
    e.stop(); e.stop(); assert.equal(destroys, 1);
    if (close !== "closed") request.emit("close");
    assert.equal(e.snapshot().transport.create.requestClosed, true);
    assert.equal(s.transport.create.requestClosed, close === "closed");
    assert.equal(e.snapshot().firstFailure, "EXEC_STOPPED");
  });
}

test("expired process allowance precedes lost readiness on the same observation", async t => {
  let f;
  f = await fixture(t, { reply(r) { if (r.index === 2) { f.now(1101n); f.state.ready = false; } } });
  f.input.timing.processBudgetNs = "1000";
  const s = await (await f.create()).run({ observedUtc });
  assert.equal(s.firstFailure, "EXEC_DEADLINE");
  assert.equal(f.daemon.requests.length, 3); assert.equal(s.capture.channels.stdout.confirmedBytes, 0);
});
