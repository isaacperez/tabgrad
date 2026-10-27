import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTimeNamespaceOffsets, TIMENS_OFFSET_BYTES } from "../../../scripts/provenance-acquisition-monotonic-domain.mjs";
import { copyPlacementProfile } from "../../../scripts/provenance-acquisition-placement-profile.mjs";
import { createAcquisitionPlacement } from "../../../scripts/provenance-acquisition-placement.mjs";
import { placementGate, launchObservations, processStat } from "../../fixtures/provenance-acquisition-placement.mjs";
import { offsetText, monotonicModel } from "../../fixtures/provenance-acquisition-monotonic-domain.mjs";
import { deferred } from "../../fixtures/provenance-acquisition-host.mjs";

function ownerFor(m) { const g = placementGate(m.profile); g.time(1000n);
  return createAcquisitionPlacement(m.profile, { gate: g.gate, io: m.port }); }
async function start(m, owner) { await owner.open(); await owner.beforeStart(); m.activate(); return owner.afterStart(); }

test("kernel offset representation has an 84-byte bound and exact signed nanoseconds independent of boottime", () => {
  const edge = Buffer.from(offsetText("-9223372036854775808", "999999999", "-9223372036854775808", "999999999"));
  assert.equal(edge.length, TIMENS_OFFSET_BYTES);
  assert.equal(parseTimeNamespaceOffsets(edge).monotonicNs, "-9223372036854775807000000001");
  assert.deepEqual(parseTimeNamespaceOffsets(Buffer.from(offsetText("-1", "500000000", "7", "3"))),
    { monotonicNs: "-500000000", boottimeNs: "7000000003" });
  for (const value of [offsetText().replace("monotonic", "boottime"), offsetText().trimEnd(),
    offsetText("-0"), offsetText("01"), offsetText("9223372036854775808"), offsetText("0", "1000000000"),
    offsetText() + "extra\n", "x".repeat(TIMENS_OFFSET_BYTES + 1)]) {
    assert.throws(() => parseTimeNamespaceOffsets(Buffer.from(value)));
  }
});

test("opt-in exact monotonic domains admit separate init namespace while preserving original bytes and default policy", async () => {
  const m = monotonicModel();
  m.processes[777].children.get("timens_offsets").text = offsetText("-1", "500000000", "1");
  const owner = ownerFor(m);
  await owner.open(); await owner.beforeStart(); m.activate();
  m.processes[1001].children.get("timens_offsets").text = offsetText("-1", "500000000", "9");
  assert((await owner.afterStart()).mayExec);
  m.program(); const end = await owner.observeExecution(launchObservations(m.profile));
  assert(end.executionObserved); assert.equal(end.io.subjects.init.namespaces.time.ino, "30");
  assert.equal(end.io.clockObserver.namespaces.time.ino, "12");
  assert.notEqual(end.io.subjects.init.clock.offsets.boottimeNs, end.io.clockObserver.clock.offsets.boottimeNs);
  assert.equal(end.clockAdmission, "unqualified");
  const originals = owner.collect(); assert.equal(originals.init.timensOffsets.toString(), offsetText("-1", "500000000", "9"));
  assert(originals.clockObserver.clockStatBefore); originals.init.timensOffsets.fill(0);
  assert.notDeepEqual(originals.init.timensOffsets, owner.collect().init.timensOffsets);
  await owner.close(); assert([...m.handles.values()].every(h => h.closed));
  const strict = monotonicModel(); delete strict.profile.clockPolicy;
  const previous = ownerFor(strict); assert.equal((await start(strict, previous)).firstFailure, "PLACEMENT_IDENTITY");
  await previous.close(); assert(!strict.calls.some(c => c.kind === "read" && c.name === "timens_offsets"));
  const bad = monotonicModel().profile; bad.clockPolicy = "nearby_samples";
  assert.throws(() => copyPlacementProfile(bad), { code: "PLACEMENT_INPUT" });
});

test("one-nanosecond differences above safe Number range fail and retain rejected offset originals", async () => {
  const m = monotonicModel(); m.processes[777].children.get("timens_offsets").text = offsetText("9007199", "254740992");
  const owner = ownerFor(m); await owner.open(); await owner.beforeStart(); m.activate();
  m.processes[1001].children.get("timens_offsets").text = offsetText("9007199", "254740993");
  const result = await owner.afterStart(); assert.equal(result.firstFailure, "PLACEMENT_IDENTITY"); assert(!result.mayExec);
  await owner.join(); assert.equal(owner.collect().rejectedClock.timensOffsets.toString(), offsetText("9007199", "254740993"));
  assert.equal(result.io.rejectedClock.role, "init"); assert([...m.handles.values()].every(h => h.closed));
});

test("children association, replacement, birth change, missing offsets and overflow independently reject", async () => {
  for (const mode of ["children", "replacement", "birth", "missing", "overflow"]) {
    let m; let changed = false;
    m = monotonicModel({ beforeRead(node) {
      if (!changed && node.name === "timens_offsets" && m.processes[1001]?.children.get("timens_offsets") === node) {
        changed = true;
        if (mode === "replacement") m.processes[1001].children.get("ns/time").ino = 31n;
        if (mode === "birth") m.processes[1001].children.get("stat").text = processStat("1001", "2", "501");
      }
    } });
    const owner = ownerFor(m); await owner.open(); await owner.beforeStart(); m.activate();
    const dir = m.processes[1001];
    if (mode === "children") dir.children.set("ns/time_for_children", m.processes[777].children.get("ns/time"));
    if (mode === "missing") dir.children.delete("timens_offsets");
    if (mode === "overflow") dir.children.get("timens_offsets").text = "x".repeat(100);
    const result = await owner.afterStart(); assert(result.firstFailure, mode); assert(!result.mayExec); await owner.join();
    assert([...m.handles.values()].every(h => h.closed), mode); assert.equal(owner.snapshot().io.rejectedClock.role, "init");
    if (mode === "overflow") assert.equal(owner.collect().rejectedClock.timensOffsets.length, 85);
  }
});

test("a launcher with a third time namespace never inherits init's counter admission", async () => {
  const m = monotonicModel(); const owner = ownerFor(m); assert((await start(m, owner)).mayExec); m.program();
  const third = m.file("time"); third.dev = 3n; third.ino = 99n; third.filesystem = 0x6e736673n;
  m.processes[1002].children.set("ns/time", third);
  assert.equal((await owner.observeExecution(launchObservations(m.profile))).firstFailure, "PLACEMENT_IDENTITY");
  await owner.join(); assert([...m.handles.values()].every(h => h.closed));
});

test("late namespace openings remain joined after cancellation and cannot restore admission", async () => {
  const enter = deferred(); const hold = deferred(); let armed = false;
  const m = monotonicModel({ async beforeOpen(path) { if (armed && path.endsWith("/ns/time_for_children")) {
    armed = false; enter.resolve(); await hold.promise;
  } } }); const owner = ownerFor(m);
  await owner.open(); await owner.beforeStart(); m.activate(); armed = true;
  const read = owner.afterStart(); await enter.promise; owner.stop();
  assert(owner.snapshot().closing); hold.resolve(); await read; await owner.join();
  assert(!owner.snapshot().mayExec); assert.equal(owner.snapshot().firstFailure, "PLACEMENT_STOPPED");
  assert([...m.handles.values()].every(h => h.closed));
});
