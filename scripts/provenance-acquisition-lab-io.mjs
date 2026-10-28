import { lstat, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { request } from "node:http";
import { acquisitionSha256, AcquisitionRecordError, requireAcquisition } from "./provenance-acquisition-record.mjs";
import { freezeHostData } from "./provenance-acquisition-host-profile.mjs";
import { LabFiles, readLabDiagnosticPlan } from "./provenance-acquisition-lab-files.mjs";
import { LabKernel } from "./provenance-acquisition-lab-kernel.mjs";
import { LabHandles, LabMemorySink, createLabFileSink, startLabCommand, collectLabCommand } from "./provenance-acquisition-lab-command.mjs";
import { LAB_TOOLS, LAB_PROFILE_BYTES, labPaths, labManagerArguments, labChildEnvironment, labDaemonConfiguration }
  from "./provenance-acquisition-lab-profile.mjs";
import { labBusArguments, parseLabUnitPath, parseLabUnit, parseLabService, reconcileLabManager }
  from "./provenance-acquisition-lab-manager.mjs";
import { labContainerdPaths, validateLabContainerd, validateLabDocker } from "./provenance-acquisition-lab-daemon.mjs";
import { AcquisitionHttpTransaction } from "./provenance-acquisition-http-transaction.mjs";
import { readNativeBytes } from "./provenance-acquisition-native-path.mjs";
import { LabDiagnosticCase } from "./provenance-acquisition-lab-case.mjs";
import { ACQUISITION_PAYLOAD_LIMITS } from "./provenance-acquisition-payload.mjs";
import { LabStartupDiagnostics } from "./provenance-acquisition-lab-startup.mjs";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = bytes => {
  const text = bytes.toString("utf8"); requireAcquisition(Buffer.from(text).equals(bytes), "LAB_PROTOCOL");
  try { return JSON.parse(text); } catch { throw new AcquisitionRecordError("LAB_PROTOCOL"); }
};
const equal = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;

/** Fixed native preparation I/O. Import/construction never starts a service or reads a host. */
export class NativeLabIO {
  #p; #f; #checks; #files; #retireFiles; #handles = new LabHandles(); #kernel;
  #commands = new Set(); #waiter = null; #daemon = null; #http = new Set(); #revoked = false; #halted = false;
  #waiterResult = null; #waiterPreservation = null;
  #profileHash; #manager = null; #binding = null; #boundary = null; #collected = false; #preserved = false;
  #pending = new Set(); #close = null;
  #commandPort; #failedCommand = null; #failedManager = null;
  #ownershipUncertain = false;
  #retirementCommands = new WeakSet();
  #fs; #request; #pid;
  #fileCommands = new Map();
  #evidenceReady = false;
  #workEntryObserved = false;
  #preservationFailed = false;
  #diagnosticPlan = null; #diagnosticCase = null; #diagnosticResult = null; #readyRecord = null; #diagnosticInputHandles = null;
  #readyHash = null; #diagnosticResultHash = null;
  #startup;
  constructor(p, checks, ports = {}) {
    this.#p = p; this.#f = labPaths(p); this.#checks = checks;
    const gate = { work: () => this.#work(), retire: () => this.#retire() };
    this.#kernel = ports.kernel ?? new LabKernel(p, gate);
    this.#files = ports.files ?? new LabFiles(p, gate.work, this.#handles);
    this.#retireFiles = ports.retirementFiles ?? new LabFiles(p, gate.retire, this.#handles);
    this.#commandPort = ports.command?.bind(ports);
    this.#fs = Object.freeze({ lstat: ports.filesystem?.lstat?.bind(ports.filesystem) ?? lstat,
      open: ports.filesystem?.open?.bind(ports.filesystem) ?? open,
      realpath: ports.filesystem?.realpath?.bind(ports.filesystem) ?? realpath });
    this.#request = ports.request ?? request; this.#pid = ports.pid ?? process.pid;
    this.#profileHash = acquisitionSha256(Buffer.from(JSON.stringify(p)));
    this.#startup = new LabStartupDiagnostics(p, { command: this.#command.bind(this),
      files: this.#retireFiles, check: this.#retire });
  }
  #work = () => { requireAcquisition(!this.#revoked && !this.#halted, "LAB_STOPPED"); return this.#checks.work(); };
  #retire = () => { requireAcquisition(!this.#halted, "LAB_STOPPED"); return this.#checks.retire(); };
  #admit(fn) {
    const entry = { promise: null }; this.#pending.add(entry);
    entry.promise = Promise.resolve().then(fn).finally(() => this.#pending.delete(entry)); return entry.promise;
  }
  async #command(name, args, { retire = false, label = null, stdin } = {}) {
    const check = retire ? this.#retire : this.#work; check();
    if (this.#commandPort) {
      const command = await this.#commandPort(name, [...args], { retire, label, stdin, check, env: labChildEnvironment(this.#p) });
      if (retire) this.#retirementCommands.add(command);
      if (label) this.#fileCommands.set(label, command);
      this.#commands.add(command);
      void command.result.then(result => { if (result.closed) this.#commands.delete(command); }); return command;
    }
    const sink = label ? await createLabFileSink(`${this.#f.prefix}.${label}`, this.#p.limits.observationBytes,
      this.#p.context, process.hrtime.bigint, check, this.#handles) : new LabMemorySink(this.#p.limits.observationBytes);
    check();
    const command = startLabCommand({ file: this.#p.tools[name].path, args, env: labChildEnvironment(this.#p), stdin }, sink, check);
    if (retire) this.#retirementCommands.add(command);
    if (label) this.#fileCommands.set(label, command);
    this.#commands.add(command);
    void command.result.then(result => { if (result.closed) this.#commands.delete(command); });
    return command;
  }
  async #completed(name, args, options) {
    const command = await this.#command(name, args, options);
    try {
      const result = await collectLabCommand(command);
      if (options?.label) await this.#files.json(`${options.label}.result.json`, result.result);
      requireAcquisition(result.result.exitCode === 0 && result.result.signal === null, "LAB_TOOL"); return result;
    } catch (error) { this.#failedCommand ??= command; throw error; }
  }
  async #saveCommands(label, originals, files = this.#retireFiles) {
    for (const [name, result] of Object.entries(originals)) {
      await files.write(`${label}.${name}.stdout`, result.stdout);
      await files.write(`${label}.${name}.stderr`, result.stderr);
      await files.json(`${label}.${name}.result.json`, result.result);
    }
  }
  async #saveKnownOriginals(publications) {
    let failure;
    for (const publish of publications) {
      try { this.#retire(); await publish(); this.#retire(); }
      catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
  #saveWaiter(waiter = null) {
    if (!this.#waiterPreservation) {
      // The result and each channel are independent known originals. A failed
      // publication must not hide the others or be retried by later preservation.
      this.#waiterPreservation = this.#saveKnownOriginals([
        () => this.#retireFiles.json("manager.wait.waiter.result.json", waiter?.result ?? this.#waiterResult),
        ...["stdout", "stderr"].map(role => async () => {
          const bytes = waiter ? waiter[role] : await this.#waiter.collect(role);
          this.#retire(); await this.#retireFiles.write(`manager.wait.waiter.${role}`, bytes);
        }),
      ]);
    }
    return this.#waiterPreservation;
  }
  async #readDiagnostic(path) {
    let plan;
    try { plan = await readLabDiagnosticPlan(path, this.#p.diagnostic.sha256); }
    catch (error) { this.#diagnosticInputHandles = error?.handleOwner ?? null; throw error; }
    this.#work();
    requireAcquisition(plan.sourceRevision === this.#p.context.sourceRevision
      && !Object.values(plan.operations).includes(this.#p.context.operationId)
      && BigInt(plan.timing.deadlineNs) + BigInt(this.#p.limits.prepareMs + this.#p.limits.retireMs) * 1000000n
        < BigInt(this.#p.context.deadlineNs)
      && this.#p.limits.observationBytes >= Math.max(ACQUISITION_PAYLOAD_LIMITS.stdout,
        ACQUISITION_PAYLOAD_LIMITS.stderr, plan.limits.responseBytes), "LAB_INPUT");
    this.#diagnosticPlan = plan; return plan;
  }
  async #managerObservation() {
    const originals = {};
    try {
    const get = async (key, method, path) => {
      const r = await this.#completed("busctl", labBusArguments(this.#p, method, path), { retire: true });
      originals[key] = r; return r.stdout;
    };
    const path = parseLabUnitPath(await get("path", "GetUnit"));
    const before = parseLabUnit(await get("before", "GetAllUnit", path), this.#f.unit);
    const service = parseLabService(await get("service", "GetAllService", path), this.#p);
    const after = parseLabUnit(await get("after", "GetAllUnit", path), this.#f.unit);
    const value = reconcileLabManager(before, service, after);
    if (this.#binding) requireAcquisition(value.invocationId === this.#binding.invocationId, "LAB_IDENTITY");
    return { value, originals };
    } catch (error) { this.#failedManager ??= originals; this.#ownershipUncertain = true; throw error; }
  }
  async #raw(path, limit = this.#p.limits.observationBytes, check = this.#work) {
    check(); const h = await this.#fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW); this.#handles.push(h); check();
    let failure; let bytes;
    try {
      const s = await h.stat({ bigint: true }); check();
      requireAcquisition(s.isFile() && s.nlink === 1n && s.size <= BigInt(limit), "LAB_IDENTITY");
      bytes = await readNativeBytes(h, limit, check);
      const after = await h.stat({ bigint: true }); check();
      requireAcquisition(s.dev === after.dev && s.ino === after.ino && s.size === after.size
        && s.mtimeNs === after.mtimeNs && s.ctimeNs === after.ctimeNs, "LAB_IDENTITY");
    } catch (error) { failure = error; }
    try { await this.#handles.close(h); } catch { failure ??= new AcquisitionRecordError("LAB_CLEANUP"); }
    if (failure) throw failure; return bytes;
  }
  async #saveProcess(label, record, files = this.#files) {
    for (const [key, bytes] of Object.entries(record.originals)) await files.write(`${label}.${key.toLowerCase()}`, bytes);
    await files.json(`${label}.json`, record.data);
  }
  open() { return this.#admit(async () => {
    const observer = await this.#kernel.open();
    requireAcquisition(observer.data.membership !== this.#f.group && !observer.data.membership.startsWith(this.#f.group + "/"), "LAB_IDENTITY");
    await this.#files.roots(); this.#evidenceReady = true;
    if (this.#p.diagnostic) await this.#readDiagnostic(this.#p.diagnostic.path);
    for (const name of LAB_TOOLS) await this.#files.verifyTool(name);
    await this.#files.scratch();
    await this.#files.json("profile.json", this.#p, LAB_PROFILE_BYTES);
    await this.#files.json("daemon.json", labDaemonConfiguration(this.#p));
    if (this.#diagnosticPlan) {
      const saved = await this.#files.json("diagnostic.plan.json", this.#diagnosticPlan, LAB_PROFILE_BYTES);
      requireAcquisition(saved.sha256 === this.#p.diagnostic.sha256, "LAB_PROFILE");
    }
    await this.#saveProcess("observer", observer);
  }); }
  launch() { return this.#admit(async () => {
    this.#work(); requireAcquisition(!this.#waiter, "LAB_BUSY");
    this.#waiter = await this.#command("systemdRun", labManagerArguments(this.#p, this.#profileHash), { retire: true });
    void this.#waiter.result.then(result => { this.#waiterResult = result; });
    this.#work();
  }); }
  async owned() {
    if (!this.#waiter) return false;
    requireAcquisition(!this.#ownershipUncertain, "LAB_IDENTITY");
    if (this.#binding) return true;
    // Exact keeper identity plus actual manager/proc binding precedes every destructive target.
    const keeper = await this.#retireFiles.readJson("keeper.json");
    if (!keeper) throw new AcquisitionRecordError("LAB_IDENTITY");
    requireAcquisition(keeper.kind === "lab_keeper_v1" && keeper.operationId === this.#p.context.operationId
      && keeper.profileSha256 === this.#profileHash && Number.isSafeInteger(keeper.process?.pid ? Number(keeper.process.pid) : null), "LAB_IDENTITY");
    const observation = await this.#managerObservation(); const manager = observation.value;
    requireAcquisition(manager.service.mainPid === Number(keeper.process.pid) && manager.job[0] === 0
      && manager.activeState === "active", "LAB_IDENTITY");
    await this.#kernel.unit(this.#retire);
    await this.#kernel.group("keeper", this.#retire);
    const groups = await this.#kernel.identities(this.#retire);
    requireAcquisition(equal(groups.unit, keeper.groups?.unit) && equal(groups.keeper, keeper.groups?.keeper), "LAB_IDENTITY");
    const proc = await this.#kernel.process("keeper", manager.service.mainPid, this.#retire);
    requireAcquisition(proc.data.membership === this.#f.keeper && proc.data.starttime === keeper.process.starttime
      && equal(proc.data.procIdentity, keeper.process.procIdentity), "LAB_IDENTITY");
    this.#binding = { invocationId: manager.invocationId, keeperPid: manager.service.mainPid };
    this.#manager = manager;
    await this.#saveCommands("manager.initial", observation.originals);
    await this.#saveProcess("keeper.exterior", proc, this.#retireFiles);
    return true;
  }
  readiness() { return this.#admit(async () => {
    while (true) {
      this.#work();
      const result = await this.#files.readJson("worker.json");
      if (result?.firstFailure) throw new AcquisitionRecordError("LAB_WORKER");
      const ready = await this.#files.readJson("ready.json");
      if (ready) {
        await this.owned(); this.#work();
        requireAcquisition(ready.kind === "lab_ready_v1" && ready.operationId === this.#p.context.operationId
          && ready.profileSha256 === this.#profileHash && ready.entry === "verified", "LAB_IDENTITY");
        const observed = await this.#managerObservation();
        requireAcquisition(observed.value.service.mainPid === this.#binding.keeperPid && observed.value.activeState === "active"
          && observed.value.job[0] === 0, "LAB_IDENTITY");
        for (const role of ["worker", "dockerd", "containerd"]) {
          const reported = ready.processes?.[role];
          requireAcquisition(reported && /^[1-9][0-9]*$/.test(reported.pid), "LAB_IDENTITY");
          const proc = await this.#kernel.process(role, Number(reported.pid));
          requireAcquisition(proc.data.membership === this.#f.infra && proc.data.starttime === reported.starttime
            && equal(proc.data.procIdentity, reported.procIdentity), "LAB_IDENTITY");
          await this.#saveProcess(`${role}.exterior`, proc);
        }
        await this.#saveCommands("manager.ready", observed.originals, this.#files);
        this.#readyRecord = ready; this.#readyHash = acquisitionSha256(JSON.stringify(ready));
        this.#workEntryObserved = true; return;
      }
      requireAcquisition(!this.#waiter.snapshot().closed, "LAB_MANAGER");
      await pause(this.#p.limits.pollMs);
    }
  }); }
  diagnose() { return this.#admit(async () => {
    requireAcquisition(this.#p.diagnostic && this.#diagnosticPlan && this.#readyRecord, "LAB_PROTOCOL");
    await this.#files.json("diagnostic.start.json", { kind: "lab_diagnostic_start_v1", operationId: this.#p.context.operationId,
      profileSha256: this.#profileHash, planSha256: this.#p.diagnostic.sha256, case: this.#p.diagnostic.case,
      readySha256: this.#readyHash, worker: this.#readyRecord.processes.worker });
    while (true) {
      this.#work(); const failed = await this.#files.readJson("worker.json");
      if (failed?.firstFailure) throw new AcquisitionRecordError("LAB_DIAGNOSTIC");
      const result = await this.#files.readJson("diagnostic.result.json");
      if (result) {
        requireAcquisition(result.kind === "lab_diagnostic_result_v1" && result.operationId === this.#p.context.operationId
          && result.profileSha256 === this.#profileHash && result.planSha256 === this.#p.diagnostic.sha256
          && result.case === this.#p.diagnostic.case && result.readySha256 === this.#readyHash
          && equal(result.worker?.procIdentity, this.#readyRecord.processes.worker.procIdentity)
          && result.worker.pid === this.#readyRecord.processes.worker.pid
          && result.worker.starttime === this.#readyRecord.processes.worker.starttime, "LAB_IDENTITY");
        this.#diagnosticResult = result; this.#diagnosticResultHash = acquisitionSha256(JSON.stringify(result));
        requireAcquisition(result.state?.finished && !result.state.firstFailure && !result.state.cleanupError
          && result.state.outcome?.expected === true && result.state.preservationComplete === true, "LAB_DIAGNOSTIC");
        return;
      }
      await pause(this.#p.limits.pollMs);
    }
  }); }
  revoke() {
    this.#revoked = true;
    this.#diagnosticCase?.stop();
    // The waiter belongs to exterior retirement, not the revoked preparation work.
    for (const command of this.#commands) if (!this.#retirementCommands.has(command)) command.stop();
    for (const tx of this.#http) tx.abort();
  }
  halt() { this.#halted = true; this.revoke(); for (const c of this.#commands) c.stop(); }
  effect(target) {
    requireAcquisition(this.#binding, "LAB_IDENTITY");
    return this.#admit(() => this.#kernel.effect(target));
  }
  observe(target) { return this.#admit(async () => {
    while (true) {
      this.#retire(); const result = await this.#kernel.observe(target);
      if (target === "keeper" ? result.value.frozen === true : result.value.populated === false) return result;
      await pause(this.#p.limits.pollMs);
    }
  }); }
  saveBoundary(frozen, empty) { return this.#admit(async () => {
    await this.#retireFiles.write("boundary.keeper.events", frozen.bytes);
    await this.#retireFiles.write("boundary.work.events", empty.bytes);
    await this.#retireFiles.json("boundary.json", { keeper: frozen.value, work: empty.value,
      invocationId: this.#binding.invocationId, order: "keeper_frozen_before_work_empty" });
    this.#boundary = true;
  }); }
  waitRetired() { return this.#admit(async () => {
    const waiter = await collectLabCommand(this.#waiter); this.#retire();
    const observation = await this.#managerObservation(); const m = observation.value;
    await this.#saveCommands("manager.retired", observation.originals);
    await this.#saveWaiter(waiter); this.#manager = m;
    // Boundary samples cannot silently settle an unobserved pre-case worker migration.
    requireAcquisition(this.#workEntryObserved, "LAB_CLEANUP");
    requireAcquisition(m.invocationId === this.#binding.invocationId && m.activeState === "failed" && m.job[0] === 0
      && m.service.mainPid === 0 && m.service.execCode === 2 && m.service.execStatus === 9
      && m.service.result === "signal" && waiter.result.exitCode !== 0, "LAB_MANAGER");
  }); }
  preserve(value) { return this.#admit(async () => {
    requireAcquisition(this.#evidenceReady, "LAB_PRESERVATION");
    const publications = [];
    if (this.#waiterResult) publications.push(() => this.#saveWaiter());
    if (this.#failedCommand) {
      publications.push(async () => this.#saveCommands("command.failure", { first: { result: await this.#failedCommand.result,
        stdout: await this.#failedCommand.collect("stdout"), stderr: await this.#failedCommand.collect("stderr") } }));
    }
    if (this.#failedManager) publications.push(() => this.#saveCommands("manager.failure", this.#failedManager));
    const savings = [this.#saveKnownOriginals(publications)];
    if (value?.ready === false && value.firstFailure && this.#waiterResult?.closed
      && this.#waiterResult.exited && !this.#workEntryObserved) savings.push(this.#startup.observe());
    const outcomes = await Promise.allSettled(savings);
    for (const result of outcomes) if (result.status === "rejected") throw result.reason;
    await this.#verifyCaptures(this.#startup.snapshot().commands);
    requireAcquisition((this.#files.snapshot().unpreservedRecords ?? []).length === 0
      && (this.#retireFiles.snapshot().unpreservedRecords ?? []).length === 0, "LAB_PRESERVATION");
    if (this.#waiter) {
      const ready = await this.#retireFiles.readJson("ready.json");
      const failed = await this.#retireFiles.readJson("worker.json");
      const diagnostic = this.#p.diagnostic ? await this.#retireFiles.readJson("diagnostic.result.json") : null;
      const ending = failed ?? diagnostic ?? ready; const worker = ending?.evidence;
      requireAcquisition(worker && ending.operationId === this.#p.context.operationId
        && ending.profileSha256 === this.#profileHash && (!this.#p.diagnostic || diagnostic || failed), "LAB_PRESERVATION");
      if (ready) requireAcquisition(worker.commands?.daemon, "LAB_PRESERVATION");
      await this.#verifyWorkerEvidence(worker);
      if (diagnostic) {
        requireAcquisition(diagnostic.operationId === this.#p.context.operationId && diagnostic.profileSha256 === this.#profileHash
          && diagnostic.planSha256 === this.#p.diagnostic.sha256 && diagnostic.case === this.#p.diagnostic.case
          && (!this.#diagnosticResultHash || acquisitionSha256(JSON.stringify(diagnostic)) === this.#diagnosticResultHash), "LAB_PRESERVATION");
        await this.#verifyCasePrefixes(diagnostic.state?.prefixes ?? {}, diagnostic.state?.outcome?.expected === true);
      }
      if (failed?.diagnostic) await this.#verifyCasePrefixes(failed.diagnostic.prefixes ?? {});
      const keeper = await this.#retireFiles.readJson("keeper.launch.json");
      requireAcquisition(keeper && keeper.profileSha256 === this.#profileHash, "LAB_PRESERVATION");
      await this.#verifyCaptures({ "worker-launch": keeper.command });
    }
    // Reopen every exterior-owned decision record and compare its original bytes before collection.
    for (const record of Object.values({ ...this.#files.snapshot().records, ...this.#retireFiles.snapshot().records })) {
      const bytes = await this.#retireFiles.read(record.label, Math.max(this.#p.limits.observationBytes, LAB_PROFILE_BYTES));
      requireAcquisition(bytes && bytes.length === record.bytes && acquisitionSha256(bytes) === record.sha256, "LAB_PRESERVATION");
    }
    const record = await this.#retireFiles.json("retirement.json", value);
    const saved = await this.#retireFiles.read("retirement.json");
    requireAcquisition(saved && acquisitionSha256(saved) === record.sha256, "LAB_PRESERVATION"); this.#preserved = true;
  }); }
  collect() { return this.#admit(async () => {
    requireAcquisition(this.#preserved && this.#binding && this.#manager?.activeState === "failed", "LAB_PRESERVATION");
    await this.#completed("systemctl", ["--system", "--no-ask-password", "reset-failed", this.#f.unit], { retire: true });
    this.#collected = true;
  }); }
  close() {
    if (!this.#close) this.#close = (async () => {
      await Promise.allSettled([...this.#pending].map(p => p.promise));
      await this.#diagnosticCase?.close();
      await Promise.allSettled([...this.#commands].map(c => c.result));
      await Promise.allSettled([...this.#http].map(tx => tx.closed));
      await this.#kernel.close(); await this.#handles.closeAll();
      const diagnosticHandles = await this.#diagnosticInputHandles?.closeAll();
      requireAcquisition(!this.#handles.snapshot().retained && !this.#kernel.snapshot().handles.retained && !diagnosticHandles?.retained, "LAB_CLEANUP");
    })(); return this.#close;
  }
  snapshot() { return freezeHostData({ launched: !!this.#waiter, bound: !!this.#binding, boundarySaved: !!this.#boundary,
    launcher: this.#waiter ? { settled: this.#waiterResult !== null, command: this.#waiterResult ?? this.#waiter.snapshot() } : null,
    startupDiagnostics: this.#startup.snapshot(),
    workEntryObserved: this.#workEntryObserved,
    preserved: this.#preserved, registrationCollected: this.#collected, manager: this.#manager,
    pendingOperations: this.#pending.size, activeCommands: this.#commands.size, kernel: this.#kernel.snapshot(),
    files: this.#files.snapshot(), retirementFiles: this.#retireFiles.snapshot(),
    ...(this.#p.diagnostic ? { diagnostic: { case: this.#p.diagnostic.case, resultObserved: !!this.#diagnosticResult,
      expected: this.#diagnosticResult?.state?.outcome?.expected === true, inputHandles: this.#diagnosticInputHandles?.snapshot() ?? null } } : {}) }); }
  #evidence() {
    const work = this.#files.snapshot(); const retire = this.#retireFiles.snapshot();
    return { preservationComplete: !this.#preservationFailed && !this.#diagnosticInputHandles?.snapshot().retained
      && (!this.#diagnosticCase || this.#diagnosticCase.snapshot().preservationComplete)
      && (work.unpreservedRecords ?? []).length === 0
      && (retire.unpreservedRecords ?? []).length === 0,
      records: Object.values({ ...work.records, ...retire.records }),
      commands: Object.fromEntries([...this.#fileCommands].map(([label, command]) => [label, command.snapshot()])) };
  }
  async #verifyCaptures(commands) {
    requireAcquisition(commands && typeof commands === "object" && !Array.isArray(commands), "LAB_PRESERVATION");
    for (const [label, command] of Object.entries(commands)) {
      for (const role of ["stdout", "stderr"]) {
        await this.#retireFiles.verifyPrefix(`${label}.${role}`, command.capture?.files?.[role], command.capture?.channels?.[role]);
      }
    }
  }
  async #verifyCasePrefixes(prefixes, complete = false) {
    const entries = Object.entries(prefixes); requireAcquisition(entries.length <= 9 && (!complete || entries.length === 9), "LAB_PRESERVATION");
    const kind = this.#p.diagnostic.case; const token = this.#diagnosticPlan.operations[kind];
    const parts = ["program.stdout", "program.stderr", "daemon.stdout", "daemon.stderr", "control", "header", "progress", "supervisor", "watchdog"];
    for (const [part, prefix] of entries) {
      requireAcquisition(parts.includes(part)
        && prefix.name === `${this.#p.context.operationId}.case-${kind.toLowerCase()}-${token}.${part}`, "LAB_PRESERVATION");
      const label = prefix.name.slice(this.#p.context.operationId.length + 1);
      await this.#retireFiles.verifyPrefix(label, { capacity: prefix.capacity,
        identity: `${prefix.identity?.dev}:${prefix.identity?.ino}` }, prefix);
    }
  }
  async #verifyWorkerEvidence(evidence) {
    requireAcquisition(evidence.preservationComplete === true && Array.isArray(evidence.records)
      && evidence.records.length > 0, "LAB_PRESERVATION");
    for (const record of evidence.records) {
      const bytes = await this.#retireFiles.read(record.label);
      requireAcquisition(bytes && bytes.length === record.bytes && acquisitionSha256(bytes) === record.sha256, "LAB_PRESERVATION");
    }
    await this.#verifyCaptures(evidence.commands);
    await this.#retireFiles.json("worker.retained.json", { evidence, continuation: "unknown_after_last_observation",
      finalWorkerStatus: "forced_by_owned_unit", completeCapture: false });
  }

  /** Keeper owns hierarchy/bootstrap only, and stays alive until exterior forced retirement. */
  async keeper() {
    const own = await this.#kernel.open();
    requireAcquisition(own.data.membership === this.#f.keeper, "LAB_IDENTITY");
    await this.#files.roots(); this.#evidenceReady = true;
    await this.#kernel.unit(); await this.#kernel.group("keeper"); await this.#kernel.createWork();
    await this.#files.json("keeper.json", { kind: "lab_keeper_v1", operationId: this.#p.context.operationId,
      profileSha256: this.#profileHash, process: own.data, groups: await this.#kernel.identities() });
    this.#work();
    const sink = await createLabFileSink(`${this.#f.prefix}.worker-launch`, this.#p.limits.observationBytes,
      this.#p.context, process.hrtime.bigint, this.#work, this.#handles);
    const worker = startLabCommand({ file: this.#p.tools.node.path, args: [this.#f.keeperEntry, "worker",
      this.#f.profile, this.#profileHash], env: labChildEnvironment(this.#p) }, sink, this.#work);
    this.#commands.add(worker);
    await new Promise(resolve => setImmediate(resolve)); this.#work();
    await this.#files.json("keeper.launch.json", { profileSha256: this.#profileHash, command: worker.snapshot(),
      continuation: "unknown_after_last_observation" });
    // No second launch, retries, or producer after this point. This child never establishes retirement.
    await worker.result;
    await new Promise(() => { setInterval(() => {}, this.#p.limits.pollMs); });
  }

  async #version(name, args, expected, pattern) {
    const r = await this.#completed(name, args, { label: `version.${name}` });
    requireAcquisition(pattern(r.stdout.toString("utf8"), expected), "LAB_TOOL");
  }
  async #socket(path) {
    this.#work(); const s = await this.#fs.lstat(path, { bigint: true }); this.#work();
    requireAcquisition(s.isSocket() && !s.isSymbolicLink() && (s.mode & 0o007n) === 0n, "LAB_IDENTITY");
    return { dev: s.dev.toString(), ino: s.ino.toString() };
  }
  async #httpGet(label, path, socketIdentity) {
    const identity = await this.#socket(this.#f.socket); requireAcquisition(equal(identity, socketIdentity), "LAB_IDENTITY");
    const tx = new AcquisitionHttpTransaction("LAB_PROTOCOL", "LAB_CLEANUP"); this.#http.add(tx);
    const body = Buffer.alloc(this.#p.limits.observationBytes); let count = 0; let response = null; let saved = false;
    try {
      this.#work(); const r = await tx.begin({ socketPath: this.#f.socket, method: "GET", path,
        headers: { Host: "docker", Connection: "close" }, agent: false, maxHeaderSize: 16 * 1024,
        highWaterMark: this.#p.limits.observationBytes }, Buffer.alloc(0), this.#request);
      response = { statusCode: r.response.statusCode, rawHeaders: r.response.rawHeaders, httpVersion: r.response.httpVersion };
      this.#work(); requireAcquisition(!r.upgraded && r.response.statusCode === 200, "LAB_PROTOCOL");
      for await (const bytes of r.stream) {
        this.#work(); requireAcquisition(Buffer.isBuffer(bytes), "LAB_PROTOCOL");
        const allowed = Math.min(bytes.length, body.length - count); bytes.copy(body, count, 0, allowed); count += allowed;
        requireAcquisition(allowed === bytes.length, "LAB_LIMIT");
      }
      this.#work(); requireAcquisition(tx.ended && r.response.complete, "LAB_PROTOCOL");
      const bytes = body.subarray(0, count); await this.#files.write(`${label}.body`, bytes);
      saved = true;
      await this.#files.json(`${label}.response.json`, { ...response, capture: tx.snapshot(), complete: true });
      return json(bytes);
    } catch (error) {
      tx.abort();
      try {
        if (!saved) await this.#retireFiles.write(`${label}.partial.body`, body.subarray(0, count));
        await this.#retireFiles.json(`${label}.partial.response.json`, { response, capturedBytes: count,
          capture: tx.snapshot(), complete: false });
      } catch { this.#preservationFailed = true; }
      throw error;
    } finally { tx.abort(); await tx.closed; if (tx.snapshot().requestClosed && tx.snapshot().streamClosed) this.#http.delete(tx); }
  }
  async #toml(label, bytes) {
    const helper = fileURLToPath(new URL("./provenance-containerd-config.py", import.meta.url));
    const r = await this.#completed("python", ["-I", helper, String(this.#p.limits.observationBytes), this.#p.roots.pythonEnvironment.path],
      { label, stdin: bytes }); return json(r.stdout);
  }
  /** Tools/version/daemon/API work can only start after verified worker self-entry. */
  async worker() {
    await this.#kernel.open(); await this.#kernel.enterWorker();
    await this.#files.roots(); this.#evidenceReady = true;
    if (this.#p.diagnostic) await this.#readDiagnostic(`${this.#f.prefix}.diagnostic.plan.json`);
    for (const name of LAB_TOOLS) await this.#files.verifyTool(name, false);
    for (const [name, args, expected, pattern] of [
      ["node", ["--version"], this.#p.expected.node, (s, v) => s.trim() === v || s.trim() === "v" + v],
      ["python", ["-I", "--version"], this.#p.expected.python, (s, v) => s.trim() === "Python " + v],
      ["dockerd", ["--version"], this.#p.expected.dockerd, (s, v) => s.startsWith(`Docker version ${v},`)],
      ["containerd", ["--version"], this.#p.expected.containerd, (s, v) => s.split(/\s+/).some(part => part === v || part === "v" + v)],
      ["runc", ["--version"], this.#p.expected.runc, (s, v) => s.startsWith(`runc version ${v}\n`)],
      ["systemctl", ["--version"], this.#p.expected.systemd, (s, v) => s.startsWith(`systemd ${v} `)],
    ]) await this.#version(name, args, expected, pattern);
    this.#work(); try { await this.#fs.lstat("/run/containerd/containerd.sock"); throw new AcquisitionRecordError("LAB_IDENTITY"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; } this.#work();
    requireAcquisition((await this.#raw(this.#f.configuration)).equals(Buffer.from(JSON.stringify(labDaemonConfiguration(this.#p)))), "LAB_IDENTITY");
    await this.#completed("dockerd", ["--validate", `--config-file=${this.#f.configuration}`], { label: "daemon.validate" });
    this.#daemon = await this.#command("dockerd", [`--config-file=${this.#f.configuration}`], { label: "daemon" });
    const paths = labContainerdPaths(this.#p);
    while (true) {
      this.#work(); requireAcquisition(!this.#daemon.snapshot().closed, "LAB_WORKER");
      try { await this.#socket(this.#f.socket); await this.#socket(paths.grpc); break; }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      await pause(this.#p.limits.pollMs);
    }
    const socket = await this.#socket(this.#f.socket);
    const version = await this.#httpGet("docker.version", "/v1.56/version", socket);
    const info = await this.#httpGet("docker.info", "/v1.56/info", socket); validateLabDocker(this.#p, version, info);
    const configBytes = await this.#raw(paths.config); await this.#files.write("containerd.generated.toml", configBytes);
    const dumped = await this.#completed("containerd", ["--config", paths.config, "config", "dump"], { label: "containerd.effective" });
    requireAcquisition((await this.#raw(paths.config)).equals(configBytes), "LAB_IDENTITY");
    const generated = await this.#toml("containerd.generated.parse", configBytes);
    const effective = await this.#toml("containerd.effective.parse", dumped.stdout);
    validateLabContainerd(this.#p, generated, effective);
    const pidBytes = await this.#raw(paths.pid, 32);
    requireAcquisition(/^[1-9][0-9]*\n?$/.test(pidBytes.toString("ascii")), "LAB_IDENTITY");
    const processes = {};
    for (const [role, pid] of [["worker", this.#pid], ["dockerd", this.#daemon.snapshot().pid], ["containerd", Number(pidBytes.toString())]]) {
      const observed = await this.#kernel.process(role, pid); processes[role] = observed.data;
      requireAcquisition(observed.data.membership === this.#f.infra, "LAB_IDENTITY");
      if (role === "dockerd") requireAcquisition(observed.data.ppid === String(this.#pid), "LAB_IDENTITY");
      if (role === "containerd") {
        requireAcquisition(observed.data.ppid === String(this.#daemon.snapshot().pid)
          && await this.#fs.realpath(`${this.#p.roots.proc.path}/${pid}/exe`) === this.#p.tools.containerd.realPath, "LAB_IDENTITY");
        const cmdline = await this.#rawProc(pid, "cmdline");
        requireAcquisition(cmdline.equals(Buffer.from(`${this.#p.tools.containerd.path}\0--config\0${paths.config}\0`)), "LAB_IDENTITY");
        await this.#files.write("containerd.cmdline", cmdline);
      }
      await this.#saveProcess(role, observed);
    }
    for (const key of ["grpc", "debug", "ttrpc"]) await this.#socket(paths[key]);
    requireAcquisition(!this.#daemon.snapshot().firstFailure && !this.#daemon.snapshot().cleanupError
      && this.#handles.snapshot().unknown === 0 && this.#kernel.snapshot().handles.unknown === 0, "LAB_WORKER");
    const readyRecord = await this.#files.json("ready.json", { kind: "lab_ready_v1", operationId: this.#p.context.operationId,
      profileSha256: this.#profileHash, entry: this.#kernel.snapshot().entry, processes, socket, evidence: this.#evidence() });
    if (this.#p.diagnostic) {
      while (true) {
        this.#work(); const start = await this.#files.readJson("diagnostic.start.json");
        if (start) {
          requireAcquisition(start.kind === "lab_diagnostic_start_v1" && start.operationId === this.#p.context.operationId
            && start.profileSha256 === this.#profileHash && start.planSha256 === this.#p.diagnostic.sha256
            && start.case === this.#p.diagnostic.case && start.readySha256 === readyRecord.sha256
            && equal(start.worker?.procIdentity, processes.worker.procIdentity)
            && start.worker.pid === processes.worker.pid && start.worker.starttime === processes.worker.starttime, "LAB_IDENTITY");
          this.#checks.beginDiagnostic(); break;
        }
        await pause(this.#p.limits.pollMs);
      }
      this.#diagnosticCase = new LabDiagnosticCase(this.#p, this.#diagnosticPlan, { path: this.#f.socket, identity: socket }, {
        files: this.#files, retirementFiles: this.#retireFiles, handles: this.#handles, kernel: this.#kernel,
        check: this.#work, command: this.#completed.bind(this) });
      await this.#diagnosticCase.run(); await this.#diagnosticCase.close();
      await this.#retireFiles.json("diagnostic.result.json", { kind: "lab_diagnostic_result_v1", operationId: this.#p.context.operationId,
        profileSha256: this.#profileHash, planSha256: this.#p.diagnostic.sha256, case: this.#p.diagnostic.case,
        readySha256: readyRecord.sha256, worker: processes.worker,
        state: this.#diagnosticCase.snapshot(), evidence: this.#evidence() });
    }
    await this.#daemon.result; throw new AcquisitionRecordError("LAB_WORKER");
  }
  async #rawProc(pid, leaf) {
    // Fixed leaf, same trusted proc root; process birth/membership is checked on both sides.
    const before = await this.#kernel.process("containerd", pid);
    const bytes = await this.#raw(`${this.#p.roots.proc.path}/${pid}/${leaf}`);
    const after = await this.#kernel.process("containerd", pid);
    requireAcquisition(before.data.starttime === after.data.starttime, "LAB_IDENTITY"); return bytes;
  }
  async workerFailure(code) {
    this.revoke();
    if (!this.#evidenceReady) return;
    try { await this.#retireFiles.json("worker.json", { kind: "lab_worker_end_v1", firstFailure: code,
      operationId: this.#p.context.operationId, profileSha256: this.#profileHash, evidence: this.#evidence(), state: this.snapshot(),
      ...(this.#diagnosticCase ? { diagnostic: this.#diagnosticCase.snapshot() } : {}) }); } catch { /* Exterior backstop remains required. */ }
  }
}
