import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once, EventEmitter } from "node:events";
import { mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ACQUISITION_LIMITS, acquisitionSha256, decodeAcquisitionRecord } from "../../../scripts/provenance-acquisition-record.mjs";
import { acquisitionFileIdentity } from "../../../scripts/provenance-acquisition-record-io.mjs";
import { createAcquisitionStartup } from "../../../scripts/provenance-acquisition-startup.mjs";
import { decodeAcquisitionProcessMessage } from "../../../scripts/provenance-acquisition-process-protocol.mjs";
import { decodeStartupGuardMessage, encodeStartupGuardMessage } from "../../../scripts/provenance-acquisition-startup-protocol.mjs";
import { hostProfile } from "../../fixtures/provenance-acquisition-host.mjs";
import { createAcquisitionExec } from "../../../scripts/provenance-acquisition-exec.mjs";
import { fakeExecDaemon, execProfile, output } from "../../fixtures/provenance-acquisition-exec.mjs";

const utc = "2026-01-02T03:04:05.006Z";
const childEntry = new URL("../../fixtures/provenance-acquisition-startup-child.mjs", import.meta.url);
const progress = () => ({ phase: "observe", kind: "resource", subject: "storage", code: "sample", reference: null, value: "7" });

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tabgrad-startup-")));
  const destinations = {};
  const children = [];
  const launches = [];
  let startup;
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (startup) await startup.finish({ observedUtc: utc });
    await rm(root, { recursive: true, force: true });
  });
  for (const [part, capacity] of Object.entries(ACQUISITION_LIMITS)) {
    const name = `${part}.record`;
    const handle = await open(join(root, name), "wx+", 0o600);
    await handle.truncate(capacity);
    destinations[part] = { name, identity: acquisitionFileIdentity(await handle.stat({ bigint: true })) };
    await handle.close();
  }
  const origin = process.hrtime.bigint().toString();
  const host = hostProfile(origin);
  Object.assign(host, { stopAtNs: "2000000000", observeUntilNs: "2500000000", pollMs: 20 }, options.host);
  const hash = "a".repeat(64);
  const header = { recordType: "acq_header_v1", operationId: host.operationId, state: "pending", authorizationRef: "2".repeat(32),
    profileSha256: hash, recipeSha256: hash, inputEvidenceSha256: hash, toolEvidenceSha256: hash,
    priorStateMode: "initial", priorStateSha256: null, declaredLimitsSha256: hash,
    t0MonotonicNs: origin, startedUtc: utc, clockEvidenceSha256: hash, deadlineUtc: "2026-01-02T03:05:05.006Z" };
  const bytes = Buffer.from(JSON.stringify(header) + "\n");
  const context = role => ({ role, operationId: host.operationId, expectedHeaderSha256: acquisitionSha256(bytes),
    profileSha256: hash, t0MonotonicNs: origin, deadlineNs: "10000000000" });
  const input = { process: { root, destinations, header, supervisorContext: context("supervisor"), watchdogContext: context("watchdog"),
    timing: { heartbeatMs: 20, peerTimeoutMs: 1500, termAfterMs: 100, killAfterMs: 200, closeWaitMs: 500, ...options.timing }, host },
  guardProfile: { path: join(root, "host.json"), sha256: acquisitionSha256(JSON.stringify(host)) } };
  await writeFile(input.guardProfile.path, JSON.stringify(host), { flag: "wx", mode: 0o600 });
  const settings = {
    forkActor(role, entry, opts) {
      launches.push(role);
      assert.equal(entry.pathname.endsWith("/provenance-acquisition-startup-actor.mjs"), true);
      options.beforeActor?.(role);
      const child = fork(childEntry, ["actor"], opts); children.push(child);
      if (options.actorMessage) {
        const emit = child.emit.bind(child);
        child.emit = (event, ...values) => {
          if (event === "message") {
            const m = decodeAcquisitionProcessMessage(values[0]);
            options.actorMessage(role, m);
            values[0] = JSON.stringify(m);
          }
          return emit(event, ...values);
        };
      }
      return child;
    },
    forkGuard(entry, args, opts) {
      launches.push("guard");
      assert.equal(entry.pathname.endsWith("/provenance-acquisition-startup-guard.mjs"), true);
      assert.deepEqual(opts.env, {}); assert.deepEqual(opts.execArgv, []);
      options.beforeGuard?.();
      const child = options.forkGuard ? options.forkGuard(entry, args, opts) : fork(childEntry, ["guard", ...args], opts);
      children.push(child);
      if (options.guardMessage) {
        const emit = child.emit.bind(child);
        child.emit = (event, ...values) => {
          if (event === "message") {
            const result = options.guardMessage(decodeStartupGuardMessage(values[0]), child);
            if (result === null) return false;
            if (result !== undefined) values[0] = typeof result === "string" ? result : encodeStartupGuardMessage(result);
          }
          return emit(event, ...values);
        };
      }
      return child;
    },
  };
  options.beforeCreate?.(input);
  const create = async () => { startup = await createAcquisitionStartup(input, settings); return startup; };
  return { create, input, root, launches, children, bytes };
}

test("actual three-control startup binds one fake-daemon Exec and retains conservative client ending", { timeout: 15000 }, async t => {
  const f = await fixture(t, { host: { stopAtNs: "3000000000", observeUntilNs: "3300000000" } });
  const s = await f.create(); const daemon = await fakeExecDaemon(t, f.root);
  const p = await execProfile(f.root, daemon.socket, f.input.process.header.t0MonotonicNs, "5000000000");
  p.timing.closeWaitMs = 3500;
  assert.equal(Object.isFrozen(s.context), true);
  assert.throws(() => { s.context = {}; }, TypeError);
  const exec = await createAcquisitionExec(p, { startup: s });
  const result = await exec.run({ observedUtc: utc });
  assert.equal(result.firstFailure, null); assert.equal(result.locallyComplete, true);
  assert.deepEqual(f.launches, ["guard", "supervisor", "watchdog"]); assert.equal(daemon.requests.length, 4);
  assert.equal(result.capture.channels.stdout.sha256, acquisitionSha256(output));
  const ending = decodeAcquisitionRecord("supervisor", result.controls.process.parts.supervisor.bytes);
  assert.equal(ending.clientState, "unknown"); assert.equal(ending.clientExitCode, null);
  assert.equal(ending.stdoutState, "unknown"); assert.equal(ending.validationState, "not_run");
  assert.equal(result.controls.process.collection.formatComplete, true); assert.equal(result.payloadOrigin, "unqualified");
});

test("startup requires three entered controls, preserves copied inputs and collects the original record", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const s = await f.create();
  assert.deepEqual(f.launches, []);
  f.input.process.host.root.path = "/changed";
  f.input.process.timing.closeWaitMs = 1;
  f.input.guardProfile.sha256 = "f".repeat(64);
  assert.equal((await s.start()).mayStart, true);
  assert.deepEqual(f.launches, ["guard", "supervisor", "watchdog"]);
  assert.equal(s.snapshot().guard.phase, "observation");
  assert.equal(s.snapshot().guard.report.entry.state, "verified");
  assert.equal((await s.supervisor.append(progress())).mayStart, true);
  const ending = s.finish({ observedUtc: utc });
  assert.equal(s.snapshot().mayStart, false);
  assert.equal(s.finish({ observedUtc: utc }), ending);
  const r = await ending;
  assert.equal(r.firstFailure, null);
  assert.equal(r.guard.closed, true);
  assert.equal(r.guard.phase, "settled");
  assert.equal(r.guard.report.ioClosed, "closed");
  assert.equal(r.guard.termRequested, false);
  assert.equal(r.process.collection.formatComplete, true);
  assert.deepEqual(r.process.parts.header.bytes, f.bytes);
  assert.equal(r.externalClosure, "unqualified");
  await assert.rejects(s.supervisor.append(progress()), { code: "PROCESS_STOPPED" });
});

test("bad file, independent profile mismatch and timer overflow reject without launching", async t => {
  for (const change of [f => { f.input.guardProfile.sha256 = "f".repeat(64); },
    f => { f.input.process.host.groups.guard[0].identity.ino = "99"; },
    async f => {
      f.input.process.host.observeUntilNs = "999999999999999999";
      for (const role of ["supervisorContext", "watchdogContext"]) f.input.process[role].deadlineNs = "1000000000000000000";
      const bytes = JSON.stringify(f.input.process.host);
      f.input.guardProfile.sha256 = acquisitionSha256(bytes);
      await writeFile(f.input.guardProfile.path, bytes);
    }]) {
    const f = await fixture(t); await change(f);
    await assert.rejects(f.create());
    assert.deepEqual(f.launches, []);
  }
});

test("profile replacement after creation and a thrown guard launch never start record actors", { timeout: 15000 }, async t => {
  for (const throws of [false, true]) {
    const f = await fixture(t, { beforeGuard() { if (throws) throw Error("synthetic launch"); } });
    const s = await f.create();
    if (!throws) await writeFile(f.input.guardProfile.path, "{}");
    assert.equal((await s.start()).mayStart, false);
    const r = await s.finish({ observedUtc: utc });
    assert.equal(r.firstFailure.actor, "guard");
    assert.equal(r.firstFailure.code, throws ? "startup" : "channel");
    assert.deepEqual(f.launches, ["guard"]);
  }
});

test("armed without a completed observation cannot launch either record actor", { timeout: 15000 }, async t => {
  const f = await fixture(t, { guardMessage: m => m.phase === "observation" ? null : undefined });
  const s = await f.create();
  assert.equal((await s.start()).mayStart, false);
  assert.deepEqual(f.launches, ["guard"]);
  const r = await s.finish({ observedUtc: utc });
  assert.deepEqual(r.firstFailure, { actor: "guard", code: "startup" });
  assert.equal(r.guard.closed, true);
});

test("wrong PID, profile, operation or phase reject the guard and retain the first failure", { timeout: 20000 }, async t => {
  for (const change of [m => { m.pid += 1; }, m => { m.profileSha256 = "f".repeat(64); },
    m => { m.report.operationId = "f".repeat(32); }, m => { m.phase = "observation"; }]) {
    let changed = false;
    const f = await fixture(t, { guardMessage(m) {
      if (changed) return;
      changed = true; change(m); return m;
    } });
    const s = await f.create();
    assert.equal((await s.start()).mayStart, false);
    assert.deepEqual(f.launches, ["guard"]);
    const r = await s.finish({ observedUtc: utc });
    assert.deepEqual(r.firstFailure, { actor: "guard", code: "protocol" });
    assert.equal(r.mayStart, false);
  }
});

test("partial actor launch failure and immediate stop cannot be undone by later guard replies", { timeout: 15000 }, async t => {
  const f = await fixture(t, { beforeActor(role) { if (role === "watchdog") throw Error("synthetic launch"); } });
  const s = await f.create();
  assert.equal((await s.start()).mayStart, false);
  const r = await s.finish({ observedUtc: utc });
  assert.deepEqual(r.firstFailure, { actor: "watchdog", code: "startup" });
  assert.equal(r.guard.closed, true);
  const stopped = await fixture(t);
  const second = await stopped.create();
  const opening = second.start();
  second.stop("watchdog", "storage");
  assert.equal((await opening).mayStart, false);
  assert.equal((await second.finish({ observedUtc: utc })).firstFailure.code, "storage");
  assert.deepEqual(stopped.launches, ["guard"]);
});

test("guard loss after readiness revokes append and distinguishes exit from settled receipt", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const s = await f.create();
  assert.equal((await s.start()).mayStart, true);
  f.children[0].kill("SIGKILL");
  await once(f.children[0], "close");
  await assert.rejects(s.supervisor.append(progress()), { code: "PROCESS_STOPPED" });
  const r = await s.finish({ observedUtc: utc });
  assert.equal(r.guard.closed, true);
  assert.notEqual(r.guard.phase, "settled");
  assert.notEqual(r.firstFailure, null);
  for (const role of ["supervisor", "watchdog"]) {
    assert.equal(r.process.actors[role].host.revoked, true);
    assert.equal(r.process.actors[role].host.freeze.state, "acknowledged");
    assert.equal(r.process.actors[role].host.kill.state, "acknowledged");
  }
  assert.equal(r.externalClosure, "unqualified");
});

test("stale observation, unverified entry and a nonempty/frozen initial case cannot grant admission", { timeout: 20000 }, async t => {
  for (const change of [m => { m.sequence = "1"; }, m => { m.report.entry.state = "acknowledged"; },
    m => { m.report.observation.populated = true; }, m => { m.report.observation.frozen = true; }]) {
    let changed = false;
    const f = await fixture(t, { guardMessage(m) {
      if (m.phase !== "observation" || changed) return;
      changed = true; change(m); return m;
    } });
    const s = await f.create();
    assert.equal((await s.start()).mayStart, false);
    assert.deepEqual(f.launches, ["guard"]);
    assert.deepEqual((await s.finish({ observedUtc: utc })).firstFailure, { actor: "guard", code: "protocol" });
  }
});

test("each record actor must independently report verified entry and an empty unfrozen initial case", { timeout: 30000 }, async t => {
  for (const role of ["supervisor", "watchdog"]) {
    for (const change of [h => { h.entry.state = "acknowledged"; },
      h => { h.observation.populated = true; }, h => { h.observation.frozen = true; }]) {
      let changed = false;
      const f = await fixture(t, { actorMessage(actor, m) {
        if (actor === role && m.kind === "reply" && m.payload.report.host) {
          change(m.payload.report.host); changed = true;
        }
      } });
      const s = await f.create();
      assert.equal((await s.start()).mayStart, false);
      assert.equal(changed, true);
      assert.deepEqual(f.launches, ["guard", "supervisor", "watchdog"]);
      const r = await s.finish({ observedUtc: utc });
      assert.equal(r.firstFailure.code, "protocol");
      assert.equal(r.mayStart, false);
    }
  }
});

test("a missing guard receipt/close stays uncertain after bounded owned-handle cleanup", { timeout: 10000 }, async t => {
  const signals = [];
  const f = await fixture(t, { host: { stopAtNs: "500000000", observeUntilNs: "800000000" },
    timing: { peerTimeoutMs: 200, termAfterMs: 50, killAfterMs: 100, closeWaitMs: 150 },
    forkGuard() {
      const child = new EventEmitter();
      Object.assign(child, { pid: 99999, connected: true, exitCode: null, signalCode: null,
        send(wire, cb) { queueMicrotask(() => cb(null)); return true; },
        kill(signal) { signals.push(signal); return true; } });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    } });
  const s = await f.create();
  assert.equal((await s.start()).mayStart, false);
  const r = await s.finish({ observedUtc: utc });
  assert.deepEqual(r.firstFailure, { actor: "guard", code: "startup" });
  assert.equal(r.guard.closed, false);
  assert.equal(r.guard.report, null);
  assert.equal(r.guard.termRequested, true);
  assert.equal(r.guard.killRequested, true);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(r.externalClosure, "unqualified");
});

test("explicit guard entry contains on parent-channel loss and retains its original observation horizon", { timeout: 10000 }, async t => {
  const f = await fixture(t, { host: { stopAtNs: "500000000", observeUntilNs: "800000000" } });
  const output = join(f.root, "guard-output.json");
  const child = fork(childEntry, ["guard", f.input.guardProfile.path, f.input.guardProfile.sha256, output], {
    execArgv: [], env: {}, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  f.children.push(child);
  const exited = once(child, "exit");
  await once(child, "message");
  child.disconnect();
  assert.equal((await exited)[0], 0);
  assert(process.hrtime.bigint() >= BigInt(f.input.process.host.t0MonotonicNs) + BigInt(f.input.process.host.observeUntilNs));
  const writes = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(writes.map(w => [w.name, w.text]), [["cgroup.procs", "0"], ["cgroup.freeze", "1"], ["cgroup.kill", "1"]]);
});
