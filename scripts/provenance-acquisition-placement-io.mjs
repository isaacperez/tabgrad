import { constants } from "node:fs";
import { open, statfs } from "node:fs/promises";
import { AcquisitionRecordError, acquisitionSha256, isAcquisitionUint, requireAcquisition } from "./provenance-acquisition-record.mjs";
import { freezeHostData } from "./provenance-acquisition-host-profile.mjs";
import { nativeFdPath as fdPath, nativeIdentity, nativeKey, openNativeDirectory, openNativeRoot,
  readNativeBytes, readNativeAscii, CGROUP2_MAGIC, PROC_MAGIC } from "./provenance-acquisition-native-path.mjs";
import { parsePlacementPids, parsePlacementStat, parsePlacementStatus, PLACEMENT_ERRORS } from "./provenance-acquisition-placement-profile.mjs";

const nativePort = Object.freeze({ open, statfs, constants, platform: process.platform, pid: process.pid });
const NSFS_MAGIC = 0x6e736673n;
const names = ["pid", "cgroup", "time"];
const check = value => requireAcquisition(value, "PLACEMENT_IDENTITY");
const identity = stat => Object.freeze({ dev: stat.dev.toString(), ino: stat.ino.toString() });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;

export function placementIoCode(error) {
  if (error instanceof AcquisitionRecordError && PLACEMENT_ERRORS.includes(error.code)) return error.code;
  if (error instanceof AcquisitionRecordError && ["HOST_IDENTITY", "HOST_READ", "HOST_FILESYSTEM"].includes(error.code)) {
    return `PLACEMENT_${error.code.slice(5)}`;
  }
  return "PLACEMENT_OPEN";
}

async function closeHandles(handles) {
  const settled = await Promise.allSettled(handles.map(h => h.close()));
  requireAcquisition(settled.every(r => r.status === "fulfilled"), "PLACEMENT_CLOSE");
}

/** Read-only native ownership for an already copied, admitted-view profile. */
class PlacementIO {
  #p; #port; #checkpoint; #handles = []; #subjects = new Map(); #root = null; #proc = null; #case = null; #leaf = null;
  #procs = null; #pending = null; #closing = null; #closed = "open"; #cleanupError = null; #before = false;
  #opened = false; #membership; #seenLeaf = null;

  constructor(profile, port, checkpoint) {
    requireAcquisition(port && typeof port.open === "function" && typeof port.statfs === "function" && port.constants, "PLACEMENT_INPUT");
    this.#p = profile; this.#checkpoint = checkpoint;
    this.#port = Object.freeze({ open: port.open.bind(port), statfs: port.statfs.bind(port),
      platform: port.platform, pid: port.pid, constants: Object.freeze({ O_RDONLY: port.constants.O_RDONLY,
        O_DIRECTORY: port.constants.O_DIRECTORY, O_NOFOLLOW: port.constants.O_NOFOLLOW }) });
    this.#membership = "/" + [...profile.hierarchy.case.map(p => p.name), profile.containerId].join("/");
  }

  #work(effect) {
    requireAcquisition(!this.#closing, "PLACEMENT_STOPPED");
    requireAcquisition(!this.#pending, "PLACEMENT_BUSY");
    // Publish pending before a syscall port can reenter close().
    const work = Promise.resolve().then(effect);
    this.#pending = work;
    void work.finally(() => { if (this.#pending === work) this.#pending = null; }).catch(() => {});
    return work;
  }

  async #checked(effect) {
    this.#checkpoint();
    const result = await effect();
    this.#checkpoint();
    return result;
  }

  async #file(parent, name, handles, filesystem) {
    this.#checkpoint();
    const h = await this.#port.open(`${fdPath(parent)}/${name}`, this.#port.constants.O_RDONLY | this.#port.constants.O_NOFOLLOW);
    handles.push(h); this.#checkpoint();
    const stat = await this.#checked(() => h.stat({ bigint: true })); nativeIdentity(stat, null, false);
    check(stat.dev === (await this.#checked(() => parent.stat({ bigint: true }))).dev);
    if (filesystem !== null) check((await this.#checked(() => this.#port.statfs(fdPath(h), { bigint: true }))).type === filesystem);
    return h;
  }

  async #namespaces(proc, handles) {
    const result = {};
    for (const name of names) {
      this.#checkpoint();
      // Deliberately follow only these fixed kernel namespace magic links.
      const h = await this.#port.open(`${fdPath(proc)}/ns/${name}`, this.#port.constants.O_RDONLY);
      handles.push(h); this.#checkpoint();
      const stat = await this.#checked(() => h.stat({ bigint: true })); nativeIdentity(stat, null, false);
      check((await this.#checked(() => this.#port.statfs(fdPath(h), { bigint: true }))).type === NSFS_MAGIC);
      result[name] = identity(stat);
    }
    return Object.freeze(result);
  }

  open() {
    return this.#work(async () => {
      requireAcquisition(!this.#opened, "PLACEMENT_PROTOCOL");
      const p = this.#port; const c = p.constants;
      requireAcquisition(p.platform === "linux" && Number.isSafeInteger(p.pid) && p.pid > 0
        && [c.O_RDONLY, c.O_DIRECTORY, c.O_NOFOLLOW].every(Number.isInteger), "PLACEMENT_PLATFORM");
      this.#root = await openNativeRoot(this.#p.hierarchy.root, p, this.#handles, CGROUP2_MAGIC, this.#checkpoint);
      this.#case = this.#root;
      for (const part of this.#p.hierarchy.case) this.#case = await openNativeDirectory(
        `${fdPath(this.#case)}/${part.name}`, part.identity, p, this.#handles, CGROUP2_MAGIC, this.#checkpoint);
      const type = await this.#file(this.#case, "cgroup.type", this.#handles, CGROUP2_MAGIC);
      check(await readNativeAscii(type, 32, this.#checkpoint) === "domain\n");
      this.#proc = await openNativeRoot(this.#p.proc, p, this.#handles, PROC_MAGIC, this.#checkpoint);
      const own = await this.#readProcess(String(p.pid));
      try {
        check(own.data.pid === String(p.pid) && own.data.namespacePids.length === 1
          && names.every(name => same(own.data.namespaces[name], this.#p.namespaces[name])));
      } finally { await this.#release(own.handles); }
      this.#opened = true;
      return this.snapshot();
    });
  }

  beforeStart() {
    return this.#work(async () => {
      requireAcquisition(this.#opened && !this.#before && !this.#leaf, "PLACEMENT_PROTOCOL");
      this.#checkpoint();
      let existing;
      try { existing = await this.#port.open(`${fdPath(this.#case)}/${this.#p.containerId}`,
        this.#port.constants.O_RDONLY | this.#port.constants.O_DIRECTORY | this.#port.constants.O_NOFOLLOW); }
      catch (error) { if (error?.code !== "ENOENT") throw error; this.#checkpoint(); this.#before = true; return this.snapshot(); }
      this.#handles.push(existing); this.#checkpoint();
      throw new AcquisitionRecordError("PLACEMENT_IDENTITY");
    });
  }

  afterStart() {
    return this.#work(async () => {
      requireAcquisition(this.#before && !this.#leaf, "PLACEMENT_PROTOCOL");
      this.#leaf = await openNativeDirectory(`${fdPath(this.#case)}/${this.#p.containerId}`, null,
        this.#port, this.#handles, CGROUP2_MAGIC, this.#checkpoint);
      const stat = await this.#checked(() => this.#leaf.stat({ bigint: true })); this.#seenLeaf = identity(stat);
      check(stat.dev === (await this.#checked(() => this.#case.stat({ bigint: true }))).dev);
      const type = await this.#file(this.#leaf, "cgroup.type", this.#handles, CGROUP2_MAGIC);
      check(await readNativeAscii(type, 32) === "domain\n");
      this.#procs = await this.#file(this.#leaf, "cgroup.procs", this.#handles, CGROUP2_MAGIC);
      const pids = await this.#pids(); check(pids.length === 1);
      const init = await this.#readProcess(pids[0]);
      try {
        this.#checkSubject(init.data, "1", null);
        check(!same(init.data.namespaces.pid, this.#p.namespaces.pid));
      } catch (error) { await this.#releaseFailed(init.handles); throw error; }
      this.#subjects.set("init", init);
      return this.snapshot();
    });
  }

  async #pids() {
    // Reopening the fixed name detects replacement; reads remain on the retained leaf.
    const fresh = [];
    try {
      const h = await openNativeDirectory(`${fdPath(this.#case)}/${this.#p.containerId}`, this.#seenLeaf,
        this.#port, fresh, CGROUP2_MAGIC, this.#checkpoint);
      check(nativeKey(await this.#checked(() => h.stat({ bigint: true })))
        === nativeKey(await this.#checked(() => this.#leaf.stat({ bigint: true }))));
    } finally { await this.#release(fresh); }
    return parsePlacementPids(await readNativeBytes(this.#procs, this.#p.limits.procsBytes, this.#checkpoint), this.#p.limits.maxProcesses);
  }

  async #readProcess(pid) {
    const handles = [];
    try {
      const dir = await openNativeDirectory(`${fdPath(this.#proc)}/${pid}`, null, this.#port, handles, PROC_MAGIC, this.#checkpoint);
      const stat = await this.#file(dir, "stat", handles, PROC_MAGIC);
      const status = await this.#file(dir, "status", handles, PROC_MAGIC);
      const cgroup = await this.#file(dir, "cgroup", handles, PROC_MAGIC);
      const beforeBytes = await readNativeBytes(stat, this.#p.limits.procBytes, this.#checkpoint);
      const before = parsePlacementStat(beforeBytes);
      const statusBytes = await readNativeBytes(status, this.#p.limits.procBytes, this.#checkpoint);
      const decoded = parsePlacementStatus(statusBytes);
      const cgroupBytes = await readNativeBytes(cgroup, this.#p.limits.procBytes, this.#checkpoint);
      const namespaces = await this.#namespaces(dir, handles);
      const afterBytes = await readNativeBytes(stat, this.#p.limits.procBytes, this.#checkpoint);
      const after = parsePlacementStat(afterBytes);
      check(before.pid === pid && decoded.pid === pid && before.pid === after.pid
        && before.ppid === after.ppid && before.starttime === after.starttime
        && !["Z", "X", "x"].includes(after.state));
      const membership = cgroupBytes.toString("latin1");
      check(cgroupBytes.every(b => b === 10 || b >= 32 && b <= 126) && /^0::\/[^\n]*\n$/.test(membership));
      const originals = { statBefore: beforeBytes, status: statusBytes, cgroup: cgroupBytes, statAfter: afterBytes };
      return { handles, dir, originals, data: freezeHostData({ ...after, ...decoded, namespaces,
        procIdentity: identity(await this.#checked(() => dir.stat({ bigint: true }))), membership: membership.slice(3, -1),
        sources: Object.fromEntries(Object.entries(originals).map(([k, v]) => [k, { bytes: v.length, sha256: acquisitionSha256(v) }])) }) };
    } catch (error) { await this.#releaseFailed(handles); throw error; }
  }

  #checkSubject(data, internalPid, parent) {
    const init = this.#subjects.get("init")?.data;
    check(data.namespacePids.length === 2 && data.namespacePids[1] === internalPid && data.membership === this.#membership
      && same(data.namespaces.time, this.#p.namespaces.time));
    if (init) check(same(data.namespaces.pid, init.namespaces.pid) && same(data.namespaces.cgroup, init.namespaces.cgroup));
    if (parent !== null) check(data.ppid === parent);
  }

  observe(role, internalPid) {
    return this.#work(async () => {
      requireAcquisition(["launcher", "program"].includes(role) && !this.#subjects.has(role)
        && this.#subjects.has(role === "program" ? "launcher" : "init")
        && isAcquisitionUint(internalPid) && internalPid !== "0", "PLACEMENT_PROTOCOL");
      const pids = await this.#pids(); let selected = null;
      try {
        for (const pid of pids) {
          const subject = await this.#readProcess(pid);
          const matches = subject.data.namespacePids.at(-1) === internalPid;
          if (!matches) { await this.#release(subject.handles); continue; }
          if (selected) { await this.#release(subject.handles); throw new AcquisitionRecordError("PLACEMENT_IDENTITY"); }
          selected = subject;
          this.#checkSubject(subject.data, internalPid, role === "program" ? this.#subjects.get("launcher").data.pid : null);
        }
        check(selected !== null);
        this.#subjects.set(role, selected);
        return this.snapshot();
      } catch (error) { if (selected) await this.#releaseFailed(selected.handles); throw error; }
    });
  }

  async #release(handles) {
    try { await closeHandles(handles); }
    catch (error) { this.#cleanupError ??= "PLACEMENT_CLOSE"; throw error; }
  }

  async #releaseFailed(handles) {
    // Preserve the observation's first error, with failed close reported separately.
    try { await this.#release(handles); } catch { /* #release retained cleanupError. */ }
  }

  close() {
    if (!this.#closing) {
      this.#closed = "pending";
      this.#closing = Promise.resolve().then(async () => {
        await Promise.allSettled(this.#pending ? [this.#pending] : []);
        const handles = [...this.#handles, ...[...this.#subjects.values()].flatMap(s => s.handles)];
        try { await this.#release(handles); this.#closed = this.#cleanupError ? "unknown" : "closed"; }
        catch { this.#closed = "unknown"; }
        return this.snapshot();
      });
    }
    return this.#closing;
  }

  collect() {
    return Object.freeze(Object.fromEntries([...this.#subjects].map(([role, subject]) => [role,
      Object.freeze(Object.fromEntries(Object.entries(subject.originals).map(([k, v]) => [k, Buffer.from(v)])))])));
  }

  snapshot() {
    return freezeHostData({ opened: this.#opened, beforeChecked: this.#before, leafIdentity: this.#seenLeaf,
      subjects: Object.fromEntries([...this.#subjects].map(([k, s]) => [k, s.data])),
      ioPending: this.#pending !== null, ioClosed: this.#closed, cleanupError: this.#cleanupError });
  }
}

/** Profile is the placement owner's private validated copy, never an operational plugin. */
export function createPlacementIO(profile, checkpoint, port = nativePort) {
  requireAcquisition(typeof checkpoint === "function", "PLACEMENT_INPUT");
  return new PlacementIO(profile, port, checkpoint);
}
