import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { copyLabInputPlan, labPaths } from "../../../scripts/provenance-acquisition-lab-profile.mjs";
import { createLabInputCandidate } from "../../../scripts/provenance-acquisition-lab-input.mjs";
import { readLabInputPlan } from "../../../scripts/provenance-acquisition-lab-files.mjs";
import { acquisitionSha256 } from "../../../scripts/provenance-acquisition-record.mjs";
import { inputPlan, inputModel } from "../../fixtures/provenance-acquisition-lab-input.mjs";
import { deferred } from "../../fixtures/provenance-acquisition-host.mjs";

test("input plan contains expected content, never placeholder identities or a fabricated clock origin", () => {
  const p = inputPlan(); const saved = copyLabInputPlan(p); assert.equal(saved.context.t0MonotonicNs, undefined);
  assert.equal(saved.namespaces, undefined); assert.equal(saved.roots.proc.identity, undefined); assert(Object.isFrozen(saved.tools));
  for (const change of [v => { v.roots.proc.identity = { dev: "1", ino: "2" }; }, v => { v.namespaces = {}; },
    v => { v.context.t0MonotonicNs = "100"; }, v => { v.limits.storageBytes = "0"; },
    v => { v.tools.python.path = "/global/python"; }, v => { v.slice = "other.slice"; },
    v => { Object.defineProperty(v.tools.node, "sha256", { enumerable: true, get() { assert.fail("getter"); } }); }]) {
    const value = inputPlan(); change(value); let callbacks = 0;
    assert.throws(() => createLabInputCandidate(value, { clock() { callbacks++; } }), { code: "LAB_INPUT" });
    assert.equal(callbacks, 0);
  }
});

test("finite metadata materializes one identified candidate, retains proc originals and leaves hashes pending", async () => {
  const model = await inputModel();
  try {
    const owner = createLabInputCandidate(model.plan, { io: model.port, clock: () => 100n });
    assert.deepEqual(model.calls, []); assert.equal((await owner.join()).finished, false);
    const work = owner.run(); assert.equal(owner.run(), work); const result = await work;
    assert.equal(result.firstFailure, null); assert.equal(result.cleanupError, null); assert(result.locallyComplete);
    const collected = owner.collect(); const profile = collected.profile;
    assert.equal(profile.context.t0MonotonicNs, "100"); assert.equal(profile.roots.proc.identity.ino, "80");
    assert.equal(profile.tools.node.sha256, model.plan.tools.node.sha256);
    assert.equal(result.contentVerification, "pending_lab_open"); assert.equal(result.presentedViewAdmission, "unqualified");
    assert.equal(acquisitionSha256(collected.profileBytes), result.profileSha256);
    const prefix = labPaths(profile).prefix;
    assert.deepEqual(await readFile(`${prefix}.input-profile.json`), collected.profileBytes);
    assert.match((await readFile(`${prefix}.input.proc.statbefore`)).toString(), /^777 \(node\)/);
    const report = JSON.parse(await readFile(`${prefix}.input-report.json`));
    assert.equal(report.inputPlanSha256, acquisitionSha256(JSON.stringify(model.plan)));
    assert.equal(report.contentVerification, "pending_lab_open");
    assert(model.calls.filter(c => c.kind === "write" || c.kind === "mkdir").length === 0);
    assert(!model.calls.some(c => c.kind === "read" && model.handles.get(c.fd)?.node.toolBytes !== undefined));
    assert([...model.handles.values()].every(h => h.closed));
    collected.profileBytes.fill(0); assert.notDeepEqual(owner.collect().profileBytes, collected.profileBytes);
  } finally { await model.close(); }
});

test("input and port replacements cannot retarget a copied candidate", async () => {
  const model = await inputModel();
  try {
    const owner = createLabInputCandidate(model.plan, { io: model.port, clock: () => 100n });
    model.plan.roots.proc.path = "/elsewhere"; model.port.open = () => assert.fail("replacement");
    assert((await owner.run()).locallyComplete); assert.equal(owner.collect().profile.roots.proc.path, "/proc");
  } finally { await model.close(); }
});

test("canonical profile capacity is independent of the per-observation byte budget", async () => {
  const model = await inputModel();
  try {
    model.plan.limits.observationBytes = 3072;
    const owner = createLabInputCandidate(model.plan, { io: model.port, clock: () => 100n });
    assert((await owner.run()).locallyComplete);
    assert(owner.collect().profileBytes.length > model.plan.limits.observationBytes);
  } finally { await model.close(); }
});

test("presented platform, namespace, independent byte cap and real path reject separately", async () => {
  for (const mode of ["platform", "namespace", "capacity", "path"]) {
    const model = await inputModel();
    try {
      if (mode === "platform") model.port.platform = "darwin";
      if (mode === "namespace") model.processes[777].children.get("status").text = "Pid:\t777\nTgid:\t777\nNSpid:\t777\t1\nNStgid:\t777\t1\n";
      if (mode === "capacity") model.plan.limits.observationBytes = 4;
      if (mode === "path") model.port.realpath = async () => "/unadmitted";
      const owner = createLabInputCandidate(model.plan, { io: model.port, clock: () => 100n }); const result = await owner.run();
      await owner.join(); assert(result.firstFailure, mode); assert(!result.locallyComplete);
      assert.throws(() => owner.collect(), { code: "LAB_PROFILE" }); assert([...model.handles.values()].every(h => h.closed));
      if (mode === "platform") assert.deepEqual(model.calls, []);
    } finally { await model.close(); }
  }
});

test("a late opening is adopted after stop; waiting expiry never restores candidate permission", async () => {
  const enter = deferred(); const hold = deferred(); let armed = true;
  const model = await inputModel({ async beforeOpen() { if (armed) { armed = false; enter.resolve(); await hold.promise; } } });
  try {
    model.plan.limits.retireMs = 30; const owner = createLabInputCandidate(model.plan, { io: model.port, clock: () => 100n });
    const run = owner.run(); await enter.promise; owner.stop(); const result = await run;
    assert.equal(result.firstFailure, "LAB_STOPPED"); assert(result.workPending); assert.equal(result.cleanupError, "LAB_CLEANUP");
    hold.resolve(); const joined = await owner.join(); assert.equal(joined.handles.retained, 0); assert(!joined.locallyComplete);
    assert.equal(model.calls.filter(c => c.kind === "open").length, 1);
  } finally { hold.resolve(); await model.close(); }
});

test("failed publication never overwrites an existing candidate or publishes an admitted result", async () => {
  const model = await inputModel();
  try {
    const prefix = labPaths({ ...model.profile, roots: model.profile.roots }).prefix;
    await writeFile(`${prefix}.input-profile.json`, "previous", { mode: 0o600 });
    const owner = createLabInputCandidate(model.plan, { io: model.port, clock: () => 100n }); const result = await owner.run();
    assert(result.firstFailure); assert(!result.locallyComplete); assert.equal(result.profileSha256, null);
    assert.equal((await readFile(`${prefix}.input-profile.json`)).toString(), "previous");
    assert(result.files.unpreservedRecords.includes("input-profile.json"));
  } finally { await model.close(); }
});

test("canonical existing input files preserve independent digest checking and inert CLI imports", async () => {
  const model = await inputModel();
  try {
    const file = `${model.directory}/plan.json`; const bytes = Buffer.from(JSON.stringify(model.plan));
    await writeFile(file, bytes, { mode: 0o600 }); assert.deepEqual(await readLabInputPlan(file, acquisitionSha256(bytes)), copyLabInputPlan(model.plan));
    await assert.rejects(readLabInputPlan(file, "f".repeat(64)), { code: "LAB_PROFILE" });
    const entry = resolve("scripts/provenance-acquisition-lab-input-entry.mjs");
    const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(entry)})`], { encoding: "utf8", timeout: 5000 });
    assert.equal(imported.status, 0); assert.equal(imported.stdout, ""); assert.equal(imported.stderr, "");
    const invalid = spawnSync(process.execPath, [entry, "PRIVATE_ARGUMENT"], { encoding: "utf8", timeout: 5000 });
    assert.equal(invalid.status, 1); assert.equal(invalid.stdout, ""); assert.equal(invalid.stderr, "LAB_INPUT\n");
  } finally { await model.close(); }
});
