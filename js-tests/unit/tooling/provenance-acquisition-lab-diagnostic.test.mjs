import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyLabDiagnosticPlan } from "../../../scripts/provenance-acquisition-lab-diagnostic-profile.mjs";
import { labDiagnosticProgram } from "../../../scripts/provenance-acquisition-lab-diagnostic-program.mjs";
import { diagnosticPlan, diagnosticDockerModel } from "../../fixtures/provenance-acquisition-lab-diagnostic.mjs";
import { LabDiagnosticDocker } from "../../../scripts/provenance-acquisition-lab-docker.mjs";
import { labContainerRequest, validateLabImage } from "../../../scripts/provenance-acquisition-lab-container.mjs";
import { LabHandles } from "../../../scripts/provenance-acquisition-lab-command.mjs";
import { acquisitionSha256 } from "../../../scripts/provenance-acquisition-record.mjs";
import { deferred } from "../../fixtures/provenance-acquisition-host.mjs";

test("diagnostic plan is closed, copied and uses independently supplied identities and distinct operation tokens", () => {
  const input = diagnosticPlan(); const p = copyLabDiagnosticPlan(input);
  input.image.id = "changed"; assert.equal(p.image.id, "sha256:" + "c".repeat(64)); assert(Object.isFrozen(p.image.archive.identity));
  for (const change of [v => { v.operations.B = v.operations.A; }, v => { v.credentials.groups.reverse(); },
    v => { v.credentials.uid = "0"; }, v => { v.timing.descendantMs = 100; },
    v => { v.timing.workUntilNs = v.timing.observeUntilNs; }, v => { v.image.tag = "latest"; },
    v => { v.image.archive.identity = null; }, v => { delete v.evidenceRefs.clockEvidenceSha256; },
    v => { Object.defineProperty(v, "sourceRevision", { enumerable: true, get() { assert.fail("getter"); } }); }]) {
    const value = diagnosticPlan(); change(value); assert.throws(() => copyLabDiagnosticPlan(value));
  }
});

test("literal diagnostic programs preserve binary bytes and expected nonzero outcome with ordinary finite Node children", { timeout: 10000 }, async () => {
  for (const kind of ["A", "B", "C"]) {
    const recipe = labDiagnosticProgram(kind, process.execPath, { holdMs: 1, descendantMs: 20 });
    const child = spawn(recipe.argv[0], recipe.argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], env: {} });
    const stdout = []; const stderr = [];
    child.stdout.on("data", b => stdout.push(b)); child.stderr.on("data", b => stderr.push(b));
    const [exitCode, signal] = await once(child, "close");
    assert.equal(exitCode, kind === "B" ? 7 : 0); assert.equal(signal, null);
    assert.deepEqual(Buffer.concat(stdout), Buffer.from([0, 65, 255, 10]));
    assert.deepEqual(Buffer.concat(stderr), Buffer.from([254, 0, 66, 13]));
    assert.equal(recipe.descendant, kind === "C"); assert.equal(recipe.exitCode, exitCode);
  }
  assert.throws(() => labDiagnosticProgram("D", process.execPath, { holdMs: 1, descendantMs: 20 }), { code: "LAB_INPUT" });
});

function dockerOwner(m) { return new LabDiagnosticDocker(copyLabDiagnosticPlan(m.plan), m.socket, { files: m.files,
  retirementFiles: m.files, handles: new LabHandles(), check() {}, request: m.request, filesystem: m.filesystem }); }

test("one admitted archive and stopped case use exact API fields and retain separate request/response originals", async () => {
  const m = diagnosticDockerModel(); const owner = dockerOwner(m);
  assert.deepEqual(m.requests, []); await owner.prepareImage();
  const request = labContainerRequest(m.plan, "/unit/work/run-a/case", "/private-input/a", "/private-ipc/a");
  assert.equal(request.HostConfig.PidMode, ""); assert.equal(request.HostConfig.Privileged, false);
  assert.equal(request.HostConfig.ReadonlyRootfs, true); assert.equal(request.HostConfig.NetworkMode, "none");
  assert.deepEqual(request.HostConfig.CapDrop, ["ALL"]); assert.deepEqual(request.HostConfig.GroupAdd, ["12346"]);
  const prepared = await owner.create(m.plan.operations.A, request); assert.equal(prepared.id, "1".repeat(64));
  assert(prepared.preparedContainerSha256); assert.equal(m.requests.length, 5);
  assert(m.requests.every(r => r.agent === false && !r.path.includes("pull") && !r.path.endsWith("/start") && r.method !== "DELETE"));
  assert.equal(m.requests[0].headers["Content-Type"], "application/x-tar");
  assert.deepEqual(m.requests[0].body, m.archive); assert(m.observed().archiveClosed);
  assert(m.originals.has(`case-${m.plan.operations.A}.container.prepared.json`));
  const state = owner.snapshot(); assert.equal(state.pendingTransactions, 0); assert.equal(state.nativeRetirement, "unknown");
  assert(Object.values(state.effects).every(e => e.complete && e.nativeEffect === "unknown"));
  assert.equal((await owner.close()).pendingJobs, 0);
});

test("an independently matching image hash does not admit inherited environment, volumes or healthchecks", () => {
  for (const field of ["env", "volumes", "healthcheck", "architecture"]) {
    const m = diagnosticDockerModel();
    if (field === "env") m.image.Config.Env = ["UNEXPECTED=value"];
    if (field === "volumes") m.image.Config.Volumes = { "/unadmitted": {} };
    if (field === "healthcheck") m.image.Config.Healthcheck = { Test: ["CMD", "unexpected"] };
    if (field === "architecture") m.image.Architecture = "arm64";
    m.plan.image.configSha256 = acquisitionSha256(JSON.stringify(m.image.Config));
    assert.throws(() => validateLabImage(m.plan, m.image), { code: "LAB_IDENTITY" });
  }
});

test("container response differences reject without retry or promotion to native retirement", async () => {
  for (const field of ["status", "env", "readonly", "recursive", "groups", "running", "warnings"]) {
    const m = diagnosticDockerModel({ response(settings, r) {
      if (settings.path.includes("containers/create")) {
        if (field === "status") r.status = 200;
        if (field === "warnings") r.value.Warnings.push("finite warning");
      } else if (settings.path.includes("containers/")) {
        if (field === "env") r.value.Config.Env.push("UNEXPECTED=value");
        if (field === "readonly") r.value.Mounts[0].RW = true;
        if (field === "recursive") r.value.HostConfig.Mounts[0].BindOptions.NonRecursive = false;
        if (field === "groups") r.value.HostConfig.GroupAdd = [];
        if (field === "running") r.value.State.Running = true;
      }
    } }); const owner = dockerOwner(m);
    const request = labContainerRequest(m.plan, "/unit/work/run-a/case", "/private-input/a", "/private-ipc/a");
    await assert.rejects(owner.create(m.plan.operations.A, request)); assert(owner.snapshot().firstFailure, field);
    assert.equal(m.requests.filter(r => r.path.includes("containers/create")).length, 1);
    assert.equal(owner.snapshot().nativeRetirement, "unknown"); await owner.close();
  }
});

test("wrong archive content fails before the first API request", async () => {
  const m = diagnosticDockerModel(); m.plan.image.archive.sha256 = "0".repeat(64); const owner = dockerOwner(m);
  await assert.rejects(owner.prepareImage(), { code: "LAB_IDENTITY" }); assert.deepEqual(m.requests, []);
  assert(m.observed().archiveClosed); await owner.close();
});

test("stop retains a response delivered after earlier request closure, without retrying the effect", async () => {
  const enter = deferred(); const hold = deferred(); let releaseStream;
  const m = diagnosticDockerModel({ async beforeResponse() { enter.resolve(); await hold.promise; },
    stream(settings, response) {
      if (settings.path.includes("images/load")) {
        response.destroy = () => response;
        releaseStream = () => response.emit("close");
      }
    } }); const owner = dockerOwner(m);
  const run = owner.prepareImage(); await enter.promise; owner.stop(); await assert.rejects(run);
  assert.equal(owner.snapshot().pendingTransactions, 0);
  hold.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(owner.snapshot().pendingTransactions, 1);
  assert.equal(m.requests.length, 1); assert.equal(owner.snapshot().effects["image.load"].complete, false);
  releaseStream(); assert.equal((await owner.close()).pendingTransactions, 0);
});

test("partial-response preservation failure is explicit and blocks further effects", async () => {
  const m = diagnosticDockerModel({ response(settings, r) { if (settings.path.includes("images/load")) r.status = 500; },
    failWrite: label => label.endsWith("partial.body") }); const owner = dockerOwner(m);
  await assert.rejects(owner.prepareImage()); assert.equal(owner.snapshot().preservationComplete, false);
  assert.equal(owner.snapshot().effects["image.load"].responseStatus, 500); assert.equal(m.requests.length, 1);
  await assert.rejects(owner.prepareImage(), { code: "LAB_STOPPED" }); assert.equal(m.requests.length, 1); await owner.close();
});
