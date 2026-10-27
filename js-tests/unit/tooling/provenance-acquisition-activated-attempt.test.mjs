import assert from "node:assert/strict";
import { test } from "node:test";
import { createActivatedAcquisitionAttempt } from "../../../scripts/provenance-acquisition-attempt.mjs";
import { decodeAcquisitionRecord } from "../../../scripts/provenance-acquisition-record.mjs";
import { attemptFixture, preparedStartup, observedUtc } from "../../fixtures/provenance-acquisition-attempt.mjs";
import { until } from "../../fixtures/provenance-acquisition-capture-attempt.mjs";
import { placementProfile, placementModel } from "../../fixtures/provenance-acquisition-placement.mjs";
import { execId, jsonReply, inspectBody, upgradeReply } from "../../fixtures/provenance-acquisition-exec.mjs";

function activatedReply(state, options, request, { argv }) {
  if (request.route.includes("/containers/") && request.route.endsWith("/start")) {
    state.starts++; options.activationRequest?.(request, state.model);
    if (!options.holdStart) {
      state.model.activate(); request.socket.end(`HTTP/1.1 ${options.status ?? 204} fixture\r\nConnection: close\r\n\r\n`);
    }
    return true;
  }
  if (request.route.endsWith("/exec")) { jsonReply(request.socket, { Id: execId }, 201); return true; }
  if (request.route.endsWith("/start")) {
    state.model.program(); state.programStarted = true; options.program?.(state.model);
    upgradeReply(request.socket, Buffer.alloc(0)); return true;
  }
  jsonReply(request.socket, inspectBody(request.index === 2, { ProcessConfig: { tty: false, entrypoint: argv[0],
    arguments: argv.slice(1), privileged: false, user: "1000:1000" } }));
  return true;
}

function activatedRead(state, options, h, bytes, length) {
  if (options.read) return options.read(h, bytes, length);
  // No launcher observations exist before the peer admits ExecStart.
  if (h.role === "control" && !state.programStarted) return { bytesRead: 0 };
  return undefined;
}

async function activatedFixture(t, options = {}) {
  const state = { model: null, programStarted: false, starts: 0 };
  const capture = { ...options.capture, reply: (r, metadata) => activatedReply(state, options, r, metadata),
    read: (h, bytes, length) => activatedRead(state, options, h, bytes, length) };
  const fixture = await attemptFixture(t, { ...options, capture });
  if (options.realStartup) fixture.input.exec.timing.closeWaitMs = 5000;
  const startup = options.realStartup ? (await preparedStartup(t, fixture)).startup : fixture.startup;
  const p = placementProfile(startup.context, fixture.input.exec.containerId, fixture.input.launcherProfile.sha256);
  state.model = placementModel(p, options.native);
  const activation = { context: { ...startup.context }, socket: structuredClone(fixture.input.exec.socket),
    containerId: fixture.input.exec.containerId, preparedContainerSha256: p.preparedContainerSha256, pollMs: 1,
    limits: { headerBytes: 1024 } };
  const create = () => fixture.create((input, ports) => {
    const { startup: ignored, clock, ...capturePorts } = ports;
    return createActivatedAcquisitionAttempt({ capture: input, activation, placement: p },
      { startup, ...capturePorts, ...(options.realStartup ? {} : { clock }), placementIo: state.model.port });
  });
  return { ...fixture, startup, model: state.model, placement: p, activation, create,
    get starts() { return state.starts; }, get owner() { return fixture.owner; } };
}

test("activated caller composes real capture/HTTP owners, one Start, concrete reads and final gate order", async t => {
  let f;
  f = await activatedFixture(t, { finish() {
    assert.equal(f.owner.snapshot().capture.localComplete, true);
    assert.equal(f.owner.snapshot().placement.executionObserved, true);
  } });
  const owner = f.create(); const originalBinding = owner.snapshot();
  assert.equal(originalBinding.placement.io.opened, false); assert.equal(f.model.calls.length, 0);
  const run = owner.run({ observedUtc }); assert.equal(owner.run({ observedUtc }), run);
  const end = await run;
  assert.equal(end.localComplete, true, end.firstFailure ?? end.cleanupError ?? "incomplete"); assert.equal(end.firstFailure, null);
  assert.equal(f.starts, 1); assert.equal(f.daemon.requests.length, 5);
  assert.deepEqual(f.events, ["start", "intent", "intent", "finish"]);
  assert.equal(end.activation.protocolComplete, true); assert.equal(end.activation.effectState, "unknown");
  assert.equal(end.placement.executionObserved, true); assert.equal(end.placement.io.ioClosed, "closed");
  const evidence = owner.collectPlacement(); assert.deepEqual(Object.keys(evidence), ["init", "launcher", "program"]);
  assert.match(evidence.program.statBefore.toString(), /^1003 \(node\) /);
  assert.equal(end.externalClosure, "unqualified"); assert.equal(end.releaseAdmission, "unqualified");
  assert(f.model.calls.every(c => c.kind !== "write")); assert([...f.model.handles.values()].every(h => h.closed));
});

test("mismatched copied container, preparation or launcher binding fails without I/O or requests", async t => {
  for (const mutate of [f => { f.activation.containerId = "d".repeat(64); },
    f => { f.placement.preparedContainerSha256 = "d".repeat(64); },
    f => { f.placement.launcherProfileSha256 = "d".repeat(64); },
    f => { f.activation.socket.identity.ino = "9"; }]) {
    const f = await activatedFixture(t); mutate(f);
    assert.throws(() => f.create(), { code: "ACQ_ATTEMPT_INPUT" });
    assert.equal(f.model.calls.length, 0); assert.equal(f.daemon.requests.length, 0);
  }
});

test("preexisting leaf, failed Start and escaped init each exclude all Exec requests", async t => {
  for (const kind of ["existing", "status", "escaped"]) {
    const f = await activatedFixture(t, { status: kind === "status" ? 304 : 204,
      activationRequest(request, model) {
        if (kind === "escaped") {
          const activate = model.activate;
          model.activate = () => { activate(); model.processes[1001].children.get("cgroup").text = "0::/outside\n"; };
        }
      } });
    const owner = f.create(); if (kind === "existing") f.model.activate();
    const end = await owner.run({ observedUtc });
    assert.equal(end.localComplete, false); assert(end.firstFailure);
    assert.equal(f.daemon.requests.length, kind === "existing" ? 0 : 1);
    assert.equal(end.capture.started, false); assert.equal(end.placement.mayExec, false);
  }
});

test("revocation during pending Start retains late effects and cannot enter Exec", async t => {
  let request;
  const f = await activatedFixture(t, { holdStart: true, activationRequest(r) { request = r; } });
  const owner = f.create(); const run = owner.run({ observedUtc });
  await until(() => request !== undefined); owner.stop();
  f.time(3000000100n); const end = await run;
  assert.equal(end.firstFailure, "ACQ_ATTEMPT_STOPPED"); assert.equal(end.localComplete, false);
  assert.equal(f.daemon.requests.length, 1); assert.equal(end.activation.effectState, "unknown");
  f.model.activate(); request.socket.end("HTTP/1.1 204 fixture\r\nConnection: close\r\n\r\n");
  await until(() => !owner.snapshot().activation.workPending);
  assert.equal(owner.snapshot().localComplete, false); assert.equal(f.daemon.requests.length, 1);
});

test("program missing from the concrete observation remains incomplete despite successful capture", async t => {
  const f = await activatedFixture(t, { program(model) { model.procs.text = "1001\n1002\n"; } });
  const end = await f.create().run({ observedUtc });
  assert.equal(end.localComplete, false); assert.equal(end.placement.executionObserved, false);
  assert.equal(end.placement.firstFailure, "PLACEMENT_IDENTITY");
});

test("input mutation after construction cannot redirect copied activation, placement or capture bindings", async t => {
  const f = await activatedFixture(t); const owner = f.create();
  f.activation.containerId = "d".repeat(64); f.activation.socket.path = "/different/socket";
  f.placement.containerId = "d".repeat(64); f.placement.context.root = "/different/evidence";
  f.input.exec.containerId = "d".repeat(64);
  const end = await owner.run({ observedUtc });
  assert.equal(end.localComplete, true); assert.equal(f.daemon.requests.length, 5);
  assert(f.daemon.requests.every(r => !r.route.includes("d".repeat(64))));
});

test("stalled initial placement opening stays owned through the bounded aggregate close and late handle", async t => {
  let release; let entered = false; let once = false;
  const f = await activatedFixture(t, { native: { async beforeOpen() {
    if (!once) { once = true; entered = true; await release.promise; }
  } } }); release = f.hold();
  const owner = f.create(); const run = owner.run({ observedUtc }); await until(() => entered);
  owner.stop(); f.time(3000000100n); const end = await run;
  assert.equal(end.firstFailure, "ACQ_ATTEMPT_STOPPED"); assert.equal(end.localComplete, false);
  assert.equal(end.placement.pending, "open"); assert.equal(end.auxiliaryClosePending, true);
  assert.equal(f.daemon.requests.length, 0); assert.equal(f.state.starts, 0);
  release.resolve(); await until(() => !owner.snapshot().auxiliaryClosePending && !owner.snapshot().opening);
  assert.equal(owner.snapshot().localComplete, false); assert.equal(f.daemon.requests.length, 0);
  assert([...f.model.handles.values()].every(h => h.closed));
});

test("a control gate lost during native placement excludes Exec and keeps the root first cause", async t => {
  let f; let changed = false;
  f = await activatedFixture(t, { native: { beforeRead(node) {
    if (f && f.starts && !changed && node.name === "cgroup.type") { changed = true; f.deny(); }
  } } });
  const end = await f.create().run({ observedUtc });
  assert.equal(changed, true); assert.equal(end.firstFailure, "ACQ_ATTEMPT_GATE");
  assert.equal(f.daemon.requests.length, 1); assert.equal(end.capture.started, false);
});

test("late observer closure cannot restore an expired aggregate even after successful capture", async t => {
  let release; let entered = false;
  const f = await activatedFixture(t, { native: { async beforeClose(node) {
    if (node.name === "case") { entered = true; await release.promise; }
  } } }); release = f.hold();
  const owner = f.create(); const run = owner.run({ observedUtc }); await until(() => entered);
  f.time(200000000n); const end = await run;
  assert.equal(end.capture.localComplete, true); assert.equal(end.placement.executionObserved, true);
  assert.equal(end.cleanupWaitExpired, true); assert.equal(end.localComplete, false);
  assert.equal(end.auxiliaryClosePending, true); release.resolve();
  await until(() => !owner.snapshot().auxiliaryClosePending);
  assert.equal(owner.snapshot().placement.io.ioClosed, "closed"); assert.equal(owner.snapshot().localComplete, false);
  assert.equal(end.placement.io.ioClosed, "pending");
});

test("actual three-control startup retains conservative original endings on the activated path", { timeout: 15000 }, async t => {
  const f = await activatedFixture(t, { realStartup: true, capture: { origin: process.hrtime.bigint().toString(),
    deadlineNs: "6000000000", workUntilNs: "4000000000", closeUntilNs: "5000000000" } });
  const end = await f.create().run({ observedUtc });
  assert.equal(end.localComplete, true, end.firstFailure ?? end.cleanupError ?? "incomplete");
  const s = decodeAcquisitionRecord("supervisor", end.controlsResult.process.parts.supervisor.bytes);
  const w = decodeAcquisitionRecord("watchdog", end.controlsResult.process.parts.watchdog.bytes);
  assert.equal(s.validationState, "not_run"); assert.equal(s.caseClosureState, "unknown");
  assert.equal(w.caseEmptyState, "unknown"); assert.equal(w.lifecycleState, "unknown");
});
