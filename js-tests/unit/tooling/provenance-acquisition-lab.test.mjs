import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, realpath, lstat, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { AcquisitionRecordError, acquisitionSha256 } from "../../../scripts/provenance-acquisition-record.mjs";
import { copyLabProfile, labPaths, labManagerArguments, labDaemonConfiguration, labChildEnvironment }
  from "../../../scripts/provenance-acquisition-lab-profile.mjs";
import { LabClock, createAcquisitionLab } from "../../../scripts/provenance-acquisition-lab.mjs";
import { LabHandles, LabMemorySink, createLabFileSink, startLabCommand, collectLabCommand }
  from "../../../scripts/provenance-acquisition-lab-command.mjs";
import { LabFiles, readLabProfile } from "../../../scripts/provenance-acquisition-lab-files.mjs";
import { LabKernel } from "../../../scripts/provenance-acquisition-lab-kernel.mjs";
import { NativeLabIO } from "../../../scripts/provenance-acquisition-lab-io.mjs";
import { labBusArguments, parseLabUnitPath, parseLabUnit, parseLabService, reconcileLabManager }
  from "../../../scripts/provenance-acquisition-lab-manager.mjs";
import { labContainerdPaths, validateLabContainerd, validateLabDocker }
  from "../../../scripts/provenance-acquisition-lab-daemon.mjs";
import { labProfile, managerProperties, propertyBytes, labKernelModel, labNativePorts, labWorkerPorts }
  from "../../fixtures/provenance-acquisition-lab.mjs";
import { deferred } from "../../fixtures/provenance-acquisition-host.mjs";

function lifecycle(overrides = {}) {
  const calls = []; const io = Object.fromEntries(["open", "launch", "readiness", "revoke", "owned", "effect", "observe",
    "saveBoundary", "waitRetired", "preserve", "collect", "close", "halt"].map(name => [name, async (...args) => {
    calls.push([name, ...args]);
    if (overrides[name]) return overrides[name](...args);
    if (name === "owned") return true;
    if (name === "observe") return { value: { populated: args[0] !== "work", frozen: args[0] === "keeper" }, bytes: Buffer.from("finite") };
  }]));
  io.revoke = () => { calls.push(["revoke"]); overrides.revoke?.(); };
  io.halt = () => { calls.push(["halt"]); overrides.halt?.(); };
  io.snapshot = () => ({ finite: true });
  return { io, calls };
}

test("closed copied profile rejects observable accessors and unrelated budgets before callbacks", () => {
  const original = labProfile(); const p = copyLabProfile(original); original.roots.tools.path = "/elsewhere";
  assert.equal(p.roots.tools.path, "/tools"); assert(Object.isFrozen(p.tools));
  for (const mutate of [v => { v.extra = 1; }, v => { v.limits.retireMs = 0; }, v => { v.context.deadlineNs = "1"; },
    v => { v.roots.scratch.path = "/tools/child"; }, v => { v.tools.python.path = "/global/python"; },
    v => { v.tools.dockerd.identity = v.tools.containerd.identity; }, v => { v.roots.evidence.path = "/bad\ud800"; },
    v => { Object.defineProperty(v.expected, "node", { enumerable: true, get() { assert.fail("getter"); } }); }]) {
    const value = labProfile(); const port = lifecycle(); mutate(value);
    assert.throws(() => createAcquisitionLab(value, { io: port.io }), { code: "LAB_INPUT" }); assert.deepEqual(port.calls, []);
  }
});

test("fixed manager recipe closes environment and registers one unique bounded keeper", () => {
  const p = copyLabProfile(labProfile()); const args = labManagerArguments(p, "a".repeat(64));
  assert(args.includes(`--unit=${labPaths(p).unit}`));
  for (const property of ["Type=exec", "Delegate=yes", "DelegateSubgroup=keeper", "Restart=no", "KillMode=control-group",
    "CollectMode=inactive", "RuntimeMaxSec=3000ms", "MemoryMax=1048576", "TasksMax=100"]) assert(args.includes("--property=" + property));
  assert(!args.some(arg => /replace|--collect/.test(arg)));
  assert.deepEqual(args.slice(-4), [labPaths(p).keeperEntry, "keeper", labPaths(p).profile, "a".repeat(64)]);
  const clear = args.indexOf(p.tools.env.path); assert(clear >= 0); assert.deepEqual(args.slice(clear + 1, clear + 3), ["-i", "--"]);
  assert.deepEqual(labChildEnvironment(p), { PATH: "/tools", LANG: "C", LC_ALL: "C" });
  const config = labDaemonConfiguration(p); assert.equal(config.bridge, "none"); assert.equal(config["storage-driver"], "vfs");
  assert.equal(config.features["containerd-snapshotter"], false); assert.equal(config.iptables, false);
});

test("typed manager fields reject independently wrong limits, invocation, job and unsafe uint64", () => {
  const p = copyLabProfile(labProfile()); const props = managerProperties(p);
  const before = parseLabUnit(propertyBytes(props.unit), labPaths(p).unit);
  const service = parseLabService(propertyBytes(props.service), p);
  assert.equal(reconcileLabManager(before, service, before).service.mainPid, 1001);
  for (const key of Object.keys(props.service).filter(k => !["MainPID", "ExecMainCode", "ExecMainStatus", "Result"].includes(k))) {
    const value = structuredClone(props.service); value[key].data = typeof value[key].data === "boolean" ? false
      : typeof value[key].data === "number" ? value[key].data + 1 : "wrong";
    assert.throws(() => parseLabService(propertyBytes(value), p), { code: "LAB_MANAGER" }, key);
  }
  const unsafe = structuredClone(props.service); unsafe.MemoryMax.data = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => parseLabService(propertyBytes(unsafe), p), { code: "LAB_MANAGER" });
  const other = { ...before, invocationId: "2".repeat(32) };
  assert.throws(() => reconcileLabManager(before, service, other), { code: "LAB_MANAGER" });
  for (const value of [[1, "/"], [-1, "/"], [0, "/wrong"]]) {
    const unit = structuredClone(props.unit); unit.Job.data = value;
    assert.throws(() => parseLabUnit(propertyBytes(unit), labPaths(p).unit), { code: "LAB_MANAGER" });
  }
  const args = labBusArguments(p, "GetUnit"); assert(args.includes("call")); assert(!args.includes("get-property"));
  assert(args.includes("--auto-start=no")); assert(args.includes("--allow-interactive-authorization=no"));
  assert.throws(() => parseLabUnitPath(Buffer.from('{"type":"o","data":["/unrelated"]}')), { code: "LAB_MANAGER" });
});

test("one original monotonic history cannot be renewed for preparation or retirement", () => {
  const p = labProfile(); let now = 101n; const clock = new LabClock(p, () => now);
  assert.equal(clock.work(), 1n); now = 500000100n; assert.throws(() => clock.work(), { code: "LAB_DEADLINE" });
  assert.equal(clock.retire(), 500000000n); clock.revoke(); assert.throws(() => clock.work(), { code: "LAB_STOPPED" });
  now = 100n; assert.throws(() => clock.retire(), { code: "LAB_CLOCK" });
  now = 3000000100n; assert.throws(() => clock.retire(), { code: "LAB_DEADLINE" });
});

test("grouped lifecycle preserves ordered original boundary before forced whole-unit retirement and collection", async () => {
  const p = labProfile(); const port = lifecycle(); const owner = createAcquisitionLab(p, { io: port.io, clock: () => 101n });
  assert.deepEqual(port.calls, []); const running = owner.run(); assert.equal(owner.run(), running);
  const result = await running; assert(result.locallyComplete); assert(result.retirementObserved); assert(result.locallyPreserved);
  const names = port.calls.map(c => c[0] === "effect" || c[0] === "observe" ? c.slice(0, 2).join(":") : c[0]);
  for (const [a, b] of [["launch", "readiness"], ["effect:keeper.freeze", "effect:work.kill"],
    ["observe:keeper", "observe:work"], ["saveBoundary", "effect:unit.kill"], ["waitRetired", "preserve"],
    ["preserve", "collect"], ["collect", "close"]]) assert(names.indexOf(a) < names.indexOf(b), `${a} before ${b}`);
  assert.equal(result.externalClosure, "unqualified"); assert.equal(result.clockAdmission, "unqualified");
});

test("a held freeze cannot suppress work kill or bounded whole-unit containment", async () => {
  const held = deferred(); const observed = deferred(); const p = labProfile(); p.limits.retireMs = 60;
  const port = lifecycle({ effect: target => target === "keeper.freeze" ? held.promise : undefined,
    observe: target => target === "keeper" ? observed.promise : undefined });
  const owner = createAcquisitionLab(p, { io: port.io, clock: () => 101n }); const result = await owner.run();
  assert.equal(result.locallyComplete, false); assert.equal(result.cleanupError, "LAB_CLEANUP");
  assert(port.calls.some(c => c[0] === "effect" && c[1] === "work.kill"));
  assert(port.calls.some(c => c[0] === "effect" && c[1] === "unit.kill"));
  assert(!port.calls.some(c => ["preserve", "collect", "close"].includes(c[0])));
  held.resolve(); observed.resolve({ value: { frozen: true }, bytes: Buffer.from("late") });
  await new Promise(resolve => setImmediate(resolve));
  assert(!port.calls.some(c => c[0] === "observe" && c[1] === "work"));
});

test("partial work, original failure and independent preservation failure never become success", async () => {
  for (const phase of ["open", "launch", "readiness", "saveBoundary", "waitRetired", "preserve", "collect", "close"]) {
    const port = lifecycle({ [phase]() { throw new AcquisitionRecordError(phase === "readiness" ? "LAB_WORKER" : "LAB_WRITE"); } });
    const owner = createAcquisitionLab(labProfile(), { io: port.io, clock: () => 101n }); const result = await owner.run();
    assert.equal(result.locallyComplete, false, phase);
    if (["open", "launch", "readiness"].includes(phase)) assert(result.firstFailure, phase);
    else assert(result.cleanupError, phase);
    if (["saveBoundary", "waitRetired", "preserve"].includes(phase)) assert(!port.calls.some(c => c[0] === "collect"), phase);
  }
});

test("revocation during a late launch retains pending work and never starts readiness or collection", async () => {
  const entered = deferred(); const held = deferred(); const port = lifecycle({ launch() { entered.resolve(); return held.promise; } });
  const owner = createAcquisitionLab(labProfile(), { io: port.io, clock: () => 101n }); const run = owner.run();
  await entered.promise; const stopped = owner.stop(); assert.equal(stopped.firstFailure, "LAB_STOPPED");
  const result = await run; assert(result.workPending); assert.equal(result.locallyComplete, false);
  assert(!port.calls.some(c => ["readiness", "collect", "close"].includes(c[0])));
  held.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert(!port.calls.some(c => c[0] === "readiness"));
});

test("native exterior composition consumes typed manager originals and retains forced result before reset", async () => {
  const p = copyLabProfile(labProfile()); const ports = labNativePorts(p);
  const owner = createAcquisitionLab(p, { clock: () => 101n, io: (profile, checks) => new NativeLabIO(profile, checks, ports) });
  const result = await owner.run(); assert.equal(result.firstFailure, null); assert.equal(result.cleanupError, null);
  assert(result.locallyComplete); assert(result.io.registrationCollected);
  const reset = ports.calls.findIndex(c => c[0] === "command" && c[1] === "systemctl");
  const saved = ports.calls.findIndex(c => c[0] === "write" && c[1] === "retirement.json"); assert(saved < reset);
  assert(ports.originals.has("manager.retired.service.stdout"));
  const retired = JSON.parse(ports.originals.get("manager.retired.service.stdout"));
  assert.equal(retired.data[0].ExecMainStatus.data, 9); assert.equal(retired.data[0].Result.data, "signal");
  assert(ports.calls.filter(c => c[0] === "command" && c[1] === "systemdRun").length === 1);
  assert(ports.calls.every(c => !["remove", "unlink", "unmount"].includes(c[0])));
});

test("changed native invocation or group identity forbids destructive targets and reset", async () => {
  for (const mode of ["invocation", "group"]) {
    const p = copyLabProfile(labProfile()); let gets = 0;
    const ports = labNativePorts(p, state => {
      if (mode === "invocation" && state.name === "busctl" && ++gets === 3) state.changeInvocation(Array(16).fill(2));
      if (mode === "group" && state.name === "systemdRun") state.groups.unit = { dev: "1", ino: "9999" };
    });
    const owner = createAcquisitionLab(p, { clock: () => 101n, io: (profile, checks) => new NativeLabIO(profile, checks, ports) });
    const result = await owner.run(); assert(!result.locallyComplete); assert(result.firstFailure);
    assert(!ports.calls.some(c => c[0] === "effect"));
    assert(!ports.calls.some(c => c[0] === "command" && c[1] === "systemctl"));
  }
});

test("worker recipe verifies entry before tools, rejects stock adoption and preserves native/config/API sources", async () => {
  const p = copyLabProfile(labProfile()); const ports = labWorkerPorts(p);
  const io = new NativeLabIO(p, { work() {}, retire() {} }, ports);
  const work = io.worker(); await ports.ready; ports.endDaemon(); await assert.rejects(work, { code: "LAB_WORKER" });
  assert(ports.calls.findIndex(c => c[0] === "entry") < ports.calls.findIndex(c => c[0] === "command"));
  assert(ports.originals.has("containerd.generated.toml")); assert(ports.originals.has("containerd.cmdline"));
  assert(ports.originals.has("docker.info.body")); assert(ports.originals.has("ready.json"));
  assert.equal(ports.calls.filter(c => c[0] === "request").length, 2);
  assert(ports.calls.filter(c => c[0] === "request").every(c => c[1].method === "GET" && c[1].agent === false));
  const parse = ports.calls.filter(c => c[0] === "command" && c[1] === "python" && !c[2].includes("--version"));
  assert.equal(parse.length, 2); assert(parse.every(c => c[2].includes(p.roots.pythonEnvironment.path)));
  for (const options of [{ stock: true }, { entryFailure: true }]) {
    const failedPorts = labWorkerPorts(p, options); const failed = new NativeLabIO(p, { work() {}, retire() {} }, failedPorts);
    await assert.rejects(failed.worker());
    assert(!failedPorts.originals.has("ready.json")); assert(!failedPorts.calls.some(c => c[0] === "request"));
    if (options.entryFailure) assert(!failedPorts.calls.some(c => c[0] === "command"));
    else assert(!failedPorts.calls.some(c => c[0] === "command" && c[2].includes("--validate")));
  }
});

test("separate worker cursors and files are required before preservation or collection", async () => {
  for (const missing of ["worker.source.json", "daemon.stdout", "keeper.launch.json"]) {
    const p = copyLabProfile(labProfile()); const ports = labNativePorts(p, state => {
      if (state.name === "systemdRun") state.originals.delete(missing);
    });
    const owner = createAcquisitionLab(p, { clock: () => 101n, io: (profile, checks) => new NativeLabIO(profile, checks, ports) });
    const result = await owner.run(); assert(result.retirementObserved); assert(!result.locallyPreserved, missing);
    assert(!result.locallyComplete); assert(!ports.calls.some(c => c[0] === "command" && c[1] === "systemctl"));
    assert(!ports.records.has("worker.source.json")); assert(ports.childRecords.has("worker.source.json"));
  }
});

test("a failed worker before verified entry never gains retirement from historical empty work", async () => {
  const p = copyLabProfile(labProfile()); const ports = labNativePorts(p, state => {
    if (state.name === "systemdRun") state.originals.set("worker.json", Buffer.from(JSON.stringify({ firstFailure: "LAB_WORKER" })));
  });
  const owner = createAcquisitionLab(p, { clock: () => 101n, io: (profile, checks) => new NativeLabIO(profile, checks, ports) });
  const result = await owner.run(); assert.equal(result.firstFailure, "LAB_WORKER"); assert(!result.retirementObserved);
  assert(!result.locallyComplete); assert(ports.calls.some(c => c[0] === "effect" && c[1] === "unit.kill"));
  assert(!ports.calls.some(c => c[0] === "command" && c[1] === "systemctl"));
});

test("partial HTTP body and failure metadata survive an independently reset response", async () => {
  const p = copyLabProfile(labProfile()); const ports = labWorkerPorts(p, { httpFailure: true });
  const io = new NativeLabIO(p, { work() {}, retire() {} }, ports);
  await assert.rejects(io.worker()); await io.workerFailure("LAB_PROTOCOL");
  assert.equal(ports.originals.get("docker.info.partial.body").toString(), '{"Driver":"');
  const meta = JSON.parse(ports.originals.get("docker.info.partial.response.json"));
  assert.equal(meta.complete, false); assert.equal(meta.capturedBytes, 11); assert.equal(meta.response.statusCode, 200);
  assert(!ports.originals.has("ready.json"));
  const failure = JSON.parse(ports.originals.get("worker.json")); assert.equal(failure.firstFailure, "LAB_PROTOCOL");
  assert(failure.evidence.records.some(r => r.label === "docker.info.partial.body"));
});

test("failed partial-body or metadata preservation remains explicit and blocks exterior collection", async () => {
  const p = copyLabProfile(labProfile());
  for (const partialWriteFailure of ["body", "metadata"]) {
    const ports = labWorkerPorts(p, { httpFailure: true, partialWriteFailure });
    const worker = new NativeLabIO(p, { work() {}, retire() {} }, ports);
    await assert.rejects(worker.worker()); await worker.workerFailure("LAB_PROTOCOL");
    const ending = ports.originals.get("worker.json"); const failed = JSON.parse(ending);
    assert.equal(failed.evidence.preservationComplete, false);
    const exterior = labNativePorts(p, state => { if (state.name === "systemdRun") state.originals.set("worker.json", ending); });
    const owner = createAcquisitionLab(p, { clock: () => 101n,
      io: (profile, checks) => new NativeLabIO(profile, checks, exterior) });
    const result = await owner.run(); assert.equal(result.locallyPreserved, false); assert(!result.locallyComplete);
    assert(!exterior.calls.some(c => c[0] === "command" && c[1] === "systemctl"));
  }
});

test("native kernel opens identified hierarchy, enters self once and writes each retirement target once", async () => {
  const p = copyLabProfile(labProfile()); const model = labKernelModel(p); const kernel = new LabKernel(p, { work() {}, retire() {} }, model.port);
  await kernel.open(); await kernel.unit(); await kernel.createWork(); await kernel.enterWorker();
  assert.equal(kernel.snapshot().entry, "verified");
  const freeze = kernel.effect("keeper.freeze"); assert.equal(kernel.effect("keeper.freeze"), freeze);
  await Promise.all([freeze, kernel.effect("work.kill")]);
  const frozen = await kernel.observe("keeper"); const empty = await kernel.observe("work");
  assert(frozen.value.frozen); assert.equal(empty.value.populated, false); await kernel.effect("unit.kill"); await kernel.close();
  assert.equal(model.calls.filter(c => c.kind === "write" && c.name === "cgroup.procs").length, 1);
  assert.equal(model.calls.filter(c => c.kind === "write" && c.name === "cgroup.kill").length, 2);
  assert.equal(kernel.snapshot().handles.retained, 0); assert([...model.handles.values()].every(h => h.closed));
});

test("late native opening and failed target writes retain adoption, first cause and once-only cleanup", async () => {
  const p = copyLabProfile(labProfile()); let revoked = false; const enter = deferred(); const hold = deferred(); let armed = true;
  const model = labKernelModel(p, { async beforeOpen() { if (armed) { armed = false; enter.resolve(); await hold.promise; } } });
  const kernel = new LabKernel(p, { work() { if (revoked) throw new AcquisitionRecordError("LAB_STOPPED"); }, retire() {} }, model.port);
  const pending = kernel.open(); await enter.promise; revoked = true; hold.resolve();
  await assert.rejects(pending, { code: "LAB_STOPPED" }); await kernel.close();
  assert.equal(model.calls.filter(c => c.kind === "open").length, 1); assert([...model.handles.values()].every(h => h.closed));
  const bad = labKernelModel(p, { beforeWrite() { return { bytesWritten: 0 }; } });
  const failed = new LabKernel(p, { work() {}, retire() {} }, bad.port); await failed.open(); await failed.unit(); await failed.createWork();
  const kill = failed.effect("work.kill"); await assert.rejects(kill, { code: "LAB_WRITE" });
  assert.equal(failed.effect("work.kill"), kill); assert.equal(failed.snapshot().effects["work.kill"].state, "unknown"); await failed.close();
});

test("ordinary exclusive evidence and bounded stdout/stdin ownership need no native laboratory", async () => {
  const root = await mkdtemp(join(tmpdir(), "tabgrad-lab-test-"));
  try {
    const p = labProfile(); p.roots.evidence.path = root; const files = new LabFiles(p, () => {});
    const bytes = Buffer.from([0, 255, 13, 10]); await files.write("original.bin", bytes);
    assert.deepEqual(await files.read("original.bin"), bytes);
    await assert.rejects(files.write("original.bin", bytes), { code: "LAB_LIMIT" });
    assert.equal((await lstat(`${labPaths(p).prefix}.original.bin`)).mode & 0o777, 0o600);
    const input = Buffer.from(JSON.stringify(copyLabProfile(p))); const profile = join(root, "input.json");
    await writeFile(profile, input, { mode: 0o600 }); assert.deepEqual(await readLabProfile(profile, acquisitionSha256(input)), copyLabProfile(p));
    await assert.rejects(readLabProfile(profile, "f".repeat(64)), { code: "LAB_PROFILE" });
    const handles = new LabHandles(); const context = { t0MonotonicNs: process.hrtime.bigint().toString(), deadlineNs: "3000000000" };
    const sink = await createLabFileSink(`${labPaths(p).prefix}.command`, 128, context, process.hrtime.bigint, () => {}, handles);
    const command = startLabCommand({ file: process.execPath, args: ["-e", "process.stdin.pipe(process.stdout)"], env: {}, stdin: bytes }, sink, () => {});
    const result = await collectLabCommand(command); assert.deepEqual(result.stdout, bytes); assert.equal(result.result.inputState, "acknowledged");
    assert.equal(handles.snapshot().retained, 0);
    await files.verifyPrefix("command.stdout", result.result.capture.files.stdout, result.result.capture.channels.stdout);
    const rawPath = `${labPaths(p).prefix}.command.stdout`; const raw = await readFile(rawPath);
    assert(raw.subarray(0, bytes.length).equals(bytes)); raw[0] ^= 1; await writeFile(rawPath, raw);
    await assert.rejects(files.verifyPrefix("command.stdout", result.result.capture.files.stdout,
      result.result.capture.channels.stdout), { code: "LAB_PRESERVATION" }); await files.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("prepared tool identity, executable mode, byte size and independent hash are checked on ordinary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "tabgrad-lab-tools-"));
  try {
    const file = join(root, "tool"); const bytes = Buffer.from("finite executable bytes\n");
    await writeFile(file, bytes, { mode: 0o700 }); const s = await lstat(file, { bigint: true });
    const p = labProfile(); p.tools.node = { path: file, realPath: await realpath(file), identity: { dev: String(s.dev), ino: String(s.ino) },
      bytes: bytes.length, sha256: acquisitionSha256(bytes) };
    const files = new LabFiles(p, () => {}); await files.verifyTool("node");
    await writeFile(file, Buffer.alloc(bytes.length, 1)); await assert.rejects(files.verifyTool("node"), { code: "LAB_TOOL" });
    await writeFile(file, bytes); await chmod(file, 0o600); await assert.rejects(files.verifyTool("node"), { code: "LAB_TOOL" });
    await chmod(file, 0o700); p.tools.node.identity.ino = "1";
    await assert.rejects(files.verifyTool("node"), { code: "FILE_IDENTITY" });
    await files.close(); assert.equal(files.snapshot().handles.retained, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bounded command overflow preserves a confirmed prefix and independently observed child close", async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 42;
  let kills = 0; child.kill = () => {
    kills++; child.stdout.end(); child.stderr.end(); child.emit("exit", null, "SIGKILL"); child.emit("close");
  };
  const sink = new LabMemorySink(3);
  const command = startLabCommand({ file: "/finite", args: [], env: {} }, sink, () => {}, () => child);
  await new Promise(resolve => setImmediate(resolve)); child.stdout.write(Buffer.from("abcdef"));
  const result = await command.result; assert.equal(result.firstFailure, "LAB_LIMIT"); assert.equal(kills, 1);
  assert.equal((await command.collect("stdout")).toString(), "abc"); assert(result.closed); assert(result.exited);
});

test("failed closes remain owned without accumulating successful handle history", async () => {
  const bag = new LabHandles(); let closes = 0;
  const bad = { async close() { closes++; throw Error("private detail"); } }; bag.push(bad);
  for (let i = 0; i < 100; i++) { const h = { async close() {} }; bag.push(h); await bag.close(h); }
  const one = bag.close(bad); assert.equal(bag.close(bad), one); await assert.rejects(one); await bag.closeAll();
  assert.equal(closes, 1); assert.deepEqual(bag.snapshot(), { retained: 1, closed: 100, pending: 0, unknown: 1 });
});

test("daemon observations reject independent stock paths, imports, networking, driver and API mismatches", () => {
  const p = labProfile(); const f = labPaths(p); const paths = labContainerdPaths(p);
  const generated = { version: 2, root: paths.root, state: paths.state, imports: [], grpc: { address: paths.grpc },
    debug: { address: paths.debug }, ttrpc: {}, metrics: {}, proxy_plugins: {} };
  const effective = { ...structuredClone(generated), version: 4, ttrpc: { address: paths.ttrpc } };
  assert.deepEqual(validateLabContainerd(p, generated, effective), paths);
  for (const mutate of [v => { v.root = "/stock"; }, v => { v.grpc.address = "/stock.sock"; },
    v => { v.imports = ["/other.toml"]; }, v => { v.grpc.tcp_address = "127.0.0.1:1"; },
    v => { v.proxy_plugins = { other: {} }; }]) {
    const value = structuredClone(effective); mutate(value); assert.throws(() => validateLabContainerd(p, generated, value), { code: "LAB_PROTOCOL" });
  }
  const version = { Version: "29.9.1", ApiVersion: "1.56", MinAPIVersion: "1.44", Os: "linux", Arch: "amd64" };
  const info = { Driver: "vfs", CgroupDriver: "cgroupfs", CgroupVersion: "2", DockerRootDir: f.data, Containers: 0, Images: 0, LiveRestoreEnabled: false };
  validateLabDocker(p, version, info);
  for (const key of ["Driver", "CgroupDriver", "DockerRootDir", "Containers", "LiveRestoreEnabled"]) {
    assert.throws(() => validateLabDocker(p, version, { ...info, [key]: "wrong" }), { code: "LAB_PROTOCOL" });
  }
});

test("native entry stays inert on import and refuses incomplete arguments with closed diagnostics", () => {
  const module = resolve("scripts/provenance-acquisition-lab-entry.mjs");
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(module)})`], { encoding: "utf8", timeout: 5000 });
  assert.equal(imported.status, 0); assert.equal(imported.stdout, ""); assert.equal(imported.stderr, "");
  const invalid = spawnSync(process.execPath, [module, "PRIVATE_ARGUMENT"], { encoding: "utf8", timeout: 5000 });
  assert.equal(invalid.status, 1); assert.equal(invalid.stdout, ""); assert.equal(invalid.stderr, "LAB_INPUT\n");
});
