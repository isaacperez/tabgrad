import assert from "node:assert/strict";
import { test } from "node:test";
import { createAcquisitionPlacement } from "../../../scripts/provenance-acquisition-placement.mjs";
import { AcquisitionRecordError } from "../../../scripts/provenance-acquisition-record.mjs";
import { copyPlacementProfile, parsePlacementPids, parsePlacementStat,
  parsePlacementStatus } from "../../../scripts/provenance-acquisition-placement-profile.mjs";
import { placementProfile, placementModel, placementGate, launchObservations, processStat } from "../../fixtures/provenance-acquisition-placement.mjs";
import { deferred } from "../../fixtures/provenance-acquisition-host.mjs";

async function ready(options = {}) {
  const p = placementProfile(); const m = placementModel(p, options); const g = placementGate(p);
  const owner = createAcquisitionPlacement(p, { gate: g.gate, io: m.port });
  await owner.open(); await owner.beforeStart(); m.activate(); await owner.afterStart();
  assert.equal(owner.snapshot().firstFailure, null); assert.equal(owner.snapshot().mayExec, true);
  return { p, m, g, owner };
}

test("inert copied bindings and actual finite reads distinguish pre-control clocks from permission", async () => {
  const p = placementProfile(); const m = placementModel(p, { shortRead: 1 }); const g = placementGate(p);
  const owner = createAcquisitionPlacement(p, { gate: g.gate, io: m.port });
  assert.deepEqual(m.calls, []); assert.deepEqual(g.reads, []);
  const binding = owner.binding; p.containerId = "f".repeat(64); p.hierarchy.case[0].name = "wrong";
  g.gate.observe = () => { throw Error("replaced"); }; m.port.open = () => { throw Error("replaced"); };
  assert.equal(owner.binding, binding); assert(Object.isFrozen(binding.hierarchy.case));
  const open = owner.open(); assert.equal(owner.open(), open); assert.equal((await open).io.opened, true);
  assert(g.reads.every(v => v === "observe"));
  assert.equal((await owner.beforeStart()).io.beforeChecked, true); assert(g.reads.includes("check"));
  // Mutating the original input cannot retarget the model or the operation.
  m.profile.containerId = binding.containerId; m.activate();
  const placed = await owner.afterStart(); assert.equal(placed.mayExec, true); assert.equal(placed.executionObserved, false);
  m.program(); const observed = await owner.observeExecution(launchObservations(binding));
  assert.equal(observed.executionObserved, true); assert.equal(observed.io.subjects.program.ppid, "1002");
  const originals = owner.collect(); assert.equal(originals.program.cgroup.toString(), `0::/case/${binding.containerId}\n`);
  originals.program.cgroup.fill(0); assert.notDeepEqual(owner.collect().program.cgroup, originals.program.cgroup);
  const end = await owner.close(); assert.equal(end.io.ioClosed, "closed"); assert.equal(end.mayExec, false);
  assert.equal(end.externalClosure, "unqualified"); assert.equal(end.clockAdmission, "unqualified");
  assert([...m.handles.values()].every(h => h.closed));
  assert(m.calls.every(c => c.kind !== "write"));
});

test("closed data rejects accessors, extra fields, aliases and invalid limits before callbacks or I/O", () => {
  const variants = [p => { p.extra = true; }, p => { p.limits.procBytes = 0; },
    p => { p.hierarchy.case[0].identity = p.hierarchy.root.identity; }, p => { p.proc.path = "/proc/../other"; },
    p => { p.proc.path = "/bad\ud800"; },
    p => { Object.defineProperty(p, "containerId", { get() { assert.fail("getter"); }, enumerable: true }); }];
  for (const mutate of variants) {
    const p = placementProfile(); const m = placementModel(p); const g = placementGate(p); mutate(p);
    assert.throws(() => createAcquisitionPlacement(p, { gate: g.gate, io: m.port }), { code: "PLACEMENT_INPUT" });
    assert.deepEqual(m.calls, []); assert.deepEqual(g.reads, []);
  }
});

test("proc parsers handle comm delimiters, namespace vectors and repeated unordered cgroup PIDs", () => {
  assert.equal(parsePlacementStat(Buffer.from(processStat("7", "2", "99", "R", "a ) b\nc"))).starttime, "99");
  assert.deepEqual(parsePlacementPids(Buffer.from("8\n7\n8\n"), 2), ["8", "7"]);
  assert.throws(() => parsePlacementPids(Buffer.from("8\n7\n"), 1), { code: "PLACEMENT_LIMIT" });
  for (const bytes of ["8", "0\n", "08\n", "1\r\n", "1\n\n"]) assert.throws(() => parsePlacementPids(Buffer.from(bytes), 8));
  for (const bytes of ["", "7 (node) S 0\n", processStat("7", "2", "99").slice(0, -1)]) assert.throws(() => parsePlacementStat(Buffer.from(bytes)));
  const status = "Pid:\t8\nTgid:\t8\nNSpid:\t8\t1\nNStgid:\t8\t1\n";
  assert.deepEqual(parsePlacementStatus(Buffer.from(status)).namespacePids, ["8", "1"]);
  for (const bytes of [status.slice(0, -1), status + "NSpid:\t8\t1\n", status.replace("NStgid:\t8\t1", "NStgid:\t8\t2")]) {
    assert.throws(() => parsePlacementStatus(Buffer.from(bytes)));
  }
});

test("independent anchor, view, init and runtime-leaf mismatches never admit Exec", async () => {
  for (const mutate of [m => { m.nodes.case.ino = 999n; }, m => { m.proc.filesystem = 1n; },
    m => { m.processes[777].children.get("ns/time").ino = 999n; }]) {
    const p = placementProfile(); const m = placementModel(p); const g = placementGate(p); mutate(m);
    const owner = createAcquisitionPlacement(p, { gate: g.gate, io: m.port });
    assert.equal((await owner.open()).mayExec, false); assert(owner.snapshot().firstFailure);
    assert.equal((await owner.join()).io.ioClosed, "closed");
  }
  for (const mutate of [m => { m.procs.text = ""; }, m => { m.leaf.children.get("cgroup.type").text = "threaded\n"; },
    m => { m.processes[1001].children.get("cgroup").text = "0::/other\n"; },
    m => { m.processes[1001].children.get("ns/time").ino = 999n; }]) {
    const p = placementProfile(); const m = placementModel(p); const g = placementGate(p);
    const owner = createAcquisitionPlacement(p, { gate: g.gate, io: m.port });
    await owner.open(); await owner.beforeStart(); m.activate(); mutate(m);
    assert.equal((await owner.afterStart()).mayExec, false); assert(owner.snapshot().firstFailure);
    await owner.join(); assert([...m.handles.values()].every(h => h.closed));
  }
});

test("preexisting or replaced fixed leaf rejects without favorable reopen, retry or another name", async () => {
  const p = placementProfile(); const m = placementModel(p); const g = placementGate(p);
  const owner = createAcquisitionPlacement(p, { gate: g.gate, io: m.port }); await owner.open(); m.activate();
  assert.equal((await owner.beforeStart()).firstFailure, "PLACEMENT_IDENTITY"); await owner.join();
  const f = await ready(); const old = f.owner.snapshot();
  f.m.program(); f.m.nodes.case.children.set(f.p.containerId, f.m.directory("replacement", 999n));
  const end = await f.owner.observeExecution(launchObservations(f.p));
  assert.equal(end.firstFailure, "PLACEMENT_IDENTITY"); assert.equal(old.mayExec, true); assert.equal(old.io.subjects.program, undefined);
  await f.owner.join(); assert(f.m.calls.every(c => c.kind !== "write"));
});

test("namespace, birth, parent and disappearance are separate from a matching internal PID", async () => {
  const mutations = [m => { m.processes[1003].children.get("ns/pid").ino = 555n; },
    m => { m.processes[1003].children.get("stat").text = processStat("1003", "7"); },
    m => { m.proc.children.delete("1003"); },
    m => { m.processes[1003].children.get("status").text = "Pid:\t1003\nTgid:\t1003\nNSpid:\t1003\t102\nNStgid:\t1003\t102\n"; }];
  for (const mutate of mutations) {
    const f = await ready(); f.m.program(); mutate(f.m);
    const end = await f.owner.observeExecution(launchObservations(f.p));
    assert.equal(end.executionObserved, false); assert(end.firstFailure); await f.owner.join();
  }
  let reads = 0; let model;
  const f = await ready({ beforeRead(node, buffer, offset, length, position) {
    if (model && node === model.processes[1003].children.get("stat") && position === 0 && ++reads === 2) {
      node.text = processStat("1003", "1002", "501");
    }
  } }); model = f.m; f.m.program();
  assert.equal((await f.owner.observeExecution(launchObservations(f.p))).executionObserved, false); await f.owner.join();
});

test("stop during an admitted late opening adopts its handle and never opens another one", async () => {
  const hold = deferred(); const entered = deferred(); let armed = false;
  const p = placementProfile(); const m = placementModel(p, { async beforeOpen() {
    if (!armed) { armed = true; entered.resolve(); await hold.promise; }
  } }); const g = placementGate(p); const owner = createAcquisitionPlacement(p, { gate: g.gate, io: m.port });
  const pending = owner.open(); await entered.promise; const stopped = owner.stop();
  assert.equal(stopped.firstFailure, "PLACEMENT_STOPPED"); assert.equal(stopped.pending, "open");
  hold.resolve(); await pending; const end = await owner.join();
  assert.equal(end.io.ioClosed, "closed"); assert.equal(end.mayExec, false);
  assert.equal(m.calls.filter(c => c.kind === "open").length, 1); assert([...m.handles.values()].every(h => h.closed));
});

test("polling observes original clock/gate failure while native work remains pending", async () => {
  const hold = deferred(); const entered = deferred(); let armed = false;
  const p = placementProfile(); const m = placementModel(p, { async beforeOpen() {
    if (!armed) { armed = true; entered.resolve(); await hold.promise; }
  } }); const g = placementGate(p); const owner = createAcquisitionPlacement(p, { gate: g.gate, io: m.port });
  const pending = owner.open(); await entered.promise; g.time(99n);
  assert.equal(owner.poll().firstFailure, "PLACEMENT_CLOCK"); hold.resolve(); await pending; await owner.join();
  assert.equal(g.revocations.length, 1); assert.equal(owner.snapshot().executionObserved, false);
});

test("stop during a short leaf type read admits no subsequent read syscall", async () => {
  const p = placementProfile(); let owner; let model; let reads = 0;
  const m = placementModel(p, { shortRead: 1, beforeRead(node) {
    if (model && node === model.leaf.children.get("cgroup.type")) { reads++; owner.stop(); }
  } }); model = m; const g = placementGate(p);
  owner = createAcquisitionPlacement(p, { gate: g.gate, io: m.port });
  await owner.open(); await owner.beforeStart(); m.activate();
  const end = await owner.afterStart(); await owner.join();
  assert.equal(reads, 1); assert.equal(end.firstFailure, "PLACEMENT_STOPPED");
  assert.equal(end.mayExec, false); assert.equal(g.revocations.length, 1);
  assert(!m.calls.some(c => c.kind === "read" && c.name === "cgroup.procs"));
  assert([...m.handles.values()].every(h => h.closed));
});

test("rejected temporary closes stay owned, counted and never retried", async () => {
  const p = placementProfile(); const m = placementModel(p, { beforeClose(node) {
    if (node.name === "777") throw Error("finite private temporary close detail");
  } }); const g = placementGate(p);
  const owner = createAcquisitionPlacement(p, { gate: g.gate, io: m.port });
  const old = owner.snapshot(); const end = await owner.open(); const joined = await owner.join();
  assert.equal(end.firstFailure, "PLACEMENT_CLOSE"); assert.equal(joined.io.ioClosed, "unknown");
  assert.equal(joined.io.unconfirmedCloses, 1); assert.equal(old.io.unconfirmedCloses, 0);
  assert.equal(joined.cleanupError, "PLACEMENT_CLOSE");
  for (const fd of m.handles.keys()) assert.equal(m.calls.filter(c => c.kind === "close" && c.fd === fd).length, 1);
  assert(!JSON.stringify(joined).includes("private temporary close detail"));
});

test("a failed temporary close cannot replace an earlier identity failure", async () => {
  const p = placementProfile(); const m = placementModel(p, { beforeClose(node) {
    if (node.name === "777") throw Error("finite close failure");
  } }); m.processes[777].children.get("ns/time").ino = 999n;
  const g = placementGate(p); const owner = createAcquisitionPlacement(p, { gate: g.gate, io: m.port });
  const end = await owner.open(); const joined = await owner.join();
  assert.equal(end.firstFailure, "PLACEMENT_IDENTITY"); assert.equal(joined.cleanupError, "PLACEMENT_CLOSE");
  assert.equal(joined.io.unconfirmedCloses, 1); assert.equal(joined.io.ioClosed, "unknown");
});

test("byte capacity, process count and positive short reads are independently checked", async () => {
  for (const [limit, value] of [["procBytes", 4], ["procsBytes", 3], ["maxProcesses", 1]]) {
    const p = placementProfile(); p.limits[limit] = value; const m = placementModel(p); const g = placementGate(p);
    const owner = createAcquisitionPlacement(p, { gate: g.gate, io: m.port }); await owner.open();
    if (!owner.snapshot().firstFailure) {
      await owner.beforeStart(); m.activate(); await owner.afterStart(); m.program(); await owner.observeExecution(launchObservations(p));
    }
    assert(owner.snapshot().firstFailure); await owner.join();
  }
  const p = copyPlacementProfile(placementProfile()); assert(Object.isFrozen(p.limits));
});

test("stop at the permission callback admits no leaf probe and keeps the first cause", async () => {
  const p = placementProfile(); const m = placementModel(p); let owner;
  const g = placementGate(p, { check() { owner.stop(); } });
  owner = createAcquisitionPlacement(p, { gate: g.gate, io: m.port }); await owner.open();
  const count = m.calls.filter(c => c.kind === "open").length;
  const end = await owner.beforeStart(); assert.equal(end.firstFailure, "PLACEMENT_STOPPED");
  assert.equal(end.io.beforeChecked, false); assert.equal(m.calls.filter(c => c.kind === "open").length, count);
  await owner.join(); assert.equal(g.revocations.length, 1);
});

test("an admitted stalled subject read keeps close pending and late bytes cannot restore placement", async () => {
  const held = deferred(); const entered = deferred(); let model; let once = false;
  const f = await ready({ async beforeRead(node) {
    if (model && node === model.processes[1003].children.get("stat") && !once) {
      once = true; entered.resolve(); await held.promise;
    }
  } }); model = f.m; f.m.program();
  const pending = f.owner.observeExecution(launchObservations(f.p)); await entered.promise;
  const count = f.m.calls.filter(c => c.kind === "open").length;
  const old = f.owner.stop(); assert.equal(old.io.ioClosed, "open");
  await Promise.resolve(); assert.equal(f.owner.snapshot().io.ioClosed, "pending");
  held.resolve(); await pending; const end = await f.owner.join();
  assert.equal(end.firstFailure, "PLACEMENT_STOPPED"); assert.equal(end.executionObserved, false);
  assert.equal(end.io.ioClosed, "closed"); assert.equal(f.m.calls.filter(c => c.kind === "open").length, count);
  assert.equal(old.pending, "launcher"); assert.equal(old.io.ioPending, true);
});

test("normal scheduling state changes do not masquerade as process identity changes", async () => {
  let model; let n = 0;
  const f = await ready({ beforeRead(node, buffer, offset, length, position) {
    if (model && node === model.processes[1003].children.get("stat") && position === 0 && ++n === 2) {
      node.text = processStat("1003", "1002", "500", "R", "different comm");
    }
  } }); model = f.m; f.m.program();
  const end = await f.owner.observeExecution(launchObservations(f.p));
  assert.equal(end.executionObserved, true); assert.equal(end.io.subjects.program.state, "R"); await f.owner.close();
});

test("original cutoff, regressive/unavailable time and wrong sequence fail without new native work", async () => {
  for (const value of [100n, undefined, 3000000100n]) {
    const f = await ready(); const count = f.m.calls.length; f.g.time(value);
    const end = f.owner.poll(); assert.equal(end.mayExec, false);
    assert.equal(end.firstFailure, value === 3000000100n ? "PLACEMENT_DEADLINE" : "PLACEMENT_CLOCK");
    assert.equal(f.m.calls.length, count); await f.owner.join(); assert.equal(f.g.revocations.length, 1);
  }
  const p = placementProfile(); const m = placementModel(p); const g = placementGate(p);
  const owner = createAcquisitionPlacement(p, { gate: g.gate, io: m.port });
  assert.equal((await owner.afterStart()).firstFailure, "PLACEMENT_PROTOCOL"); await owner.join();
  assert.deepEqual(m.calls, []);
});

test("execution observation preserves clock, gate and deadline causes before reading launch data", async () => {
  for (const [cause, value] of [["PLACEMENT_CLOCK", 99n], ["PLACEMENT_DEADLINE", 3000000100n], ["PLACEMENT_GATE", null]]) {
    let broken = false; const p = placementProfile(); const m = placementModel(p);
    const g = placementGate(p, { check() { if (broken) throw Error("finite private gate detail"); } });
    const owner = createAcquisitionPlacement(p, { gate: g.gate, io: m.port });
    await owner.open(); await owner.beforeStart(); m.activate(); await owner.afterStart();
    assert.equal(owner.snapshot().mayExec, true); const count = m.calls.length;
    if (value === null) broken = true; else g.time(value);
    const end = await owner.observeExecution(launchObservations(p));
    assert.equal(end.firstFailure, cause); assert.deepEqual(g.revocations, [cause]);
    assert.equal(end.executionObserved, false);
    assert(m.calls.slice(count).every(c => c.kind === "close")); await owner.join();
    assert(!JSON.stringify(end).includes("private gate detail"));
  }
  const f = await ready(); assert.equal((await f.owner.observeExecution({ R: "malformed" })).firstFailure, "PLACEMENT_PROTOCOL");
  await f.owner.join();
});

test("closure failure is separate, attempts each known handle once and does not rewrite prior observations", async () => {
  const p = placementProfile(); const m = placementModel(p, { beforeClose(node) {
    if (node.name === "case") throw Error("finite private close detail");
  } }); const g = placementGate(p); const owner = createAcquisitionPlacement(p, { gate: g.gate, io: m.port });
  await owner.open(); const old = owner.snapshot(); const closing = owner.close();
  assert.equal(owner.close(), closing); const end = await closing;
  assert.equal(end.cleanupError, "PLACEMENT_CLOSE"); assert.equal(end.io.ioClosed, "unknown");
  assert.equal(end.firstFailure, null); assert.equal(old.io.ioClosed, "open");
  for (const fd of m.handles.keys()) assert.equal(m.calls.filter(c => c.kind === "close" && c.fd === fd).length, 1);
  assert(!JSON.stringify(end).includes("private close detail"));
});

test("fixed subject slots avoid repeat native scans after the execution observations complete", async () => {
  const f = await ready(); f.m.program(); const observations = launchObservations(f.p);
  assert.equal((await f.owner.observeExecution(observations)).executionObserved, true);
  const count = f.m.calls.length;
  for (let n = 0; n < 20; n++) assert.equal((await f.owner.observeExecution(observations)).executionObserved, true);
  assert.equal(f.m.calls.length, count); assert.equal(Object.keys(f.owner.snapshot().io.subjects).length, 3);
  for (const source of Object.values(f.owner.collect())) assert.equal(Object.keys(source).length, 4);
  await f.owner.close();
});

test("a deeper expected case route is retained component by component with exact global membership", async () => {
  const p = placementProfile(); p.hierarchy.case.unshift({ name: "outer", identity: { dev: "1", ino: "50" } });
  const m = placementModel(p); const outer = m.directory("outer", 50n);
  m.owned.children.delete("case"); m.owned.children.set("outer", outer); outer.children.set("case", m.nodes.case);
  const g = placementGate(p); const owner = createAcquisitionPlacement(p, { gate: g.gate, io: m.port });
  await owner.open(); await owner.beforeStart(); m.activate(); assert.equal((await owner.afterStart()).mayExec, true);
  m.program(); assert.equal((await owner.observeExecution(launchObservations(p))).executionObserved, true);
  assert.equal(owner.collect().program.cgroup.toString(), `0::/outer/case/${p.containerId}\n`); await owner.close();
});

test("malformed read counts and unexpected branded errors cannot escape bounds or leak native detail", async () => {
  for (const value of [-1, Infinity, "1", 100000]) {
    const p = placementProfile(); const m = placementModel(p, { beforeRead() { return { bytesRead: value }; } });
    const g = placementGate(p); const owner = createAcquisitionPlacement(p, { gate: g.gate, io: m.port });
    const end = await owner.open(); assert.equal(end.firstFailure, "PLACEMENT_READ"); await owner.join();
    assert([...m.handles.values()].every(h => h.closed));
  }
  const p = placementProfile(); const m = placementModel(p, { beforeOpen() {
    throw new AcquisitionRecordError("PLACEMENT_FINITE_PRIVATE_DETAIL");
  } }); const g = placementGate(p); const owner = createAcquisitionPlacement(p, { gate: g.gate, io: m.port });
  const end = await owner.open(); assert.equal(end.firstFailure, "PLACEMENT_OPEN"); await owner.join();
  assert(!JSON.stringify(end).includes("PRIVATE_DETAIL"));
});
