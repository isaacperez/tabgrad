import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcquisitionRecordError, acquisitionSha256 } from "../../../scripts/provenance-acquisition-record.mjs";
import { NativeLabIO } from "../../../scripts/provenance-acquisition-lab-io.mjs";
import { LabFiles } from "../../../scripts/provenance-acquisition-lab-files.mjs";
import { LabMemorySink, startLabCommand } from "../../../scripts/provenance-acquisition-lab-command.mjs";
import { createAcquisitionLab } from "../../../scripts/provenance-acquisition-lab.mjs";
import { labPaths } from "../../../scripts/provenance-acquisition-lab-profile.mjs";
import { labProfile, labNativePorts } from "../../fixtures/provenance-acquisition-lab.mjs";
import { deferred } from "../../fixtures/provenance-acquisition-host.mjs";

const prefix = "manager.wait.waiter";
const checks = { work() {}, retire() {} };

function earlyLauncher(p, result, channels, missing = ["keeper.json", "ready.json"]) {
  const reads = [];
  const ports = labNativePorts(p, ({ name, value, originals }) => {
    if (name !== "systemdRun") return;
    for (const label of missing) originals.delete(label);
    value.result = Promise.resolve(result);
    value.snapshot = () => structuredClone(result);
    value.collect = async role => { reads.push(role); return Buffer.from(channels[role]); };
  });
  return { ports, reads };
}

function terminal(overrides = {}) {
  return { closed: true, exited: true, firstFailure: null, cleanupError: null,
    exitCode: 17, signal: null, capture: { ioClosed: "closed",
      channels: { stdout: { confirmedBytes: 0, eof: true }, stderr: { confirmedBytes: 3, eof: true } } }, ...overrides };
}

test("early closed launch preserves actual result and separate binary channels without granting readiness or ownership", async () => {
  for (const result of [terminal(), terminal({ exitCode: 0 }), terminal({ exitCode: null, signal: "SIGKILL" }),
    terminal({ firstFailure: "LAB_WRITE", cleanupError: "LAB_CLEANUP", capture: { ioClosed: "unknown" } }),
    terminal({ closed: false, exited: false, exitCode: null, firstFailure: "LAB_PROTOCOL" })]) {
    const p = labProfile();
    const channels = { stdout: Buffer.alloc(0), stderr: Buffer.from([0, 255, 10]) };
    const { ports, reads } = earlyLauncher(p, result, channels);
    const owner = createAcquisitionLab(p, { clock: () => 101n, io: (profile, gate) => new NativeLabIO(profile, gate, ports) });
    // A settled spawn failure need not have a child's close event.
    if (!result.closed) ports.files.readJson = async label => label === "worker.json" ? { firstFailure: "LAB_WORKER" } : null;
    const observed = await owner.run();
    assert(ports.originals.has(`${prefix}.result.json`), "known launcher result must be retained");
    assert.deepEqual(JSON.parse(ports.originals.get(`${prefix}.result.json`)), result);
    for (const role of ["stdout", "stderr"]) assert.deepEqual(ports.originals.get(`${prefix}.${role}`), channels[role]);
    assert.deepEqual(reads, ["stdout", "stderr"]);
    assert.deepEqual(observed.io.launcher, { settled: true, command: result });
    assert.equal(observed.ready, false); assert.equal(observed.retirementObserved, false);
    assert.equal(observed.locallyPreserved, false); assert.equal(observed.locallyComplete, false);
    assert.equal(observed.firstFailure, result.closed ? "LAB_MANAGER" : "LAB_WORKER");
    assert.equal(observed.cleanupError, "LAB_IDENTITY");
    assert.equal(ports.calls.filter(c => c[0] === "effect").length, 0);
    assert.equal(ports.calls.filter(c => c[0] === "command" && c[1] === "systemdRun").length, 1);
  }
});

test("launcher originals do not depend on either keeper or readiness evidence", async () => {
  for (const missing of [["keeper.json"], ["ready.json"], ["keeper.json", "ready.json"]]) {
    const p = labProfile(); const result = terminal();
    const { ports } = earlyLauncher(p, result, { stdout: Buffer.from("out"), stderr: Buffer.alloc(0) }, missing);
    const io = new NativeLabIO(p, checks, ports); await io.open(); await io.launch();
    if (missing.includes("ready.json")) await assert.rejects(io.preserve({}), { code: "LAB_PRESERVATION" });
    else await io.preserve({});
    assert.deepEqual(JSON.parse(ports.originals.get(`${prefix}.result.json`)), result);
    assert.equal(ports.originals.get(`${prefix}.stdout`).toString(), "out");
    assert.equal(ports.originals.get(`${prefix}.stderr`).length, 0);
    await io.close();
  }
});

test("one failed launcher publication keeps other known originals and cannot retry or report complete", async () => {
  for (const failed of ["result.json", "stdout", "stderr"]) {
    const p = labProfile(); const { ports, reads } = earlyLauncher(p, terminal(), { stdout: Buffer.from("out"), stderr: Buffer.from("err") });
    const write = ports.retirementFiles.write; const json = ports.retirementFiles.json; let attempts = 0;
    ports.retirementFiles.write = async (label, bytes) => {
      if (label === `${prefix}.${failed}`) { attempts++; throw new AcquisitionRecordError("LAB_WRITE"); }
      return write(label, bytes);
    };
    ports.retirementFiles.json = async (label, value) => {
      if (label === `${prefix}.${failed}`) { attempts++; throw new AcquisitionRecordError("LAB_CLEANUP"); }
      return json(label, value);
    };
    const io = new NativeLabIO(p, checks, ports); await io.open(); await io.launch();
    for (let i = 0; i < 2; i++) await assert.rejects(io.preserve({}));
    assert.equal(attempts, 1); assert.deepEqual(reads, ["stdout", "stderr"]);
    assert.equal(io.snapshot().preserved, false);
    for (const part of ["result.json", "stdout", "stderr"]) assert.equal(ports.originals.has(`${prefix}.${part}`), part !== failed);
    await io.close();
  }
});

test("successful retirement reuses exactly one launcher collection and original set", async () => {
  const p = labProfile(); let reads = 0;
  const ports = labNativePorts(p, ({ name, value }) => {
    if (name !== "systemdRun") return;
    const collect = value.collect; value.collect = async role => { reads++; return collect(role); };
  });
  const owner = createAcquisitionLab(p, { clock: () => 101n, io: (profile, gate) => new NativeLabIO(profile, gate, ports) });
  const observed = await owner.run(); assert.equal(observed.locallyComplete, true);
  assert.equal(reads, 2);
  const writes = ports.calls.filter(c => c[0] === "write" && c[1].startsWith(prefix));
  assert.equal(writes.length, 3); assert.equal(new Set(writes.map(c => c[1])).size, 3);
});

test("an unavailable channel stays missing while the independent observed channel is retained", async () => {
  const p = labProfile(); const { ports } = earlyLauncher(p, terminal(), { stdout: Buffer.from("out"), stderr: Buffer.from("err") });
  const command = ports.command; let reads = 0;
  ports.command = async (...args) => {
    const value = await command(...args);
    if (args[0] === "systemdRun") value.collect = async role => {
      reads++;
      if (role === "stdout") throw new AcquisitionRecordError("LAB_READ");
      return Buffer.from("err");
    };
    return value;
  };
  const io = new NativeLabIO(p, checks, ports); await io.open(); await io.launch();
  for (let i = 0; i < 2; i++) await assert.rejects(io.preserve({}), { code: "LAB_READ" });
  assert.equal(reads, 2); assert(!ports.originals.has(`${prefix}.stdout`));
  assert.equal(ports.originals.get(`${prefix}.stderr`).toString(), "err");
  assert.deepEqual(JSON.parse(ports.originals.get(`${prefix}.result.json`)), terminal());
  assert.equal(io.snapshot().preserved, false); await io.close();
});

test("late channel completion cannot publish past the original retirement cutoff", async () => {
  for (const mode of ["deadline", "halt"]) {
    const p = labProfile(); const result = terminal(); const held = deferred(); const entered = deferred(); let stopped = false;
    const { ports } = earlyLauncher(p, result, { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    const command = ports.command;
    ports.command = async (...args) => {
      const value = await command(...args);
      if (args[0] === "systemdRun") value.collect = async () => { entered.resolve(); return held.promise; };
      return value;
    };
    const io = new NativeLabIO(p, { work() {}, retire() { if (stopped) throw new AcquisitionRecordError("LAB_DEADLINE"); } }, ports);
    await io.open(); await io.launch(); const saving = io.preserve({}); await entered.promise;
    if (mode === "deadline") stopped = true; else io.halt();
    held.resolve(Buffer.from("late"));
    await assert.rejects(saving, { code: mode === "deadline" ? "LAB_DEADLINE" : "LAB_STOPPED" });
    assert.deepEqual(JSON.parse(ports.originals.get(`${prefix}.result.json`)), result);
    assert(!ports.originals.has(`${prefix}.stdout`)); assert(!ports.originals.has(`${prefix}.stderr`));
    assert.equal(io.snapshot().preserved, false); await io.close();
  }
});

test("real bounded child capture composes with exclusive original files on an early failure", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tabgrad-launcher-originals-")));
  const p = labProfile(); p.roots.evidence.path = root;
  const files = new LabFiles(p, checks.retire); let child;
  t.after(async () => { child?.stop(); if (child) await child.result; await files.close(); await rm(root, { recursive: true, force: true }); });
  const ports = labNativePorts(p);
  ports.retirementFiles = files;
  ports.command = async (name, _args, options) => {
    assert.equal(name, "systemdRun");
    child = startLabCommand({ file: process.execPath, args: ["-e", "process.stderr.write(Buffer.from([0,255,10]));process.exitCode=17"], env: {} },
      new LabMemorySink(p.limits.observationBytes), options.check);
    await child.result; return child;
  };
  const io = new NativeLabIO(p, checks, ports); await io.open(); await io.launch();
  await assert.rejects(io.readiness(), { code: "LAB_MANAGER" });
  await assert.rejects(io.preserve({}), { code: "LAB_PRESERVATION" });
  const saved = await files.readJson(`${prefix}.result.json`);
  assert.equal(saved.exitCode, 17); assert.equal(saved.firstFailure, null); assert.equal(saved.cleanupError, null);
  assert.equal(saved.capture.ioClosed, "closed");
  assert.deepEqual(await files.read(`${prefix}.stderr`), Buffer.from([0, 255, 10]));
  assert.deepEqual(await files.read(`${prefix}.stdout`), Buffer.alloc(0));
  assert.equal(await files.read("unobserved.stdout"), null);
  for (const [label, record] of Object.entries(files.snapshot().records)) {
    const bytes = await files.read(label); assert.equal(bytes.length, record.bytes); assert.equal(acquisitionSha256(bytes), record.sha256);
  }
  assert.deepEqual(files.snapshot().unpreservedRecords, []);
  await io.close(); assert.equal((await files.close()).retained, 0);
});

test("real exclusive publication failure never replaces an original or suppresses the other channel", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tabgrad-launcher-collision-")));
  const p = labProfile(); p.roots.evidence.path = root;
  const files = new LabFiles(p, checks.retire); const { ports } = earlyLauncher(p, terminal(), { stdout: Buffer.from("out"), stderr: Buffer.from("err") });
  ports.retirementFiles = files;
  const io = new NativeLabIO(p, checks, ports);
  t.after(async () => { await io.close(); await files.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(`${labPaths(p).prefix}.${prefix}.stdout`, "keep existing", { mode: 0o600 });
  await io.open(); await io.launch();
  for (let i = 0; i < 2; i++) await assert.rejects(io.preserve({}), { code: "EEXIST" });
  assert.equal((await files.read(`${prefix}.stdout`)).toString(), "keep existing");
  assert.equal((await files.read(`${prefix}.stderr`)).toString(), "err");
  assert.deepEqual(await files.readJson(`${prefix}.result.json`), terminal());
  assert.deepEqual(files.snapshot().unpreservedRecords, [`${prefix}.stdout`]);
  assert.equal(io.snapshot().preserved, false);
});
