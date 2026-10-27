import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { copyLabExperimentPlan } from "../../../scripts/provenance-acquisition-lab-experiment-profile.mjs";
import { createLabExperiment, labExperimentMayAdvance } from "../../../scripts/provenance-acquisition-lab-experiment.mjs";
import { experimentModel } from "../../fixtures/provenance-acquisition-lab-experiment.mjs";
import { deferred } from "../../fixtures/provenance-acquisition-host.mjs";
import { AcquisitionRecordError } from "../../../scripts/provenance-acquisition-record.mjs";
import { acquisitionSha256 } from "../../../scripts/provenance-acquisition-record.mjs";
import { writeFile, readdir } from "node:fs/promises";
import { labPaths } from "../../../scripts/provenance-acquisition-lab-profile.mjs";
import { labWorkerPorts } from "../../fixtures/provenance-acquisition-lab.mjs";
import { NativeLabIO } from "../../../scripts/provenance-acquisition-lab-io.mjs";
import { LabClock } from "../../../scripts/provenance-acquisition-lab.mjs";

test("closed experiment binds independent labs, immutable inputs and one total allowance before effects", async () => {
  const m = await experimentModel();
  try {
    const p = copyLabExperimentPlan(m.plan); assert(Object.isFrozen(p.labs.A.tools));
    for (const change of [p => { p.labs.B.context.operationId = p.labs.A.context.operationId; },
      p => { p.labs.B.tools.node.sha256 = "0".repeat(64); }, p => { p.labs.C.diagnostic.case = "A"; },
      p => { p.labs.C.roots.scratch.path = p.labs.A.roots.scratch.path + "/child"; },
      p => { p.labs.B.roots.evidence.path = p.labs.A.roots.scratch.path; },
      p => { p.context.deadlineNs = "9050000000"; }, p => { p.limits.closeWaitMs = 201; },
      p => { Object.defineProperty(p, "diagnostic", { enumerable: true, get() { assert.fail("getter"); } }); }]) {
      const bad = structuredClone(m.plan); change(bad); assert.throws(() => createLabExperiment(bad), { code: "LAB_INPUT" });
    }
    assert.deepEqual(m.events, []);
  } finally { await m.close(); }
});

test("three actual bootstrap/exterior owners retire before the next selection, then preserve one private report", async () => {
  const m = await experimentModel();
  try {
    const owner = createLabExperiment(m.plan, { bootstrap: m.bootstrap, evidence: m.evidence, clock: () => 100n });
    const run = owner.run(); assert.equal(owner.run(), run); const state = await run;
    assert.equal(state.firstFailure, null); assert.equal(state.cleanupError, null); assert(state.locallyComplete);
    assert.equal(state.originNs, "100"); assert.equal(m.ports.length, 3); assert(m.writerClosed()); assert.equal(m.written.length, 1);
    for (const kind of ["A", "B", "C"]) assert(labExperimentMayAdvance(state.results[kind]));
    for (const change of [s => { s.lab.retirementObserved = false; }, s => { s.lab.io.kernel.handles.retained = 1; },
      s => { s.lab.pendingOperations = 1; }, s => { s.lab.io.activeCommands = 1; },
      s => { s.lab.io.diagnostic.expected = false; }, s => { s.input.handles.retained = 1; },
      s => { s.lab.io.preserved = false; }, s => { s.lab.io.registrationCollected = false; }]) {
      const partial = structuredClone(state.results.A); change(partial); assert(!labExperimentMayAdvance(partial));
    }
    for (const [first, second] of [["A", "B"], ["B", "C"]]) {
      const kill = m.events.findIndex(e => e[0] === "effect" && e[1] === first && e[2] === "unit.kill");
      const select = m.events.findIndex(e => e[0] === "select" && e[1] === second); assert(kill >= 0 && kill < select);
    }
    const safe = JSON.stringify(owner.summary()); assert(!safe.includes(m.input.directory)); assert(!safe.includes("/proc"));
    assert(!safe.includes("argv")); assert(!safe.includes("prefixes")); assert.equal(owner.summary().releaseAdmission, "unqualified");
    assert.deepEqual(await owner.close(), state);
  } finally { await m.close(); }
});

test("diagnostic work changes phase without renewing the original lab clock or consuming its retirement reserve", () => {
  let now = 100n;
  // The selected input materializes the same outer profile fields as the native input owner.
  const p = { context: { t0MonotonicNs: "100", deadlineNs: "3000000000" },
    limits: { prepareMs: 500, retireMs: 200 }, diagnostic: { case: "A" } };
  const clock = new LabClock(p, () => now); clock.beginDiagnostic();
  now = 500000100n; assert.equal(clock.work(), 500000000n);
  now = 2800000100n; assert.throws(() => clock.work(), { code: "LAB_DEADLINE" });
  assert.equal(clock.retire(), 2800000000n); assert.throws(() => clock.beginDiagnostic(), { code: "LAB_PROTOCOL" });
});

test("verified worker requires the exact exterior ready/plan/process permit before selecting diagnostic work", async () => {
  for (const mode of ["ready", "process", "accepted_then_revoked"]) {
    const m = await experimentModel();
    try {
      const p = structuredClone(m.input.profile); p.diagnostic = { ...m.plan.diagnostic, case: "A" }; p.limits.observationBytes = 1048576;
      await writeFile(labPaths(p).prefix + ".diagnostic.plan.json", JSON.stringify(m.diagnostic), { flag: "wx", mode: 0o600 });
      const ports = labWorkerPorts(p); let phaseChanges = 0;
      const io = new NativeLabIO(p, { work() {}, retire() {}, beginDiagnostic() { phaseChanges++; throw new AcquisitionRecordError("LAB_STOPPED"); } }, ports);
      const running = io.worker(); await ports.ready;
      const ready = JSON.parse(ports.originals.get("ready.json"));
      const start = { kind: "lab_diagnostic_start_v1", operationId: p.context.operationId, profileSha256: acquisitionSha256(JSON.stringify(p)),
        planSha256: p.diagnostic.sha256, case: "A", readySha256: acquisitionSha256(JSON.stringify(ready)), worker: structuredClone(ready.processes.worker) };
      if (mode === "ready") start.readySha256 = "0".repeat(64);
      if (mode === "process") start.worker.starttime = "501";
      await ports.files.json("diagnostic.start.json", start);
      await assert.rejects(running, { code: mode === "accepted_then_revoked" ? "LAB_STOPPED" : "LAB_IDENTITY" });
      assert.equal(phaseChanges, mode === "accepted_then_revoked" ? 1 : 0);
      assert.equal(ports.calls.filter(c => c[0] === "request").length, 2);
      io.revoke(); await io.close();
    } finally { await m.close(); }
  }
});

test("a mismatched ready binding or changed confirmed bytes blocks admission and the following lab", async () => {
  for (const mode of ["ready", "bytes"]) {
    const m = await experimentModel({ result(result, native) {
      if (mode === "ready") result.readySha256 = "0".repeat(64);
      else { const key = Object.keys(result.state.prefixes)[0]; result.state.prefixes[key].confirmedBytes = 1;
        native.originals.get(result.state.prefixes[key].name.slice(result.operationId.length + 1))[0] = 42; }
    } });
    try {
      const owner = createLabExperiment(m.plan, { bootstrap: m.bootstrap, evidence: m.evidence, clock: () => 100n });
      const state = await owner.run(); assert(!state.locallyComplete); assert(state.firstFailure);
      assert.equal(m.ports.length, 1); assert.equal(state.results.B, null); assert.equal(state.results.C, null);
    } finally { await m.close(); }
  }
});

test("incomplete whole-domain retirement cannot be escaped with a new lab name", async () => {
  const m = await experimentModel({ native(native) { native.kernel.observe = async () => { throw new AcquisitionRecordError("LAB_READ"); }; } });
  try {
    const owner = createLabExperiment(m.plan, { bootstrap: m.bootstrap, evidence: m.evidence, clock: () => 100n });
    const state = await owner.run(); assert(!state.locallyComplete); assert.equal(m.ports.length, 1);
    assert(!state.results.A.lab.retirementObserved); assert.equal(state.results.B, null); assert.equal(m.written.length, 1);
  } finally { await m.close(); }
});

test("the original total cutoff excludes the next full budget even when its fresh local clock would fit", async () => {
  let now = 100n; const m = await experimentModel();
  try {
    const owner = createLabExperiment(m.plan, { evidence: m.evidence, clock: () => now, bootstrap(input, ports) {
      const owner = m.bootstrap(input, ports); const run = owner.run.bind(owner);
      owner.run = async () => { const state = await run(); now += 7100000000n; return state; }; return owner;
    } });
    const state = await owner.run(); assert.equal(state.firstFailure, "LAB_DEADLINE"); assert.equal(m.ports.length, 1);
    assert.equal(state.results.B, null); assert.equal(state.originNs, "100"); assert(state.preserved);
  } finally { await m.close(); }
});

test("reentrant cancellation while selecting the next owner prevents its input observation and every later lab", async () => {
  const m = await experimentModel(); let owner;
  try {
    owner = createLabExperiment(m.plan, { evidence: m.evidence, clock: () => 100n, bootstrap(input, ports) {
      const child = m.bootstrap(input, ports); owner.stop(); return child;
    } });
    const state = await owner.run(); assert.equal(state.firstFailure, "LAB_STOPPED"); assert.equal(m.ports.length, 0);
    assert.equal(state.results.A, null); assert(!state.preserved); assert.equal(m.written.length, 0);
  } finally { await m.close(); }
});

test("a held input reader is bounded on cancellation and its late result cannot select a lab or write elsewhere", async () => {
  const enter = deferred(); const hold = deferred(); const m = await experimentModel();
  try {
    const owner = createLabExperiment(m.plan, { evidence: m.evidence, bootstrap: m.bootstrap, clock: () => 100n,
      async readDiagnosticPlan() { enter.resolve(); await hold.promise; return m.diagnostic; } });
    const run = owner.run(); await enter.promise; owner.stop(); const state = await run;
    assert.equal(state.firstFailure, "LAB_STOPPED"); assert.equal(state.cleanupError, "LAB_CLEANUP"); assert(state.workPending);
    hold.resolve(); await setImmediate(); assert(!owner.snapshot().workPending); assert.equal(m.ports.length, 0); assert.equal(m.written.length, 0);
  } finally { hold.resolve(); await m.close(); }
});

test("a preservation failure remains separate from completed laboratory results and never gets a fallback receipt", async () => {
  const m = await experimentModel({ write() { throw Error("PRIVATE_DIAGNOSTIC"); } });
  try {
    const owner = createLabExperiment(m.plan, { bootstrap: m.bootstrap, evidence: m.evidence, clock: () => 100n });
    const state = await owner.run(); assert(!state.locallyComplete); assert.equal(state.cleanupError, "LAB_PRESERVATION");
    assert.equal(m.written.length, 1); assert(m.writerClosed()); assert(!state.preserved);
    assert(!JSON.stringify(owner.summary()).includes("PRIVATE_DIAGNOSTIC"));
  } finally { await m.close(); }
});

test("the native report writer refuses an unadmitted actual anchor without writing a fallback report", async () => {
  const m = await experimentModel();
  try {
    // The input fixture supplies finite identities; these deliberately do not admit the actual directories.
    const owner = createLabExperiment(m.plan, { bootstrap: m.bootstrap, clock: () => 100n });
    const state = await owner.run(); assert(!state.locallyComplete); assert(!state.preserved);
    assert.equal(state.cleanupError, "LAB_IDENTITY"); assert.equal(owner.summary().recordSha256, null);
    const names = await readdir(m.plan.labs.A.roots.evidence.path);
    assert(!names.some(name => name.includes("experiment-")));
  } finally { await m.close(); }
});

test("explicit experiment entry is inert on import and rejects malformed arguments without leaking them", () => {
  const module = resolve("scripts/provenance-acquisition-lab-experiment-entry.mjs");
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(module)})`], { encoding: "utf8", timeout: 5000 });
  assert.equal(imported.status, 0); assert.equal(imported.stdout, ""); assert.equal(imported.stderr, "");
  const invalid = spawnSync(process.execPath, [module, "PRIVATE_ARGUMENT"], { encoding: "utf8", timeout: 5000 });
  assert.equal(invalid.status, 1); assert.equal(invalid.stdout, ""); assert.equal(invalid.stderr, "LAB_INPUT\n");
});
