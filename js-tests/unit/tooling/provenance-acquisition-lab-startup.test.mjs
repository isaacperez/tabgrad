import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcquisitionRecordError, acquisitionSha256 } from "../../../scripts/provenance-acquisition-record.mjs";
import { NativeLabIO } from "../../../scripts/provenance-acquisition-lab-io.mjs";
import { createAcquisitionLab } from "../../../scripts/provenance-acquisition-lab.mjs";
import { copyLabProfile, labPaths } from "../../../scripts/provenance-acquisition-lab-profile.mjs";
import { LabFiles } from "../../../scripts/provenance-acquisition-lab-files.mjs";
import { LabHandles, createLabFileSink, startLabCommand } from "../../../scripts/provenance-acquisition-lab-command.mjs";
import { labProfile, labNativePorts } from "../../fixtures/provenance-acquisition-lab.mjs";
import { deferred } from "../../fixtures/provenance-acquisition-host.mjs";

const checks = { work() {}, retire() {} };
const failure = { ready: false, firstFailure: "LAB_MANAGER" };
const terminal = (exitCode = 1) => ({ closed: true, exited: true, firstFailure: null, cleanupError: null, exitCode, signal: null });
const startupCalls = ports => ports.calls.filter(c => c[0] === "startup");

/** Synthetic service outputs, independently tracked finite file-prefix identities. */
function startupModel(p, { journal = Buffer.from('{"MESSAGE":"synthetic early error"}\n'), mutate = () => {}, keeper = false } = {}) {
  const ports = labNativePorts(p, ({ name, value, originals }) => {
    if (name !== "systemdRun") return;
    for (const label of ["ready.json", "worker.json", ...keeper ? [] : ["keeper.json"]]) originals.delete(label);
    value.result = Promise.resolve(terminal()); value.snapshot = () => terminal();
  });
  const original = ports.command; let ino = 1000;
  ports.command = async (name, args, options) => {
    const value = await original(name, args, options);
    if (!options.label?.startsWith("startup.")) return value;
    ports.calls.push(["startup", name, [...args], options.label]);
    if (name === "journalctl") value.collect = async role => role === "stdout" ? Buffer.from(journal) : Buffer.alloc(0);
    mutate({ name, args, options, value, ports });
    const captures = { files: {}, channels: {}, ioClosed: "open" }; const data = {};
    for (const role of ["stdout", "stderr"]) {
      const raw = await value.collect(role); const bytes = raw.subarray(0, p.limits.observationBytes);
      const label = `${options.label}.${role}`; const identity = `9:${ino++}`; const allocated = Buffer.alloc(p.limits.observationBytes);
      bytes.copy(allocated); ports.originals.set(label, allocated); ports.fileIdentities.set(label, identity); data[role] = Buffer.from(bytes);
      captures.files[role] = { identity, capacity: allocated.length };
      captures.channels[role] = { confirmedBytes: bytes.length, sha256: acquisitionSha256(bytes), eof: false };
    }
    let result = { ...terminal(0), closed: false, exited: false, exitCode: null };
    const done = value.result.then(observed => {
      result = { ...observed }; captures.ioClosed = "closed";
      for (const channel of Object.values(captures.channels)) channel.eof = !observed.firstFailure;
      return { ...result, capture: structuredClone(captures) };
    });
    return { result: done, stop: value.stop, collect: async role => Buffer.from(data[role]),
      snapshot: () => ({ ...result, capture: structuredClone(captures) }) };
  };
  return ports;
}

/** Real capture/files, with finite Node children emitting synthetic manager/journal replies. */
async function finiteChildCommand(context, name, args, options) {
  const { p, sourceCommand, handles, children } = context;
  const fixture = await sourceCommand(name, args, options);
  if (!options.label) return fixture;
  const stdout = await fixture.collect("stdout");
  const sink = await createLabFileSink(`${labPaths(p).prefix}.${options.label}`, p.limits.observationBytes, p.context,
    () => 101n, checks.retire, handles);
  const child = startLabCommand({ file: process.execPath,
    args: ["-e", "process.stdout.write(Buffer.from(process.argv[1],'base64'))", stdout.toString("base64")], env: {} }, sink, checks.retire);
  children.push(child); return child;
}

test("early failed preparation observes only its requested service and current boot, once, without ownership", async () => {
  const p = labProfile(); const ports = startupModel(p);
  const io = new NativeLabIO(p, checks, ports); await io.open(); await io.launch();
  for (let i = 0; i < 2; i++) await assert.rejects(io.preserve(failure), { code: "LAB_PRESERVATION" });
  const calls = startupCalls(ports); assert.equal(calls.length, 4);
  assert.deepEqual(calls.filter(c => c[1] === "busctl").map(c => c[2].at(-1)),
    [labPaths(p).unit, "org.freedesktop.systemd1.Unit", "org.freedesktop.systemd1.Service"]);
  const journal = calls.find(c => c[1] === "journalctl")[2];
  assert.deepEqual(journal, ["--system", "--boot", `--unit=${labPaths(p).unit}`, "--no-pager", "--no-tail", "--output=json",
    "--output-fields=MESSAGE,PRIORITY,SYSLOG_IDENTIFIER,_PID,_SYSTEMD_UNIT,_SYSTEMD_INVOCATION_ID,UNIT,OBJECT_SYSTEMD_UNIT,COREDUMP_UNIT"]);
  assert(!journal.some(v => /follow|all$|merge|namespace|machine|directory|file=|cursor|sync|rotate|vacuum/.test(v)));
  const state = io.snapshot().startupDiagnostics;
  assert.equal(state.state, "settled"); assert.equal(state.selection.attribution, "unbound_diagnostic");
  assert.equal(state.selection.completeness, "unqualified"); assert.equal(state.firstFailure, null);
  assert.equal(Object.keys(state.commands).length, 4);
  for (const [label, command] of Object.entries(state.commands)) {
    assert.equal(command.exitCode, 0);
    for (const role of ["stdout", "stderr"]) await ports.retirementFiles.verifyPrefix(`${label}.${role}`, command.capture.files[role], command.capture.channels[role]);
    assert(ports.originals.has(`${label}.result.json`));
  }
  assert(ports.originals.has("startup.json")); assert(ports.originals.has("manager.wait.waiter.result.json"));
  assert.equal(io.snapshot().bound, false); assert(!ports.calls.some(c => c[0] === "effect"));
  assert(!JSON.stringify(state).includes("synthetic early error"));
  await io.close();
});

test("no startup query without a launch, a completed launcher, a failure, or before a successful preparation closes", async () => {
  for (const mode of ["no_launch", "pending", "no_failure", "ready"]) {
    const p = labProfile(); const ports = mode === "pending" || mode === "ready" ? labNativePorts(p) : startupModel(p);
    const io = new NativeLabIO(p, checks, ports); await io.open();
    if (mode !== "no_launch") await io.launch();
    if (mode === "ready") {
      await io.readiness(); await io.effect("unit.kill");
      await new Promise(resolve => setImmediate(resolve));
    }
    await io.preserve(mode === "no_failure" ? { ready: false } : failure).catch(() => {});
    assert.equal(startupCalls(ports).length, 0); assert.equal(io.snapshot().startupDiagnostics.state, "not_requested");
    if (mode === "pending") { await io.owned(); await io.effect("unit.kill"); }
    await io.close();
  }
});

test("the identified journal reader is required by both copied profile and native tool verification", async () => {
  for (const mutate of [p => { delete p.tools.journalctl; }, p => { p.tools.journalctl.sha256 = "bad"; },
    p => { p.tools.journalctl.identity = p.tools.busctl.identity; }]) {
    const p = labProfile(); mutate(p); assert.throws(() => copyLabProfile(p), { code: "LAB_INPUT" });
  }
  const p = labProfile(); const ports = startupModel(p); const verify = ports.files.verifyTool;
  ports.files.verifyTool = async name => {
    if (name === "journalctl") throw new AcquisitionRecordError("LAB_TOOL"); return verify(name);
  };
  const io = new NativeLabIO(p, checks, ports);
  await assert.rejects(io.open(), { code: "LAB_TOOL" });
  assert.equal(io.snapshot().launched, false); assert.equal(startupCalls(ports).length, 0); await io.close();
});

test("reentrant observation sees the same owned promise before any command callback", async () => {
  const { LabStartupDiagnostics } = await import("../../../scripts/provenance-acquisition-lab-startup.mjs");
  const p = labProfile(); let observer; let running;
  const ports = startupModel(p, { mutate: () => { assert.equal(observer.observe(), running); } });
  observer = new LabStartupDiagnostics(p, { command: (name, args, options) => ports.command(name, args, { ...options, check: checks.retire }),
    files: ports.retirementFiles, check: checks.retire });
  assert.equal(startupCalls(ports).length, 0);
  running = observer.observe(); assert.equal(observer.observe(), running); await running;
  assert.equal(startupCalls(ports).length, 4); assert.equal(observer.snapshot().state, "settled");
});

test("manager failure or a different returned unit cannot suppress independent journal capture or authorize effects", async () => {
  for (const mode of ["exit", "bad_path", "wrong_unit"]) {
    const p = labProfile(); const bytes = Buffer.from([0, 255, 10]);
    const ports = startupModel(p, { journal: bytes, mutate: ({ options, value }) => {
      if (mode === "exit" && options.label === "startup.path") value.result = Promise.resolve(terminal(23));
      if (mode === "bad_path" && options.label === "startup.path") value.collect = async () => Buffer.from('{"type":"o","data":["/unrelated"]}');
      if (mode === "wrong_unit" && options.label === "startup.unit") value.collect = async () => Buffer.from('{"type":"a{sv}","data":[{"Id":{"type":"s","data":"other.service"}}]}');
    } });
    const io = new NativeLabIO(p, checks, ports); await io.open(); await io.launch();
    await assert.rejects(io.preserve(failure), { code: "LAB_PRESERVATION" });
    const state = io.snapshot().startupDiagnostics; assert(state.firstFailure);
    assert.equal(state.requests.service.state, "not_started");
    assert.equal(startupCalls(ports).filter(c => c[1] === "journalctl").length, 1);
    const channel = state.commands["startup.journal"].capture.channels.stdout;
    assert.deepEqual(ports.originals.get("startup.journal.stdout").subarray(0, channel.confirmedBytes), bytes);
    assert(!ports.calls.some(c => c[0] === "effect")); assert.equal(io.snapshot().bound, false); await io.close();
  }
});

test("empty, nonzero and truncated diagnostic channels remain distinct original observations", async () => {
  for (const mode of ["empty", "nonzero", "truncated"]) {
    const p = labProfile(); const ports = startupModel(p, { journal: mode === "empty" ? Buffer.alloc(0) : Buffer.from("synthetic"),
      mutate: ({ name, value }) => { if (name === "journalctl" && mode !== "empty")
        value.result = Promise.resolve({ ...terminal(mode === "nonzero" ? 2 : null), firstFailure: mode === "truncated" ? "LAB_LIMIT" : null }); } });
    const io = new NativeLabIO(p, checks, ports); await io.open(); await io.launch();
    await assert.rejects(io.preserve(failure));
    const state = io.snapshot().startupDiagnostics; const result = state.commands["startup.journal"];
    assert.equal(result.exitCode, mode === "empty" ? 0 : mode === "nonzero" ? 2 : null);
    assert.equal(state.firstFailure, mode === "empty" ? null : mode === "truncated" ? "LAB_LIMIT" : "LAB_TOOL");
    assert.equal(result.capture.channels.stdout.confirmedBytes, mode === "empty" ? 0 : 9);
    assert.equal(result.capture.channels.stdout.eof, mode !== "truncated");
    assert(ports.originals.has("startup.journal.result.json")); await io.close();
  }
});

test("held query cannot suppress other originals or the first failure, and halt cannot start later reads", async () => {
  const p = labProfile(); p.limits.retireMs = 30; const held = deferred(); const entered = deferred();
  const ports = startupModel(p, { mutate: ({ options, value }) => {
    if (options.label === "startup.path") { value.result = held.promise; entered.resolve(); }
  } });
  const owner = createAcquisitionLab(p, { clock: () => 101n, io: (profile, gate) => new NativeLabIO(profile, gate, ports) });
  const running = owner.run(); await entered.promise; const result = await running;
  assert.equal(result.firstFailure, "LAB_MANAGER"); assert.equal(result.cleanupError, "LAB_IDENTITY");
  assert.equal(result.io.startupDiagnostics.state, "pending");
  assert.equal(result.io.startupDiagnostics.requests.path.state, "pending");
  assert(ports.originals.has("manager.wait.waiter.result.json"));
  assert(ports.originals.has("startup.journal.result.json"));
  assert(!ports.originals.has("startup.path.result.json"));
  assert.equal(result.io.startupDiagnostics.commands["startup.journal"].capture.channels.stdout.eof, true);
  const count = startupCalls(ports).length; held.resolve(terminal(0));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(startupCalls(ports).length, count); assert(!ports.originals.has("startup.path.result.json"));
  assert(!ports.calls.some(c => c[0] === "effect"));
});

test("expired diagnostic is explicitly not started and does not renew a cutoff", async () => {
  const p = labProfile(); const ports = startupModel(p); let expired = false;
  const io = new NativeLabIO(p, { work() {}, retire() { if (expired) throw new AcquisitionRecordError("LAB_DEADLINE"); } }, ports);
  await io.open(); await io.launch(); expired = true;
  await assert.rejects(io.preserve(failure), { code: "LAB_DEADLINE" });
  assert.equal(io.snapshot().startupDiagnostics.state, "not_started");
  assert.equal(io.snapshot().startupDiagnostics.firstFailure, "LAB_DEADLINE");
  assert.equal(startupCalls(ports).length, 0); await io.close();
});

test("failed known-original publication and failed diagnostic publication retain independent records without retries", async () => {
  for (const failed of ["manager.wait.waiter.stdout", "startup.path.result.json", "startup.json"]) {
    const p = labProfile(); const ports = startupModel(p); const write = ports.retirementFiles.write; const json = ports.retirementFiles.json;
    let attempts = 0;
    ports.retirementFiles.write = async (label, bytes) => {
      if (label === failed) { attempts++; throw new AcquisitionRecordError("LAB_WRITE"); } return write(label, bytes);
    };
    ports.retirementFiles.json = async (label, value) => {
      if (label === failed) { attempts++; throw new AcquisitionRecordError("LAB_WRITE"); } return json(label, value);
    };
    const io = new NativeLabIO(p, checks, ports); await io.open(); await io.launch();
    for (let i = 0; i < 2; i++) await assert.rejects(io.preserve(failure));
    assert.equal(attempts, 1); assert(ports.originals.has("manager.wait.waiter.stderr"));
    assert(ports.originals.has("startup.journal.result.json"));
    assert.equal(startupCalls(ports).filter(c => c[1] === "journalctl").length, 1);
    if (failed === "startup.path.result.json") {
      assert.equal(io.snapshot().startupDiagnostics.firstFailure, "LAB_WRITE");
      assert.equal(io.snapshot().startupDiagnostics.requests.service.state, "not_started");
    }
    assert.equal(io.snapshot().preserved, false); await io.close();
  }
});

test("owned containment starts before any startup query, and diagnostic failure does not replace it", async () => {
  const p = labProfile(); const ports = startupModel(p, { keeper: true, mutate: ({ name, value }) => {
    if (name === "journalctl") value.result = Promise.resolve(terminal(2));
  } });
  const owner = createAcquisitionLab(p, { clock: () => 101n, io: (profile, gate) => new NativeLabIO(profile, gate, ports) });
  const result = await owner.run(); assert.equal(result.firstFailure, "LAB_MANAGER");
  const kill = ports.calls.findIndex(c => c[0] === "effect" && c[1] === "unit.kill");
  const query = ports.calls.findIndex(c => c[0] === "startup");
  assert(kill >= 0 && query > kill); assert.equal(result.io.startupDiagnostics.firstFailure, "LAB_TOOL");
});

test("actual exclusive captures retain finite child prefixes within the admitted aggregate", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tabgrad-startup-capture-")));
  const p = labProfile(); p.roots.evidence.path = root; const handles = new LabHandles();
  const files = new LabFiles(p, checks.retire, handles); const ports = startupModel(p);
  ports.retirementFiles = files;
  const children = [];
  ports.command = finiteChildCommand.bind(null, { p, sourceCommand: ports.command, handles, children });
  const io = new NativeLabIO(p, checks, ports);
  t.after(async () => { for (const child of children) child.stop(); await Promise.allSettled(children.map(c => c.result));
    await io.close(); await handles.closeAll(); await rm(root, { recursive: true, force: true }); });
  await io.open(); await io.launch(); await assert.rejects(io.preserve(failure), { code: "LAB_PRESERVATION" });
  const state = io.snapshot().startupDiagnostics; assert.equal(Object.keys(state.commands).length, 4);
  let logicalBytes = 0;
  for (const [label, saved] of Object.entries(state.commands)) {
    for (const role of ["stdout", "stderr"]) {
      await files.verifyPrefix(`${label}.${role}`, saved.capture.files[role], saved.capture.channels[role]);
      logicalBytes += saved.capture.files[role].capacity;
    }
    const metadata = await files.readJson(`${label}.result.json`); assert.equal(metadata.exitCode, 0);
    logicalBytes += files.snapshot().records[`${label}.result.json`].bytes;
  }
  logicalBytes += files.snapshot().records["startup.json"].bytes;
  assert(logicalBytes <= 13 * p.limits.observationBytes); assert(BigInt(logicalBytes) < BigInt(p.limits.storageBytes));
  assert.deepEqual(files.snapshot().unpreservedRecords, []); assert.equal(children.length, 4);
});

test("actual diagnostic publication cannot overwrite an original or suppress independent channels", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tabgrad-startup-exclusive-")));
  const p = labProfile(); p.roots.evidence.path = root; const ports = startupModel(p);
  const handles = new LabHandles(); const children = [];
  const files = new LabFiles(p, checks.retire, handles); ports.retirementFiles = files;
  ports.command = finiteChildCommand.bind(null, { p, sourceCommand: ports.command, handles, children });
  const io = new NativeLabIO(p, checks, ports);
  t.after(async () => { for (const child of children) child.stop(); await Promise.allSettled(children.map(c => c.result));
    await io.close(); await files.close(); await rm(root, { recursive: true, force: true }); });
  const label = "startup.path.result.json"; const existing = Buffer.from("preserve this unrelated original");
  await writeFile(`${labPaths(p).prefix}.${label}`, existing, { mode: 0o600 });
  await io.open(); await io.launch();
  for (let i = 0; i < 2; i++) await assert.rejects(io.preserve(failure), { code: "LAB_PRESERVATION" });
  assert.deepEqual(await files.read(label), existing);
  assert.deepEqual(files.snapshot().unpreservedRecords, [label]);
  assert(await files.readJson("startup.journal.result.json"));
  assert(await files.readJson("manager.wait.waiter.result.json"));
  assert.equal(startupCalls(ports).filter(c => c[1] === "journalctl").length, 1);
  assert.equal(io.snapshot().preserved, false);
});
