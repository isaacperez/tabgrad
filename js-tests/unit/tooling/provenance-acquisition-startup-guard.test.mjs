import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquisitionSha256 } from "../../../scripts/provenance-acquisition-record.mjs";
import { enterAcquisitionHost } from "../../../scripts/provenance-acquisition-host-io.mjs";
import { createEnteringAcquisitionHostController } from "../../../scripts/provenance-acquisition-host.mjs";
import { startupGuardMain } from "../../../scripts/provenance-acquisition-startup-guard.mjs";
import { runAcquisitionHostGuard } from "../../../scripts/provenance-acquisition-host-guard.mjs";
import { decodeStartupGuardMessage } from "../../../scripts/provenance-acquisition-startup-protocol.mjs";
import { hostProfile, hostModel, deferred } from "../../fixtures/provenance-acquisition-host.mjs";

const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(t, predicate) {
  while (!predicate()) { t.signal.throwIfAborted(); await turn(); }
}
function release(item, error = null) {
  assert.equal(item.acknowledged, false);
  item.acknowledged = true; item.callback(error);
}

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tabgrad-guard-channel-")));
  const profile = hostProfile();
  Object.assign(profile, { stopAtNs: "10", observeUntilNs: "20", pollMs: 1 });
  const path = join(root, "profile.json");
  const bytes = JSON.stringify(profile);
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  const model = hostModel({ enter: true, beforeClose: options.beforeClose });
  const replies = [];
  let now = 101n;
  let automatic = false;
  let work;
  const endpoint = new EventEmitter();
  Object.assign(endpoint, { pid: 777, connected: true,
    send(wire, callback) {
      const item = { message: decodeStartupGuardMessage(wire), callback, acknowledged: false };
      replies.push(item);
      if (automatic) queueMicrotask(() => release(item));
      return true;
    },
    disconnect() { endpoint.connected = false; endpoint.emit("disconnect"); },
  });
  const clock = options.clock ?? (() => now);
  const createController = (p, r) => createEnteringAcquisitionHostController(p, r, { clock,
    openHost: (data, role) => enterAcquisitionHost(data, role, { port: model.port, clock }),
  });
  t.after(async () => {
    automatic = true; now = 120n;
    options.cleanup?.();
    for (const item of replies) if (!item.acknowledged) release(item);
    if (work) await work.catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return { model, replies, endpoint, release,
    setTime(value) { now = value; },
    auto() { automatic = true; for (const item of replies) if (!item.acknowledged) release(item); },
    start() { work = startupGuardMain([path, acquisitionSha256(bytes)], endpoint, { createController }); return work; },
  };
}

test("held IPC omits samples without delaying containment; terminal receipts wait for send and native close", { timeout: 10000 }, async t => {
  const close = deferred();
  const f = await fixture(t, { beforeClose: () => close.promise, cleanup: () => close.resolve() });
  let done = false;
  const work = f.start().then(() => { done = true; });
  await until(t, () => f.replies.length === 1);
  assert.equal(f.replies[0].message.phase, "armed");
  await until(t, () => f.model.calls.filter(c => c.kind === "read" && c.name === "cgroup.events" && c.position === 0).length >= 3);
  assert.equal(f.replies.length, 1);
  f.setTime(110n);
  await until(t, () => f.model.calls.filter(c => c.kind === "write").length === 3);
  assert.deepEqual(f.model.calls.filter(c => c.kind === "write").map(c => c.name), ["cgroup.procs", "cgroup.freeze", "cgroup.kill"]);
  assert.equal(f.replies.length, 1);
  f.setTime(120n);
  await until(t, () => f.model.calls.some(c => c.kind === "close"));
  assert.equal(done, false);
  f.release(f.replies[0]);
  await until(t, () => f.replies.length === 2);
  const boundary = f.replies[1].message.report;
  const boundarySample = structuredClone(boundary.observation);
  assert.equal(f.replies[1].message.phase, "boundary");
  assert.equal(boundary.ioClosed, "pending");
  assert.equal(boundary.lastAtNs, "20");
  assert(BigInt(boundary.observation.atNs) <= 20n);
  f.release(f.replies[1]);
  await turn();
  assert.equal(f.replies.length, 2);
  close.resolve();
  await until(t, () => f.replies.length === 3);
  assert.equal(f.replies[2].message.phase, "settled");
  assert.equal(f.replies[2].message.report.ioClosed, "closed");
  assert.equal(boundary.ioClosed, "pending");
  assert.deepEqual(boundary.observation, boundarySample);
  assert.equal(done, false);
  f.release(f.replies[2]);
  await work;
  assert.equal(f.endpoint.connected, false);
});

test("a failed send contains directly before the stop cutoff and preserves its cause through the horizon", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const work = f.start();
  await until(t, () => f.replies.length === 1);
  f.release(f.replies[0], Error("synthetic send failure"));
  await until(t, () => f.model.calls.filter(c => c.kind === "write").length === 3);
  f.setTime(120n); f.auto();
  await work;
  const final = f.replies.at(-1).message;
  assert.equal(final.phase, "settled");
  assert.equal(final.report.firstFailure, "HOST_CHANNEL");
  assert.equal(final.report.revoked, true);
  assert.equal(final.report.ioClosed, "closed");
  assert.deepEqual(f.model.calls.filter(c => c.kind === "write").map(c => c.name), ["cgroup.procs", "cgroup.freeze", "cgroup.kill"]);
});

test("clock failure before or after verified entry cannot erase failed native close in the guard receipt", { timeout: 10000 }, async t => {
  for (const afterEntry of [false, true]) {
    const times = afterEntry ? [101n, 101n, 100n] : [101n, 99n];
    const f = await fixture(t, { clock: () => times.shift() ?? 100n,
      beforeClose: () => { throw Error("synthetic close failure"); } });
    f.auto();
    await assert.rejects(f.start(), { code: "HOST_CLOCK", closeError: "HOST_CLOSE" });
    assert.equal(f.replies.length, 1);
    const { phase, report } = f.replies[0].message;
    assert.equal(phase, "failed");
    assert.equal(report.firstFailure, "HOST_CLOCK");
    assert.equal(report.ioClosed, "unknown");
    assert.equal(report.entry.state, afterEntry ? "verified" : "not_requested");
    assert.equal(f.model.calls.filter(c => c.kind === "write").length, afterEntry ? 1 : 0);
  }
});

test("a throwing completed-observation callback contains locally without replacing the deadline loop", { timeout: 10000 }, async t => {
  const profile = { ...hostProfile(), stopAtNs: "10", observeUntilNs: "20", pollMs: 1 };
  const model = hostModel({ enter: true });
  let now = 101n;
  const clock = () => now;
  let work;
  t.after(async () => { now = 120n; if (work) await (await work).settled; });
  work = runAcquisitionHostGuard(profile, { clock,
    createController: (p, r) => createEnteringAcquisitionHostController(p, r, { clock,
      openHost: (data, role) => enterAcquisitionHost(data, role, { port: model.port, clock }),
    }),
    onObservation() { throw Error("synthetic callback failure"); },
  });
  await until(t, () => model.calls.filter(c => c.kind === "write").length === 3);
  assert.equal(now, 101n);
  now = 120n;
  const result = await work;
  const settled = await result.settled;
  assert.equal(settled.firstFailure, "HOST_CHANNEL");
  assert.equal(settled.ioClosed, "closed");
  assert.equal(result.observation.lastAtNs, "20");
});
