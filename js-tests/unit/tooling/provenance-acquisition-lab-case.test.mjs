import assert from "node:assert/strict";
import { test } from "node:test";
import { LabDiagnosticCase } from "../../../scripts/provenance-acquisition-lab-case.mjs";
import { labCaseLocallyJoined, labCaseOutcome, labCaseAttemptMetadata, labCasePrefixes } from "../../../scripts/provenance-acquisition-lab-case-result.mjs";
import { LabHandles } from "../../../scripts/provenance-acquisition-lab-command.mjs";
import { diagnosticDockerModel } from "../../fixtures/provenance-acquisition-lab-diagnostic.mjs";
import { caseFilesModel } from "../../fixtures/provenance-acquisition-case-files.mjs";
import { diagnosticEnding } from "../../fixtures/provenance-acquisition-lab-outcome.mjs";
import { hostProfile, deferred } from "../../fixtures/provenance-acquisition-host.mjs";
import { acquisitionSha256 } from "../../../scripts/provenance-acquisition-record.mjs";

test("diagnostic ending distinguishes expected B/C failures from joins and preserves every original", () => {
  for (const kind of ["A", "B", "C"]) {
    const state = diagnosticEnding(kind); const outcome = labCaseOutcome(kind, state);
    assert(labCaseLocallyJoined(state)); assert(outcome.expected); assert.equal(outcome.firstFailure, state.firstFailure);
    assert.equal(outcome.cleanupError, state.cleanupError); assert.equal(outcome.releaseAdmission, "unqualified");
    assert.equal(outcome.caseRetirement, "unknown"); if (kind !== "A") assert(!outcome.localCaptureComplete);
    const metadata = labCaseAttemptMetadata(state); assert.equal(metadata.controlsResult.process.parts.header.bytes, undefined);
    assert.equal(state.controlsResult.process.parts.header.bytes.length, 0);
    for (const change of [s => { s.capture.fifo.pendingEffects = 1; }, s => { s.activation.transportClosed = false; },
      s => { s.controls.process.children.supervisor.firstError = "cleanup"; }, s => { s.controls.guard.signal = "SIGKILL"; },
      s => { s.controls.process.collection.formatComplete = false; }, s => { s.cleanupWaitExpired = true; },
      s => { s.controls.process.actors.watchdog.host.ioClosed = "unknown"; }, s => { s.capture.files.program.channels.stdout.sha256 = "0".repeat(64); }]) {
      const bad = diagnosticEnding(kind); change(bad); assert(!labCaseOutcome(kind, bad).expected, kind);
    }
  }
  const bad = diagnosticEnding("B"); bad.capture.control.observations.E.cleanupError = "LAUNCH_CLOSE";
  assert(!labCaseOutcome("B", bad).expected);
  const short = diagnosticEnding("C"); short.controls.guard.report.observation.populated = true;
  assert(!labCaseOutcome("C", short).expected);
  for (const kind of ["B", "C"]) for (const change of [s => { s.placement.io.subjects.program.namespacePids = ["1004", "4"]; },
    s => { s.firstFailure = "PLACEMENT_IDENTITY"; }, s => { s.placement.firstFailure = "PLACEMENT_GATE"; }]) {
    const bad = diagnosticEnding(kind); change(bad); assert(!labCaseOutcome(kind, bad).expected);
  }
});

test("unobserved producer has an explicitly unavailable zero prefix and never infers padding", () => {
  const files = { raw: { header: { name: "private.header", identity: { dev: "1", ino: "2" }, capacity: 32768 } } };
  const p = labCasePrefixes(files, null).header;
  assert.equal(p.confirmedBytes, 0); assert.equal(p.producerObservation, "unavailable"); assert(p.uncertain);
  assert.equal(p.continuation, "unknown_after_last_observation"); assert.equal(p.sha256, acquisitionSha256(Buffer.alloc(0)));
});

async function caseOwner(kind, options = {}) {
  const m = await caseFilesModel(options.files); const docker = diagnosticDockerModel(options.docker);
  const plan = { ...docker.plan, launcherFiles: m.plan.launcherFiles }; const handles = new LabHandles();
  const lab = m.lab; lab.diagnostic = { path: "/private/plan.json", sha256: "b".repeat(64), case: kind };
  const counts = { startup: 0, attempts: 0, runs: 0, stops: 0, startupFinished: false };
  const records = new Map();
  const files = { ...m.files, async write(label, bytes) { return m.files.json(label, { finiteBytes: [...bytes] }); } };
  const filesystem = { ...m.port, lstat: docker.filesystem.lstat,
    open(path, ...args) { return path === plan.image.archive.path ? docker.filesystem.open(path, ...args) : m.port.open(path, ...args); } };
  const startup = { snapshot: () => ({ finished: counts.startupFinished }), stop() { assert(!counts.startupFinished); },
    async finish() { counts.startupFinished = true; } };
  const attempt = { async run() { counts.runs++; await options.run?.(); counts.startupFinished = true; return diagnosticEnding(kind); },
    stop() { counts.stops++; }, async join() {}, snapshot: () => diagnosticEnding(kind), collectPlacement: () => ({}) };
  let owner;
  const ports = { files, retirementFiles: files, handles, filesystem, request: docker.request, command: m.command,
    kernel: { caseHierarchy: async () => ({ casePath: "/case", groups: hostProfile().groups }) },
    clock: () => options.now?.() ?? 1000n, check() { options.check?.(owner); },
    async startupFactory() { counts.startup++; await options.startup?.(owner); return startup; },
    attemptFactory() { counts.attempts++; options.attempt?.(owner); return attempt; } };
  // All originals use finite maps; only m's protected ordinary directory is real.
  docker.files.write = async (label, bytes) => { records.set(label, Buffer.from(bytes)); return { label, bytes: bytes.length, sha256: acquisitionSha256(bytes) }; };
  owner = new LabDiagnosticCase(lab, plan, docker.socket, ports);
  return { owner, m, docker, handles, counts, close: async () => { await owner.close(); await handles.closeAll(); await m.close(); } };
}

test("one-case owner composes actual preparation and profile codecs then retains its diagnostic ending", async () => {
  for (const kind of ["A", "B", "C"]) {
    const f = await caseOwner(kind);
    try {
      assert.equal(f.docker.requests.length, 0); const run = f.owner.run(); assert.equal(f.owner.run(), run);
      const state = await run; await f.owner.close();
      assert.equal(state.firstFailure, null); assert(state.outcome.expected); assert.equal(Object.keys(state.prefixes).length, 9);
      assert.equal(f.counts.startup, 1); assert.equal(f.counts.attempts, 1); assert.equal(f.counts.runs, 1);
      assert.equal(f.owner.snapshot().cleanupError, null); assert(f.owner.snapshot().preservationComplete);
      assert.equal(f.docker.requests.length, 5); assert.equal(f.owner.report().attempt.activation.effectState, "unknown");
    } finally { await f.close(); }
  }
});

test("reentrant case cancellation at factory selection transfers revocation and cannot start the attempt", async () => {
  const f = await caseOwner("A", { attempt(owner) { owner.stop(); } });
  try {
    const state = await f.owner.run(); assert.equal(state.firstFailure, "LAB_STOPPED");
    assert.equal(f.counts.attempts, 1); assert.equal(f.counts.runs, 0); assert(f.counts.stops >= 1);
    assert.equal(state.outcome, null); assert.equal(Object.keys(state.prefixes).length, 9);
  } finally { await f.close(); }
});

test("insufficient original laboratory allowance excludes case files, Create and control processes", async () => {
  const f = await caseOwner("A", { now: () => 2900000100n });
  try {
    const state = await f.owner.run(); assert.equal(state.firstFailure, "LAB_DEADLINE");
    assert.equal(f.docker.requests.length, 3); assert.equal(f.counts.startup, 0); assert.deepEqual(f.m.calls, []);
    assert.equal(state.outcome, null);
  } finally { await f.close(); }
});

test("late startup selection remains owned after cancellation and cannot select or run an attempt", async () => {
  const enter = deferred(); const hold = deferred();
  const f = await caseOwner("A", { async startup() { enter.resolve(); await hold.promise; } });
  try {
    const run = f.owner.run(); await enter.promise; f.owner.stop(); hold.resolve(); const state = await run;
    assert.equal(state.firstFailure, "LAB_STOPPED"); assert.equal(f.counts.attempts, 0); assert.equal(f.counts.runs, 0);
  } finally { hold.resolve(); await f.close(); }
});
