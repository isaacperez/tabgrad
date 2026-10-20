import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquisitionSha256 } from "../../../scripts/provenance-acquisition-record.mjs";
import { openAcquisitionHost } from "../../../scripts/provenance-acquisition-host-io.mjs";
import { createAcquisitionHostController } from "../../../scripts/provenance-acquisition-host.mjs";
import { runAcquisitionHostGuard, readHostGuardProfile } from "../../../scripts/provenance-acquisition-host-guard.mjs";
import { validateHostReport } from "../../../scripts/provenance-acquisition-host-profile.mjs";
import { hostProfile, hostModel, deferred } from "../../fixtures/provenance-acquisition-host.mjs";

async function controller(m, clock, role = "supervisor", profile = hostProfile()) {
  return createAcquisitionHostController(profile, role, { clock, openHost: (p, r) => openAcquisitionHost(p, r, m.port) });
}

test("revocation is immediate, immutable and independent of a pending freeze request", async () => {
  const held = deferred();
  const m = hostModel({ beforeWrite(node) { if (node.name === "cgroup.freeze") return held.promise; } });
  let now = 100n;
  const c = await controller(m, () => now); await c.poll();
  const r = c.contain("peer");
  assert.equal(r.revoked, true);
  assert.equal(r.firstFailure, "HOST_PEER");
  assert.deepEqual(m.calls.filter(x => x.kind === "write").map(x => x.name), ["cgroup.freeze", "cgroup.kill"]);
  const stable = JSON.stringify(r);
  c.contain("channel"); c.contain("deadline");
  assert.equal(m.calls.filter(x => x.kind === "write").length, 2);
  const closing = c.close();
  assert.equal(c.snapshot().ioClosed, "pending");
  held.resolve({ bytesWritten: 1 }); await closing;
  assert.equal(c.snapshot().firstFailure, "HOST_PEER");
  assert.equal(c.snapshot().ioClosed, "closed");
  assert.equal(JSON.stringify(r), stable);
  assert.equal(c.snapshot().externalClosure, "unqualified");
});

test("empty and frozen samples remain observations rather than global closure or admission", async () => {
  const m = hostModel(); m.nodes.case.children.get("cgroup.events").text = "populated 0\nfrozen 1\n";
  const c = await controller(m, () => 100n); await c.poll();
  assert.deepEqual(c.snapshot().observation, { atNs: "0", populated: false, frozen: true, error: null });
  assert.equal(c.snapshot().externalClosure, "unqualified");
  assert.equal(c.snapshot().releaseAdmission, "unqualified");
  m.nodes.case.children.get("cgroup.events").text = "populated 1\nfrozen 1\n";
  await c.poll(); assert.equal(c.snapshot().observation.populated, true);
  await c.close();
});

test("clock origin is fixed and regression/invalid clock/deadline cannot reopen a route", async () => {
  for (const invalid of [99n, "100", null, new Error("clock detail")]) {
    const m = hostModel(); let now = 100n;
    const c = await controller(m, () => { if (now instanceof Error) throw now; return now; }); await c.poll();
    now = invalid;
    assert.equal(c.check(), null);
    assert.equal(c.snapshot().firstFailure, "HOST_CLOCK");
    now = 100n; c.check(); await c.poll();
    assert.equal(c.snapshot().revoked, true);
    assert.equal(c.snapshot().clockAdmission, "unqualified");
    assert.equal(m.calls.filter(x => x.kind === "write").length, 2);
    await c.close();
  }
  const m = hostModel(); let opened = 0;
  await assert.rejects(createAcquisitionHostController(hostProfile(), "guard", { clock: () => 99n,
    openHost: () => { opened++; } }), { code: "HOST_CLOCK" });
  assert.equal(opened, 0);
  let now = 100n;
  const c = await controller(m, () => now); await c.poll();
  now += 10000000n; assert.equal(c.check(), "10000000");
  assert.equal(c.snapshot().firstFailure, "HOST_DEADLINE");
  await c.close();
});

test("bad native observation becomes unknown and keeps the first failure", async () => {
  const m = hostModel(); const c = await controller(m, () => 100n); await c.poll();
  m.nodes.case.children.get("cgroup.events").text = "populated 0\n";
  await c.poll();
  assert.equal(c.snapshot().observation.populated, null);
  assert.equal(c.snapshot().observation.error, "HOST_READ");
  assert.equal(c.snapshot().firstFailure, "HOST_READ");
  assert.equal(m.calls.filter(x => x.kind === "write").length, 2);
  await c.close();
});

test("guard reaches the original cutoff while native observation is stalled and preserves incomplete join", async () => {
  const held = deferred(); let now = 100n;
  const waits = []; let polls = 0; let arms = 0;
  const m = hostModel({ beforeRead: node => node.name === "cgroup.events" ? held.promise : undefined });
  const result = await runAcquisitionHostGuard(hostProfile(), { clock: () => now,
    wait: async ms => { waits.push(ms); now += BigInt(ms) * 1000000n; },
    onArmed: snapshot => { arms++; assert.equal(snapshot.actor, "guard"); },
    createController: async (p, role) => {
      const c = await controller(m, () => now, role, p); const poll = c.poll.bind(c);
      c.poll = () => { polls++; return poll(); }; return c;
    } });
  assert.deepEqual(waits, [5, 5, 5, 5]);
  assert.equal(polls, 1); assert.equal(arms, 1);
  assert.deepEqual(m.calls.filter(x => x.kind === "write").map(x => [x.name, x.text]), [["cgroup.freeze", "1"], ["cgroup.kill", "1"]]);
  assert.equal(result.observation.actor, "guard");
  assert.equal(result.observation.lastAtNs, "20000000");
  assert.equal(result.observation.firstFailure, "HOST_DEADLINE");
  assert.equal(result.observation.observation.populated, null);
  assert.equal(result.observation.ioClosed, "pending");
  assert.equal(result.observation.externalClosure, "unqualified");
  const frozen = JSON.stringify(result.observation);
  held.resolve();
  assert.equal((await result.settled).ioClosed, "closed");
  assert.equal(JSON.stringify(result.observation), frozen);
});

test("guard shortens waits at both absolute boundaries without renewing the origin", async () => {
  let now = 100n;
  const p = hostProfile(); p.stopAtNs = "7000000"; p.observeUntilNs = "13000000";
  const m = hostModel(); const waits = [];
  const result = await runAcquisitionHostGuard(p, { clock: () => now,
    wait: async ms => { waits.push(ms); now += BigInt(ms) * 1000000n; },
    createController: (data, role) => controller(m, () => now, role, data) });
  assert.deepEqual(waits, [5, 2, 5, 1]);
  assert.equal(result.observation.lastAtNs, "13000000");
  await result.settled;
});

test("guard profile is exact bounded original data; alias/hash/extra/key/size failures are closed", async t => {
  const root = await mkdtemp(join(tmpdir(), "tabgrad-host-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "profile.json");
  const bytes = Buffer.from(JSON.stringify(hostProfile())); await writeFile(path, bytes);
  assert.deepEqual(await readHostGuardProfile(path, acquisitionSha256(bytes)), hostProfile());
  await assert.rejects(readHostGuardProfile(path, "a".repeat(64)), { code: "HOST_INPUT" });
  const alias = join(root, "alias"); await symlink(path, alias);
  await assert.rejects(readHostGuardProfile(alias, acquisitionSha256(bytes)), { code: "HOST_INPUT" });
  const hard = join(root, "hard"); await link(path, hard);
  await assert.rejects(readHostGuardProfile(path, acquisitionSha256(bytes)), { code: "HOST_INPUT" });
  await rm(hard);
  const invalidUtf8 = Buffer.from(bytes); invalidUtf8[invalidUtf8.indexOf("owned")] = 255;
  for (const bad of [Buffer.from(JSON.stringify(hostProfile()) + "\n"), Buffer.from('{"x":1,"x":2}'), Buffer.alloc(32769, 32), Buffer.alloc(0), invalidUtf8]) {
    await writeFile(path, bad);
    await assert.rejects(readHostGuardProfile(path, acquisitionSha256(bad)), { code: "HOST_INPUT" });
  }
});

test("host report has a closed bounded domain without path/native diagnostic extensions", () => {
  assert.throws(() => validateHostReport({ nativeError: "path" }, "supervisor"), { code: "HOST_INPUT" });
});

test("a finite separate guard continues after parent IPC loss using synthetic native calls", { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "tabgrad-host-guard-"));
  const input = join(root, "input.json"); const output = join(root, "output.json");
  let child;
  t.after(async () => { if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true }); });
  const p = hostProfile(process.hrtime.bigint().toString());
  p.stopAtNs = "1000000000"; p.observeUntilNs = "1300000000"; p.pollMs = 20;
  const bytes = Buffer.from(JSON.stringify(p)); await writeFile(input, bytes);
  child = fork(new URL("../../fixtures/provenance-acquisition-host-guard.mjs", import.meta.url), [input, acquisitionSha256(bytes), output],
    { execArgv: [], env: {}, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exited = once(child, "exit");
  const [ready] = await once(child, "message");
  assert.deepEqual(ready, { kind: "ready", operationId: p.operationId });
  child.disconnect();
  const [code] = await exited; assert.equal(code, 0);
  const result = JSON.parse(await readFile(output, "utf8"));
  assert.equal(result.observation.actor, "guard");
  assert.equal(result.observation.firstFailure, "HOST_DEADLINE");
  assert.equal(result.observation.externalClosure, "unqualified");
  assert.equal(result.settled.ioClosed, "closed");
  assert.deepEqual(result.writes, [["cgroup.freeze", "1"], ["cgroup.kill", "1"]]);
});
