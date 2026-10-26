import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { request as nativeRequest } from "node:http";
import { createAcquisitionActivation } from "../../../scripts/provenance-acquisition-activation.mjs";
import { acquisitionSha256 } from "../../../scripts/provenance-acquisition-record.mjs";
import { deferred } from "../../fixtures/provenance-acquisition-host.mjs";
import { fakeExecDaemon, containerId } from "../../fixtures/provenance-acquisition-exec.mjs";

async function until(predicate) {
  for (let i = 0; i < 400 && !predicate(); i++) await delay(5);
  assert.ok(predicate(), "finite fixture observation did not arrive");
}

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp("/tmp/tabgrad-activation-")); let activation;
  t.after(async () => { activation?.stop(); if (activation) await activation.run(); await rm(root, { recursive: true, force: true }); });
  const daemon = await fakeExecDaemon(t, root, r => {
    if (options.reply?.(r) !== true) r.socket.end("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
    return true;
  });
  const context = { operationId: "1".repeat(32), t0MonotonicNs: "100", deadlineNs: "5000000000", root };
  const input = { context, socket: daemon.socket, containerId, preparedContainerSha256: "a".repeat(64), pollMs: 5,
    limits: { headerBytes: 1024 } };
  let now = 101n;
  const state = { checks: 0, ready: true, intents: [], revocations: [] };
  const gate = { context: { ...context },
    check() { state.checks++; if (!state.ready) throw Error("private permission error"); return now; },
    async appendIntent(event) { state.intents.push(event); await options.append?.(); },
    revoke(code) { state.revocations.push(code); state.ready = false; options.revoke?.(); } };
  return { input, state, gate, daemon, now(value) { now = value; },
    create() { activation = createAcquisitionActivation(input, { gate, ...(options.request ? { request: options.request } : {}) }); return activation; } };
}

test("one literal bodyless Start follows acknowledged intent and retains unknown native effect", async t => {
  const f = await fixture(t); const a = f.create(); const before = a.snapshot(); await a.join();
  assert.equal(f.state.checks, 0); assert.equal(f.daemon.requests.length, 0);
  f.input.context.root = "/changed"; f.input.socket.path = "/changed"; f.input.containerId = "b".repeat(64);
  f.input.limits.headerBytes = 1; f.gate.check = () => assert.fail("callback replacement");
  const run = a.run(); assert.equal(a.run(), run); const s = await run; await a.join();
  assert.equal(s.protocolComplete, true); assert.equal(s.firstFailure, null); assert.equal(s.statusCode, 204);
  assert.equal(s.intentState, "acknowledged"); assert.equal(s.requestState, "response_observed");
  assert.equal(s.effectState, "unknown"); assert.equal(s.observedBodyBytes, 0); assert.equal(s.workPending, false);
  assert.equal(f.daemon.requests.length, 1); const r = f.daemon.requests[0];
  assert.equal(r.method, "POST"); assert.equal(r.route, `/v1.56/containers/${containerId}/start`); assert.equal(r.body.length, 0);
  assert.match(r.headers, /Content-Length: 0\r\nConnection: close/); assert.doesNotMatch(r.headers, /Authorization|Content-Type/);
  const expected = acquisitionSha256(JSON.stringify({ operationId: "1".repeat(32), containerId, preparedContainerSha256: "a".repeat(64),
    method: "POST", path: `/v1.56/containers/${containerId}/start`, bodySha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }));
  assert.equal(s.intentSha256, expected);
  assert.deepEqual(f.state.intents, [{ phase: "setup", kind: "transition", subject: "group", code: "begun", reference: expected, value: null }]);
  assert.deepEqual(f.state.revocations, []); assert.equal(before.effectState, "not_requested");
  assert.ok(Object.isFrozen(s)); assert.ok(Object.isFrozen(s.context)); assert.ok(Object.isFrozen(s.transport));
  for (const field of ["externalClosure", "clockAdmission", "releaseAdmission"]) assert.equal(s[field], "unqualified");
  a.stop(); assert.equal(a.snapshot().protocolComplete, true); assert.equal(f.state.revocations.length, 0);
});

test("closed input and borrowed gate reject accessors and mismatches before callbacks", async t => {
  for (const mutate of [
    f => { f.input.extra = true; }, f => { f.input.pollMs = 0; }, f => { f.input.pollMs = 5001; },
    f => { f.input.context.deadlineNs = "180000000001"; }, f => { f.input.context.deadlineNs = "0"; },
    f => { f.input.socket.identity = { ...f.input.socket.identity, ino: "0" }; }, f => { f.input.socket.path = "relative"; },
    f => { f.input.containerId = "name"; }, f => { f.input.preparedContainerSha256 = "bad"; },
    f => { f.input.limits.controlBytes = 1; }, f => { f.input.limits.headerBytes = 0; },
    f => { f.gate.context = { ...f.gate.context, root: "/another" }; },
    f => { f.gate.context = { ...f.gate.context, deadlineNs: "4999999999" }; },
    f => { f.gate.start = () => {}; },
    f => { Object.defineProperty(f.input, "context", { enumerable: true, get() { assert.fail("input accessor"); } }); },
    f => { Object.defineProperty(f.gate, "check", { enumerable: true, get() { assert.fail("gate accessor"); } }); },
  ]) {
    const f = await fixture(t); mutate(f); assert.throws(f.create, { code: "ACTIVATION_INPUT" });
    assert.equal(f.state.checks, 0); assert.equal(f.state.intents.length, 0); assert.equal(f.daemon.requests.length, 0);
  }
});

test("acknowledgement is required before a request, including retained and rejected intents", async t => {
  const held = deferred(); const f = await fixture(t, { append: () => held.promise }); const a = f.create();
  const run = a.run(); await until(() => f.state.intents.length === 1);
  assert.equal(f.daemon.requests.length, 0); const prior = a.stop(); a.stop(); const s = await run; await a.join();
  assert.equal(s.workPending, true); assert.equal(s.effectState, "not_requested"); assert.equal(s.intentState, "pending");
  assert.equal(f.state.revocations.length, 1); held.resolve(); await until(() => !a.snapshot().workPending);
  assert.equal(a.snapshot().intentState, "acknowledged"); assert.equal(prior.intentState, "pending");
  assert.equal(f.daemon.requests.length, 0); assert.equal(a.run(), run);
  const g = await fixture(t, { append() { throw Error("private ACK error"); } }); const failed = await g.create().run();
  assert.equal(failed.firstFailure, "ACTIVATION_GATE"); assert.equal(failed.intentState, "failed"); assert.equal(g.daemon.requests.length, 0);
});

for (const [label, wire] of [
  ["already running", "HTTP/1.1 304 Not Modified\r\n\r\n"],
  ["JSON status", "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}"],
  ["redirect", "HTTP/1.1 302 Found\r\nLocation: /elsewhere\r\nContent-Length: 0\r\n\r\n"],
  ["daemon error", "HTTP/1.1 500 Error\r\nContent-Length: 7\r\n\r\nsecret!"],
  ["upgrade", "HTTP/1.1 101 Switching\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n"],
  ["old HTTP", "HTTP/1.0 204 Empty\r\n\r\n"],
  ["response length", "HTTP/1.1 204 Empty\r\nContent-Length: 0\r\n\r\n"],
  ["transfer encoding", "HTTP/1.1 204 Empty\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"],
  ["compression", "HTTP/1.1 204 Empty\r\nContent-Encoding: gzip\r\n\r\n"],
  ["duplicate framing", "HTTP/1.1 204 Empty\r\nConnection: close\r\nConnection: close\r\n\r\n"],
  ["incomplete", "HTTP/1.1 204 Empty\r\n"],
  ["header limit", `HTTP/1.1 204 Empty\r\nX-Fill: ${"x".repeat(1100)}\r\n\r\n`],
]) test(`Start rejects ${label} without retry or fallback`, async t => {
  const f = await fixture(t, { reply(r) { r.socket.end(wire); return true; } }); const a = f.create(); const s = await a.run();
  assert.equal(s.protocolComplete, false); assert.match(s.firstFailure, /^ACTIVATION_(PROTOCOL|HTTP)$/);
  assert.equal(s.effectState, "unknown"); assert.equal(f.daemon.requests.length, 1); assert.equal(f.state.revocations.length, 1);
  assert.equal(a.run(), a.run()); assert.equal(JSON.stringify(s).includes("secret!"), false);
});

test("a bodyless JSON content-type is not parsed or required by Start", async t => {
  const f = await fixture(t, { reply(r) { r.socket.end("HTTP/1.1 204 Empty\r\nContent-Type: application/json\r\n\r\n"); return true; } });
  assert.equal((await f.create().run()).protocolComplete, true);
});

test("header fragmentation and payload-independent metadata preserve one bodyless response", async t => {
  for (const split of [1, 17, 47]) {
    const f = await fixture(t, { reply(r) {
      const wire = "HTTP/1.1 204 Empty\r\nX-Fixture: " + "x".repeat(100) + "\r\nConnection: close\r\n\r\n";
      r.socket.write(wire.slice(0, split)); setImmediate(() => r.socket.end(wire.slice(split))); return true;
    } });
    const a = f.create(); assert.equal((await a.run()).protocolComplete, true); await a.join();
    assert.equal(f.daemon.requests.length, 1); assert.equal(a.snapshot().observedBodyBytes, 0);
  }
});

test("final observation after response end retains status but still enforces permission and original time", async t => {
  for (const [kind, code] of [["deadline", "ACTIVATION_DEADLINE"], ["regression", "ACTIVATION_CLOCK"],
    ["permission", "ACTIVATION_GATE"], ["within", null]]) {
    let f;
    f = await fixture(t, { request(options) {
      const req = nativeRequest(options);
      req.on("response", res => res.once("end", () => {
        if (kind === "permission") f.state.ready = false;
        else f.now(kind === "regression" ? 100n : kind === "within" ? 5000000099n : 5000000100n);
      })); return req;
    } });
    const s = await f.create().run();
    assert.equal(s.statusCode, 204); assert.equal(s.protocolComplete, code === null); assert.equal(s.firstFailure, code);
    assert.equal(s.effectState, "unknown"); assert.equal(f.daemon.requests.length, 1);
  }
});

for (const [label, value, code] of [["before origin", 99n, "ACTIVATION_CLOCK"], ["wrong type", "101", "ACTIVATION_CLOCK"],
  ["exact cutoff", 5000000100n, "ACTIVATION_DEADLINE"], ["past cutoff", 5000000101n, "ACTIVATION_DEADLINE"]]) {
  test(`borrowed clock rejects ${label} before intent`, async t => {
    const f = await fixture(t); f.now(value); const s = await f.create().run();
    assert.equal(s.firstFailure, code); assert.equal(f.state.intents.length, 0); assert.equal(f.daemon.requests.length, 0);
  });
}

test("clock regression and cutoff after ACK keep intent but prevent socket requests", async t => {
  for (const [value, code] of [[100n, "ACTIVATION_CLOCK"], [5000000100n, "ACTIVATION_DEADLINE"]]) {
    let f; f = await fixture(t, { append() { f.now(value); } }); const s = await f.create().run();
    assert.equal(s.firstFailure, code); assert.equal(s.intentState, "acknowledged"); assert.equal(f.daemon.requests.length, 0);
  }
});

test("socket identity mismatch preserves acknowledged progress without a request", async t => {
  const f = await fixture(t); f.input.socket.identity = { ...f.input.socket.identity, ino: "1" }; const s = await f.create().run();
  assert.equal(s.firstFailure, "ACTIVATION_IDENTITY"); assert.equal(s.intentState, "acknowledged");
  assert.equal(s.effectState, "not_requested"); assert.equal(f.daemon.requests.length, 0);
});

test("poll revokes pending HTTP for permission loss and the original cutoff", async t => {
  for (const clock of [false, true]) {
    const f = await fixture(t, { reply() { return true; } }); const a = f.create(); const run = a.run();
    await until(() => f.daemon.requests.length === 1);
    if (clock) f.now(5000000100n); else f.state.ready = false;
    const s = await run; await a.join();
    assert.equal(s.firstFailure, clock ? "ACTIVATION_DEADLINE" : "ACTIVATION_GATE");
    assert.equal(s.protocolComplete, false); assert.equal(s.effectState, "unknown"); assert.equal(f.daemon.requests.length, 1);
  }
});

test("synchronous borrowed callbacks preserve run identity and exclude work after stop", async t => {
  for (const phase of ["check", "intent", "factory"]) {
    let a; let repeated; let ends = 0; let destroys = 0;
    const f = await fixture(t, { append() { repeated = a.run(); if (phase === "intent") a.stop(); },
      request() { a.stop(); const req = new EventEmitter(); req.end = () => { ends++; };
        req.destroy = () => { destroys++; req.emit("close"); }; return req; } });
    if (phase === "check") f.gate.check = () => { repeated = a.run(); a.stop(); return 101n; };
    a = f.create(); const run = a.run(); const s = await run; await a.join();
    assert.equal(repeated, run); assert.equal(s.firstFailure, "ACTIVATION_STOPPED"); assert.equal(ends, 0);
    assert.equal(destroys, phase === "factory" ? 1 : 0); assert.equal(f.daemon.requests.length, 0);
    assert.equal(f.state.intents.length, phase === "check" ? 0 : 1); assert.equal(f.state.revocations.length, 1);
  }
});

test("late response adds status and close uncertainty without restoring permission or rewriting snapshots", async t => {
  let req; let destroys = 0;
  const f = await fixture(t, { request() { req = new EventEmitter(); req.end = () => {}; req.destroy = () => req.emit("close"); return req; } });
  const a = f.create(); const run = a.run(); await until(() => req); a.stop(); await run; await a.join(); const prior = a.snapshot();
  const res = new PassThrough(); res.statusCode = 204; res.destroy = () => { destroys++; return res; };
  req.emit("response", res);
  assert.equal(prior.transportClosed, true); assert.equal(prior.statusCode, null); assert.equal(a.snapshot().transportClosed, false);
  assert.equal(a.snapshot().statusCode, 204); assert.equal(a.snapshot().protocolComplete, false); assert.equal(destroys, 1);
  res.emit("close"); await a.join(); assert.equal(a.snapshot().transportClosed, true);
  assert.equal(a.snapshot().firstFailure, "ACTIVATION_STOPPED"); assert.equal(a.snapshot().effectState, "unknown");
});

test("unexpected delivered body and cleanup/notification failures retain closed diagnostics", async t => {
  let req;
  const f = await fixture(t, { request() {
    req = new EventEmitter(); req.destroy = () => req.emit("close");
    req.end = () => queueMicrotask(() => { const res = new PassThrough(); Object.assign(res, { statusCode: 204, httpVersion: "1.1", rawHeaders: [], complete: true });
      req.emit("response", res); res.end(Buffer.from([7])); }); return req;
  } });
  const s = await f.create().run(); assert.equal(s.firstFailure, "ACTIVATION_PROTOCOL"); assert.equal(s.observedBodyBytes, 1);
  let a; let closes = 0;
  const g = await fixture(t, { revoke() { throw Error("private notification"); }, request() { a.stop();
    const request = new EventEmitter(); request.end = () => assert.fail("send after stop"); request.destroy = () => { closes++; throw Error("private close"); }; return request; } });
  a = g.create(); const failed = await a.run(); a.stop();
  assert.equal(failed.firstFailure, "ACTIVATION_STOPPED"); assert.equal(failed.cleanupError, "ACTIVATION_CLEANUP");
  assert.equal(failed.revocationError, "ACTIVATION_GATE"); assert.equal(failed.transportClosed, false); assert.equal(closes, 1);
});

test("stop before run invokes no gate check, intent or factory", async t => {
  const f = await fixture(t); const a = f.create(); a.stop(); const s = await a.run(); await a.join();
  assert.equal(s.firstFailure, "ACTIVATION_STOPPED"); assert.equal(s.workPending, false); assert.equal(s.transportClosed, true);
  assert.equal(f.state.checks, 0); assert.equal(f.state.intents.length, 0); assert.equal(f.daemon.requests.length, 0);
});

for (const kind of ["throw", "stop"]) test(`a ${kind} during status observation keeps an owned response and closed failure code`, async t => {
  let a;
  let requestCloses = 0; let streamCloses = 0;
  const f = await fixture(t, { request() {
    const req = new EventEmitter(); req.destroy = () => { requestCloses++; req.emit("close"); };
    req.end = () => queueMicrotask(() => {
      const res = new PassThrough(); const destroy = res.destroy.bind(res);
      res.destroy = () => { streamCloses++; return destroy(); };
      Object.defineProperty(res, "statusCode", { get() {
        if (kind === "stop") { a.stop(); return 204; }
        throw Error("STATUS_OBSERVATION_SENTINEL");
      } });
      req.emit("response", res);
    }); return req;
  } });
  a = f.create(); const s = await a.run(); await a.join();
  assert.equal(s.firstFailure, kind === "stop" ? "ACTIVATION_STOPPED" : "ACTIVATION_HTTP"); assert.equal(s.protocolComplete, false);
  assert.equal(s.requestState, "response_observed"); assert.equal(s.effectState, "unknown"); assert.equal(s.statusCode, kind === "stop" ? 204 : null);
  assert.equal(requestCloses, 1); assert.equal(streamCloses, 1);
  assert.equal(JSON.stringify(s).includes("STATUS_OBSERVATION_SENTINEL"), false);
});
