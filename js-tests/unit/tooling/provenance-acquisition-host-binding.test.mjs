import assert from "node:assert/strict";
import { mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ACQUISITION_LIMITS, acquisitionSha256 } from "../../../scripts/provenance-acquisition-record.mjs";
import { acquisitionFileIdentity } from "../../../scripts/provenance-acquisition-record-io.mjs";
import { AcquisitionProcessActor } from "../../../scripts/provenance-acquisition-process-actor.mjs";
import { createAcquisitionProcessSession } from "../../../scripts/provenance-acquisition-process.mjs";
import { decodeAcquisitionProcessMessage, encodeAcquisitionProcessMessage } from "../../../scripts/provenance-acquisition-process-protocol.mjs";
import { createAcquisitionHostController } from "../../../scripts/provenance-acquisition-host.mjs";
import { openAcquisitionHost } from "../../../scripts/provenance-acquisition-host-io.mjs";
import { hostProfile, hostModel, deferred } from "../../fixtures/provenance-acquisition-host.mjs";

const utc = "2026-01-02T03:04:05.006Z";

async function actorFixture(t, role, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tabgrad-host-binding-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = hostProfile(process.hrtime.bigint().toString());
  profile.stopAtNs = "10000000000"; profile.observeUntilNs = "15000000000";
  const header = { recordType: "acq_header_v1", operationId: profile.operationId, state: "pending", authorizationRef: "2".repeat(32),
    profileSha256: "a".repeat(64), recipeSha256: "a".repeat(64), inputEvidenceSha256: "a".repeat(64), toolEvidenceSha256: "a".repeat(64),
    priorStateMode: "initial", priorStateSha256: null, declaredLimitsSha256: "a".repeat(64), t0MonotonicNs: profile.t0MonotonicNs,
    startedUtc: utc, clockEvidenceSha256: "a".repeat(64), deadlineUtc: "2026-01-02T03:05:05.006Z" };
  const headerBytes = Buffer.from(JSON.stringify(header) + "\n");
  const destinations = {};
  for (const [name, capacity] of Object.entries(ACQUISITION_LIMITS)) {
    const file = await open(join(root, name), "wx+", 0o600); await file.truncate(capacity);
    destinations[name] = { name, identity: acquisitionFileIdentity(await file.stat({ bigint: true })) }; await file.close();
  }
  const context = { role, operationId: profile.operationId, expectedHeaderSha256: acquisitionSha256(headerBytes),
    profileSha256: "a".repeat(64), t0MonotonicNs: profile.t0MonotonicNs, deadlineNs: "20000000000" };
  const data = { root, destinations: Object.fromEntries((role === "supervisor" ? ["header", "progress", "supervisor"] : ["watchdog"])
    .map(name => [name, destinations[name]])), context, header: role === "supervisor" ? headerBytes.toString("base64") : null,
    timing: { heartbeatMs: 10, peerTimeoutMs: 1000, termAfterMs: 50, killAfterMs: 100, closeWaitMs: 200 }, host: profile };
  const messages = []; const waiters = [];
  const endpoint = { connected: true,
    send(wire, done) {
      const m = decodeAcquisitionProcessMessage(wire); messages.push(m);
      const index = waiters.findIndex(w => w.test(m));
      if (index !== -1) waiters.splice(index, 1)[0].resolve(m);
      done();
    }, disconnect() { endpoint.connected = false; } };
  const waitFor = predicate => {
    const old = messages.find(predicate);
    if (old) return Promise.resolve(old);
    return new Promise(resolve => waiters.push({ test: predicate, resolve }));
  };
  const closed = deferred(); const m = hostModel(options.native);
  let controller;
  const actor = new AcquisitionProcessActor(endpoint, 777, { async createHost(p, r) {
    if (options.beforeCreate) await options.beforeCreate();
    controller = await createAcquisitionHostController(p, r, { openHost: (p2, r2) => openAcquisitionHost(p2, r2, m.port) });
    const close = controller.close.bind(controller);
    controller.close = () => { const work = close(); void work.then(closed.resolve, closed.reject); return work; };
    return controller;
  } });
  t.after(async () => { actor.terminated(); if (controller) await controller.close(); });
  const request = (id, command, content = null) => actor.receive(encodeAcquisitionProcessMessage("request", role,
    profile.operationId, String(id), { command, data: content }));
  request(1, "init", data);
  return { actor, endpoint, m, request, waitFor, messages, closed, data, profile, destinations,
    controller: () => controller };
}

test("both actor roles have a direct native route before reporting faults to the parent", { timeout: 10000 }, async t => {
  for (const role of ["supervisor", "watchdog"]) for (const cause of ["channel", "controller", "peer"]) {
    const f = await actorFixture(t, role);
    const init = await f.waitFor(m => m.kind === "reply" && m.payload.command === "init");
    assert.equal(init.payload.ok, true);
    assert.equal(init.payload.report.host.actor, role);
    assert.equal(init.payload.report.host.observation.populated, true);
    f.endpoint.connected = false;
    if (cause === "channel") f.actor.disconnected();
    else if (cause === "controller") f.actor.terminated();
    else f.actor.receive(encodeAcquisitionProcessMessage("stop", role, f.profile.operationId, "0", { code: "peer" }));
    assert.deepEqual(f.m.calls.filter(c => c.kind === "write").map(c => [c.name, c.text]), [["cgroup.freeze", "1"], ["cgroup.kill", "1"]]);
    const host = await f.closed.promise;
    assert.equal(host.ioClosed, "closed");
    assert.equal(host.firstFailure, { channel: "HOST_CHANNEL", controller: "HOST_CONTROLLER", peer: "HOST_PEER" }[cause]);
    assert.equal(host.externalClosure, "unqualified");
    assert.equal(f.messages.filter(m => m.kind === "fault").length, 0);
  }
});

test("finish closes host ownership before its local file receipt without inventing an external close", { timeout: 10000 }, async t => {
  const f = await actorFixture(t, "supervisor");
  await f.waitFor(m => m.kind === "reply" && m.payload.command === "init");
  f.request(2, "finish", { observedUtc: utc });
  const end = await f.waitFor(m => m.kind === "reply" && m.payload.command === "finish");
  assert.equal(end.payload.report.localClosed, true);
  assert.equal(end.payload.report.host.ioClosed, "closed");
  assert.equal(end.payload.report.host.firstFailure, null);
  assert.equal(end.payload.report.firstFailure, null);
  assert.equal(end.payload.report.host.externalClosure, "unqualified");
  assert.deepEqual(f.m.calls.filter(c => c.kind === "write"), []);
});

test("loss while host opening is pending cannot be erased when native ownership arrives late", { timeout: 10000 }, async t => {
  const opening = deferred(); const entered = deferred();
  const f = await actorFixture(t, "watchdog", { beforeCreate() { entered.resolve(); return opening.promise; } });
  await entered.promise;
  f.endpoint.connected = false; f.actor.disconnected();
  opening.resolve();
  const host = await f.closed.promise;
  assert.equal(host.revoked, true);
  assert.equal(host.firstFailure, "HOST_CHANNEL");
  assert.deepEqual(f.m.calls.filter(c => c.kind === "write").map(c => c.name), ["cgroup.freeze", "cgroup.kill"]);
  assert.equal(host.ioClosed, "closed");
});

test("failed native opening and cleanup keep a closed cause and unknown native closure in actor evidence", { timeout: 10000 }, async t => {
  const f = await actorFixture(t, "watchdog", { native: { filesystem: 1n, beforeClose() { throw Error("synthetic native details"); } } });
  const end = await f.waitFor(m => m.kind === "closed");
  assert.equal(end.payload.report.localClosed, true);
  assert.equal(end.payload.report.host.firstFailure, "HOST_FILESYSTEM");
  assert.equal(end.payload.report.host.ioClosed, "unknown");
  assert.equal(end.payload.report.host.observation.populated, null);
  assert.equal(end.payload.report.host.externalClosure, "unqualified");
  assert.equal(JSON.stringify(end).includes("synthetic native details"), false);
});

test("parent/actor host identity and deadline mismatches reject before launching or native calls", async t => {
  const f = await actorFixture(t, "supervisor");
  await f.waitFor(m => m.kind === "reply" && m.payload.command === "init");
  for (const field of ["operationId", "t0MonotonicNs", "observeUntilNs"]) {
    const data = structuredClone(f.data);
    data.host[field] = field === "operationId" ? "9".repeat(32) : field === "observeUntilNs" ? "30000000000" : "1";
    assert.throws(() => encodeAcquisitionProcessMessage("request", "supervisor", f.profile.operationId, "1", { command: "init", data }), { code: "PROCESS_PROTOCOL" });
  }
  const input = { root: f.data.root, destinations: f.destinations, header: JSON.parse(Buffer.from(f.data.header, "base64")),
    supervisorContext: f.data.context, watchdogContext: { ...f.data.context, role: "watchdog" }, timing: f.data.timing, host: structuredClone(f.profile) };
  input.host.operationId = "8".repeat(32); let launches = 0;
  await assert.rejects(createAcquisitionProcessSession(input, { forkActor() { launches++; } }), { code: "PROCESS_PROTOCOL" });
  assert.equal(launches, 0);
  f.actor.terminated(); await f.closed.promise;
});
