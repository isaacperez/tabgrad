import { constants } from "node:fs";
import { mkdir, open, statfs } from "node:fs/promises";
import { requireAcquisition } from "./provenance-acquisition-record.mjs";
import { freezeHostData } from "./provenance-acquisition-host-profile.mjs";
import { parseHostEvents } from "./provenance-acquisition-host-io.mjs";
import { parsePlacementPids } from "./provenance-acquisition-placement-profile.mjs";
import { readAcquisitionProcess } from "./provenance-acquisition-process-observation.mjs";
import { nativeFdPath, nativeIdentity, nativeKey, openNativeDirectory, openNativeFile, openNativeRoot,
  readNativeAscii, readNativeBytes, CGROUP2_MAGIC, PROC_MAGIC } from "./provenance-acquisition-native-path.mjs";
import { LAB_GROUPS, labPaths } from "./provenance-acquisition-lab-profile.mjs";
import { LabHandles, labFailureCode } from "./provenance-acquisition-lab-command.mjs";

const nativeKernel = Object.freeze({ open, mkdir, statfs, constants, platform: process.platform, pid: process.pid });
const identity = s => Object.freeze({ dev: s.dev.toString(), ino: s.ino.toString() });
const equal = (a, b) => a.dev === b.dev && a.ino === b.ino;

/** Read/process and three explicit control targets, separate from manager ownership and trust. */
export class LabKernel {
  #p; #f; #port; #work; #retire; #handles = new LabHandles(); #groups = new Map(); #files = new Map();
  #root = null; #proc = null; #slice = null; #processes = new Map(); #effects = new Map(); #entry = "not_requested"; #closing = null;
  constructor(p, checks, port = nativeKernel) {
    this.#p = p; this.#f = labPaths(p);
    const work = checks.work.bind(checks); const retire = checks.retire.bind(checks);
    this.#work = () => { requireAcquisition(!this.#closing, "LAB_STOPPED"); return work(); };
    this.#retire = () => { requireAcquisition(!this.#closing, "LAB_STOPPED"); return retire(); };
    this.#port = Object.freeze({ open: port.open.bind(port), mkdir: port.mkdir.bind(port), statfs: port.statfs.bind(port),
      platform: port.platform, pid: port.pid, constants: Object.freeze({ ...port.constants }) });
  }
  async open(check = this.#work) {
    requireAcquisition(this.#port.platform === "linux" && Number.isSafeInteger(this.#port.pid) && this.#port.pid > 0, "LAB_PLATFORM");
    if (!this.#root) this.#root = await openNativeRoot(this.#p.roots.cgroup, this.#port, this.#handles, CGROUP2_MAGIC, check);
    if (!this.#proc) this.#proc = await openNativeRoot(this.#p.roots.proc, this.#port, this.#handles, PROC_MAGIC, check);
    if (!this.#slice) this.#slice = await openNativeDirectory(`${nativeFdPath(this.#root)}/${this.#p.slice.name}`,
      this.#p.slice.identity, this.#port, this.#handles, CGROUP2_MAGIC, check);
    const own = await this.process("observer", this.#port.pid, check);
    requireAcquisition(Object.entries(this.#p.namespaces).every(([name, expected]) => equal(own.data.namespaces[name], expected))
      && own.data.namespacePids.length === 1, "LAB_IDENTITY");
    return own;
  }
  async unit(check = this.#work) {
    requireAcquisition(this.#slice, "LAB_PROTOCOL");
    if (!this.#groups.has("unit")) {
      const h = await openNativeDirectory(`${nativeFdPath(this.#slice)}/${this.#f.unit}`, null,
        this.#port, this.#handles, CGROUP2_MAGIC, check);
      const type = await openNativeFile(h, "cgroup.type", this.#port, this.#handles, CGROUP2_MAGIC, check);
      requireAcquisition(await readNativeAscii(type, 32, check) === "domain\n", "LAB_IDENTITY");
      this.#groups.set("unit", h);
    }
    return this.#groups.get("unit");
  }
  async group(name, check = this.#work) {
    requireAcquisition(["unit", "keeper", "work", ...LAB_GROUPS].includes(name), "LAB_PROTOCOL");
    if (this.#groups.has(name)) return this.#groups.get(name);
    const parent = name === "unit" ? null : await (LAB_GROUPS.includes(name) ? this.group("work", check) : this.unit(check));
    if (name === "unit") return this.unit(check);
    const h = await openNativeDirectory(`${nativeFdPath(parent)}/${name}`, null, this.#port, this.#handles, CGROUP2_MAGIC, check);
    const type = await openNativeFile(h, "cgroup.type", this.#port, this.#handles, CGROUP2_MAGIC, check);
    requireAcquisition(await readNativeAscii(type, 32, check) === "domain\n", "LAB_IDENTITY");
    const key = nativeKey(await h.stat({ bigint: true })); check();
    for (const old of this.#groups.values()) {
      check(); const s = await old.stat({ bigint: true }); check();
      requireAcquisition(key !== nativeKey(s), "LAB_IDENTITY");
    }
    this.#groups.set(name, h); return h;
  }
  async createWork() {
    const unit = await this.unit();
    for (const name of ["work", ...LAB_GROUPS]) {
      const parent = name === "work" ? unit : await this.group("work");
      this.#work(); await this.#port.mkdir(`${nativeFdPath(parent)}/${name}`, { mode: 0o700 }); this.#work();
      await this.group(name);
    }
  }
  async #file(group, name, write, check) {
    const key = `${group}/${name}/${write ? "write" : "read"}`;
    if (this.#files.has(key)) return this.#files.get(key);
    const parent = await this.group(group, check); let h;
    if (!write) h = await openNativeFile(parent, name, this.#port, this.#handles, CGROUP2_MAGIC, check);
    else {
      check(); h = await this.#port.open(`${nativeFdPath(parent)}/${name}`, this.#port.constants.O_WRONLY | this.#port.constants.O_NOFOLLOW);
      this.#handles.push(h); check();
      const s = await h.stat({ bigint: true }); check(); nativeIdentity(s, null, false);
      const parentStat = await parent.stat({ bigint: true }); check();
      requireAcquisition(s.dev === parentStat.dev, "LAB_IDENTITY");
    }
    this.#files.set(key, h); return h;
  }
  async enterWorker() {
    const reader = await this.#file("infra", "cgroup.procs", false, this.#work);
    const writer = await this.#file("infra", "cgroup.procs", true, this.#work);
    const before = await reader.stat({ bigint: true }); this.#work();
    const after = await writer.stat({ bigint: true }); this.#work();
    requireAcquisition(nativeKey(before) === nativeKey(after), "LAB_IDENTITY");
    this.#entry = "pending";
    try {
      const r = await writer.write(Buffer.from("0"), 0, 1, 0);
      requireAcquisition(r.bytesWritten === 1, "LAB_WRITE"); this.#entry = "acknowledged"; this.#work();
    } catch (error) { if (this.#entry === "pending") this.#entry = "unknown"; throw error; }
    const pids = parsePlacementPids(await readNativeBytes(reader, this.#p.limits.observationBytes, this.#work), this.#p.limits.tasks);
    requireAcquisition(pids.includes(String(this.#port.pid)), "LAB_IDENTITY");
    const own = await this.process("worker", this.#port.pid);
    requireAcquisition(own.data.membership === this.#f.infra, "LAB_IDENTITY"); this.#entry = "verified";
    return own;
  }
  async process(role, pid, check = this.#work) {
    requireAcquisition(["observer", "keeper", "worker", "dockerd", "containerd"].includes(role)
      && Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff, "LAB_IDENTITY");
    const record = await readAcquisitionProcess(this.#proc, String(pid), this.#port,
      { procBytes: this.#p.limits.observationBytes }, check, handles => this.#release(handles));
    for (const h of record.handles) this.#handles.push(h);
    const previous = this.#processes.get(role);
    try {
      requireAcquisition(record.data.namespacePids.length === 1 && record.data.pid === String(pid)
        && Object.entries(this.#p.namespaces).every(([name, expected]) => equal(record.data.namespaces[name], expected))
        && (!previous || previous.data.starttime === record.data.starttime && previous.data.pid === record.data.pid
          && equal(previous.data.procIdentity, record.data.procIdentity)), "LAB_IDENTITY");
    } catch (error) { await this.#release(record.handles); throw error; }
    if (previous) await this.#release(previous.handles);
    this.#processes.set(role, record); return record;
  }
  async #release(handles) {
    for (const h of handles) {
      if (!this.#handles.has(h)) this.#handles.push(h);
    }
    await Promise.allSettled(handles.map(h => this.#handles.close(h)));
  }
  effect(target) {
    requireAcquisition(["keeper.freeze", "work.kill", "unit.kill"].includes(target), "LAB_PROTOCOL");
    if (!this.#effects.has(target)) {
      requireAcquisition(!this.#closing, "LAB_STOPPED");
      const record = { state: "pending", error: null, promise: null }; this.#effects.set(target, record);
      record.promise = Promise.resolve().then(async () => {
        try {
          const [group, kind] = target.split(".");
          const h = await this.#file(group, `cgroup.${kind}`, true, this.#retire); this.#retire();
          const r = await h.write(Buffer.from("1"), 0, 1, 0);
          requireAcquisition(r.bytesWritten === 1, "LAB_WRITE"); record.state = "acknowledged"; this.#retire();
        } catch (error) { if (record.state === "pending") record.state = "unknown"; record.error = labFailureCode(error, "LAB_WRITE"); throw error; }
        return this.snapshot();
      });
    }
    return this.#effects.get(target).promise;
  }
  async observe(target) {
    requireAcquisition(["keeper", "work"].includes(target), "LAB_PROTOCOL");
    const h = await this.#file(target, "cgroup.events", false, this.#retire);
    const bytes = await readNativeBytes(h, 128, this.#retire);
    return { value: parseHostEvents(bytes.toString("ascii")), bytes };
  }
  async identities(check = this.#work) {
    const result = {};
    for (const [name, handle] of this.#groups) { check(); const s = await handle.stat({ bigint: true }); check(); result[name] = identity(s); }
    return freezeHostData(result);
  }
  snapshot() {
    return freezeHostData({ opened: !!this.#root, unitOpened: this.#groups.has("unit"), entry: this.#entry,
      effects: Object.fromEntries([...this.#effects].map(([k, v]) => [k, { state: v.state, error: v.error }])),
      processes: Object.fromEntries([...this.#processes].map(([k, v]) => [k, v.data])), handles: this.#handles.snapshot() });
  }
  close() {
    if (!this.#closing) this.#closing = Promise.resolve().then(async () => {
      await Promise.allSettled([...this.#effects.values()].map(v => v.promise));
      await this.#handles.closeAll(); return this.snapshot();
    });
    return this.#closing;
  }
}
