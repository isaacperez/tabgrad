import { constants } from "node:fs";
import { open, realpath, statfs } from "node:fs/promises";
import { acquisitionSha256, isAcquisitionUint, AcquisitionRecordError, requireAcquisition }
  from "./provenance-acquisition-record.mjs";
import { copyLabInputPlan, copyLabProfile, LAB_ROOTS, LAB_TOOLS, LAB_PROFILE_BYTES } from "./provenance-acquisition-lab-profile.mjs";
import { LabHandles, labFailureCode } from "./provenance-acquisition-lab-command.mjs";
import { LabClock } from "./provenance-acquisition-lab.mjs";
import { LabFiles } from "./provenance-acquisition-lab-files.mjs";
import { freezeHostData } from "./provenance-acquisition-host-profile.mjs";
import { readAcquisitionProcess } from "./provenance-acquisition-process-observation.mjs";
import { nativeFdPath, nativeIdentity, openNativeRoot, openNativeDirectory, CGROUP2_MAGIC, PROC_MAGIC }
  from "./provenance-acquisition-native-path.mjs";

const native = Object.freeze({ open, realpath, statfs, constants, platform: process.platform, pid: process.pid });
const id = s => ({ dev: s.dev.toString(), ino: s.ino.toString() });

/** Observes a presented prepared view; never creates trust, a directory, a group or a service. */
class LabInputCandidate {
  #plan; #port; #clock; #handles = new LabHandles(); #files = null; #bounds = null; #origin = null;
  #run = null; #work = null; #close = null; #pending = false; #revoked = false; #finished = false;
  #first = null; #cleanup = null; #profile = null; #profileBytes = null; #profileRecord = null;
  #result = null; #timer = null; #resolveStop; #stopped;
  constructor(plan, port, clock) {
    this.#plan = plan; this.#clock = clock;
    requireAcquisition(port && typeof clock === "function" && ["open", "realpath", "statfs"].every(n => typeof port[n] === "function"), "LAB_INPUT");
    this.#port = Object.freeze({ open: port.open.bind(port), realpath: port.realpath.bind(port), statfs: port.statfs.bind(port),
      constants: Object.freeze({ ...port.constants }), platform: port.platform, pid: port.pid });
    this.#stopped = new Promise(resolve => { this.#resolveStop = resolve; });
  }
  #gate = () => {
    requireAcquisition(!this.#revoked, this.#first ?? "LAB_STOPPED"); return this.#bounds.work();
  };
  #fail(error) {
    this.#first ??= labFailureCode(error, "LAB_PROFILE"); this.#revoked = true; this.#bounds?.revoke(); this.#resolveStop();
  }
  stop() { if (!this.#finished) this.#fail(new AcquisitionRecordError("LAB_STOPPED")); return this.snapshot(); }
  async #release(handles) {
    for (const h of handles) if (!this.#handles.has(h)) this.#handles.push(h);
    const results = await Promise.allSettled(handles.map(h => this.#handles.close(h)));
    if (results.some(r => r.status === "rejected")) this.#cleanup ??= "LAB_CLEANUP";
  }
  async #probe() {
    const p = this.#plan; const port = this.#port;
    requireAcquisition(port.platform === "linux" && Number.isSafeInteger(port.pid) && port.pid > 0, "LAB_PLATFORM");
    const roots = {}; const rootHandles = {};
    for (const name of LAB_ROOTS) {
      const requested = p.roots[name]; this.#gate();
      requireAcquisition(await port.realpath(requested.path) === requested.path, "LAB_IDENTITY"); this.#gate();
      const handle = await openNativeRoot(requested, port, this.#handles,
        name === "cgroup" ? CGROUP2_MAGIC : name === "proc" ? PROC_MAGIC : null, this.#gate);
      const s = await handle.stat({ bigint: true }); this.#gate();
      if (!["cgroup", "proc"].includes(name)) requireAcquisition((s.mode &
        (["scratch", "evidence"].includes(name) ? 0o077n : 0o022n)) === 0n, "LAB_IDENTITY");
      roots[name] = { path: requested.path, identity: id(s) }; rootHandles[name] = handle;
    }
    const slice = await openNativeDirectory(`${nativeFdPath(rootHandles.cgroup)}/${p.slice}`, null, port,
      this.#handles, CGROUP2_MAGIC, this.#gate);
    const sliceStat = await slice.stat({ bigint: true }); this.#gate();
    const process = await readAcquisitionProcess(rootHandles.proc, String(port.pid), port,
      { procBytes: p.limits.observationBytes }, this.#gate, handles => this.#release(handles));
    for (const h of process.handles) this.#handles.push(h);
    requireAcquisition(process.data.namespacePids.length === 1, "LAB_IDENTITY");
    const tools = {};
    for (const name of LAB_TOOLS) {
      const expected = p.tools[name]; this.#gate();
      requireAcquisition(await port.realpath(expected.path) === expected.realPath, "LAB_TOOL"); this.#gate();
      const h = await port.open(expected.realPath, port.constants.O_RDONLY | port.constants.O_NOFOLLOW | port.constants.O_NONBLOCK);
      this.#handles.push(h); this.#gate(); const s = await h.stat({ bigint: true }); this.#gate();
      nativeIdentity(s, null, false);
      requireAcquisition(s.nlink === 1n && s.size === BigInt(expected.bytes) && (s.mode & 0o022n) === 0n
        && (s.mode & 0o111n) !== 0n, "LAB_TOOL");
      // The digest stays the independently expected input. The lab owner verifies content before launch.
      tools[name] = { ...expected, identity: id(s) };
    }
    this.#profile = copyLabProfile({ context: { ...p.context, t0MonotonicNs: this.#origin.toString() }, roots,
      slice: { name: p.slice, identity: id(sliceStat) }, tools, expected: p.expected, limits: p.limits,
      namespaces: process.data.namespaces });
    this.#files = new LabFiles(this.#profile, this.#gate, this.#handles);
    // Byte ownership exists before publication; a failed write cannot turn into an admitted candidate.
    this.#profileBytes = Buffer.from(JSON.stringify(this.#profile));
    for (const [name, bytes] of Object.entries(process.originals)) await this.#files.write(`input.proc.${name.toLowerCase()}`, bytes);
    this.#profileRecord = await this.#files.write("input-profile.json", this.#profileBytes, LAB_PROFILE_BYTES);
    this.#result = await this.#files.json("input-report.json", { schemaVersion: 1, operationId: p.context.operationId,
      inputPlanSha256: acquisitionSha256(JSON.stringify(p)), profile: this.#profileRecord,
      observedProcess: process.data, contentVerification: "pending_lab_open",
      presentedViewAdmission: "unqualified", externalClosure: "unqualified", clockAdmission: "unqualified", releaseAdmission: "unqualified" });
    this.#gate();
  }
  #closeHandles() {
    if (!this.#close) this.#close = Promise.resolve().then(async () => {
      await Promise.allSettled(this.#work ? [this.#work] : []); const result = await this.#handles.closeAll();
      if (result.retained) this.#cleanup ??= "LAB_CLEANUP";
    }); return this.#close;
  }
  run() {
    if (this.#run) return this.#run;
    this.#run = (async () => {
      try {
        requireAcquisition(!this.#revoked, this.#first ?? "LAB_STOPPED");
        this.#origin = this.#clock();
        requireAcquisition(typeof this.#origin === "bigint" && isAcquisitionUint(this.#origin.toString()), "LAB_CLOCK");
        this.#bounds = new LabClock({ ...this.#plan, context: { ...this.#plan.context, t0MonotonicNs: this.#origin.toString() } }, this.#clock);
        this.#pending = true;
        this.#work = this.#probe().catch(error => this.#fail(error)).finally(() => { this.#pending = false; });
        this.#timer = setInterval(() => { try { this.#gate(); } catch (error) { this.#fail(error); } }, this.#plan.limits.pollMs);
        let timeout;
        const expired = new Promise(resolve => { timeout = setTimeout(() => {
          this.#fail(new AcquisitionRecordError("LAB_DEADLINE")); resolve();
        }, this.#plan.limits.prepareMs); });
        await Promise.race([this.#work, this.#stopped, expired]); clearTimeout(timeout);
        this.#revoked = true; this.#bounds.revoke();
        let remaining = 0;
        try { remaining = Math.max(0, Number((BigInt(this.#plan.context.deadlineNs) - this.#bounds.retire()) / 1000000n)); }
        catch (error) { this.#fail(error); }
        let cleanupTimer;
        const settled = await Promise.race([this.#closeHandles().then(() => true), new Promise(resolve => {
          cleanupTimer = setTimeout(() => resolve(false), Math.min(this.#plan.limits.retireMs, remaining));
        })]); clearTimeout(cleanupTimer);
        if (!settled) this.#cleanup ??= "LAB_CLEANUP";
      } catch (error) { this.#fail(error); await this.#closeHandles(); }
      clearInterval(this.#timer); this.#finished = true; return this.snapshot();
    })(); return this.#run;
  }
  collect() {
    requireAcquisition(this.snapshot().locallyComplete, "LAB_PROFILE");
    return { profile: JSON.parse(this.#profileBytes.toString("utf8")), profileBytes: Buffer.from(this.#profileBytes),
      profileRecord: this.#profileRecord, result: this.#result };
  }
  close() { this.stop(); return this.#closeHandles().then(() => this.snapshot()); }
  join() { return this.#run ? this.#closeHandles().then(() => this.snapshot()) : Promise.resolve(this.snapshot()); }
  snapshot() {
    return freezeHostData({ operationId: this.#plan.context.operationId, originNs: this.#origin?.toString() ?? null,
      finished: this.#finished, workPending: this.#pending, firstFailure: this.#first, cleanupError: this.#cleanup,
      locallyComplete: this.#finished && !this.#pending && !this.#first && !this.#cleanup && !!this.#result
        && this.#handles.snapshot().retained === 0,
      profileSha256: this.#profileRecord?.sha256 ?? null, files: this.#files?.snapshot() ?? null,
      handles: this.#handles.snapshot(), contentVerification: "pending_lab_open", presentedViewAdmission: "unqualified",
      externalClosure: "unqualified", clockAdmission: "unqualified", releaseAdmission: "unqualified" });
  }
}

/** Inert input materialization. Native authority and external admission never follow from a candidate. */
export function createLabInputCandidate(input, { io = native, clock = process.hrtime.bigint } = {}) {
  return new LabInputCandidate(copyLabInputPlan(input), io, clock);
}
