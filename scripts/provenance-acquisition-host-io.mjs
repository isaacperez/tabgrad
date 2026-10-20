import { constants } from "node:fs";
import { open, statfs } from "node:fs/promises";
import { AcquisitionRecordError, requireAcquisition, isAcquisitionUint } from "./provenance-acquisition-record.mjs";
import { HOST_GROUPS, HOST_ROLES, HOST_READ_LIMITS, copyHostProfile, freezeHostData } from "./provenance-acquisition-host-profile.mjs";

const cgroup2Magic = 0x63677270n;
const nativePort = Object.freeze({ open, statfs, constants, platform: process.platform, pid: process.pid });
const key = stat => `${stat.dev}:${stat.ino}`;
function fdPath(handle) {
  requireAcquisition(Number.isSafeInteger(handle.fd) && handle.fd >= 0, "HOST_IDENTITY");
  return `/proc/self/fd/${handle.fd}`;
}

function nativeIdentity(stat, expected, directory) {
  requireAcquisition(typeof stat.dev === "bigint" && typeof stat.ino === "bigint" && stat.ino > 0n
    && typeof stat.nlink === "bigint" && stat.nlink > 0n && (directory ? stat.isDirectory() : stat.isFile()), "HOST_IDENTITY");
  if (expected) requireAcquisition(key(stat) === `${expected.dev}:${expected.ino}`, "HOST_IDENTITY");
  return key(stat);
}

async function readBounded(handle, limit) {
  const bytes = Buffer.alloc(limit + 1);
  let count = 0;
  while (count < bytes.length) {
    const r = await handle.read(bytes, count, bytes.length - count, count);
    requireAcquisition(Number.isInteger(r.bytesRead) && r.bytesRead >= 0 && r.bytesRead <= bytes.length - count, "HOST_READ");
    if (r.bytesRead === 0) break;
    count += r.bytesRead;
  }
  requireAcquisition(count <= limit && bytes.subarray(0, count).every(b => b === 10 || b >= 32 && b <= 126), "HOST_READ");
  return bytes.subarray(0, count).toString("ascii");
}

export function parseHostEvents(text) {
  requireAcquisition(typeof text === "string" && Buffer.byteLength(text) <= HOST_READ_LIMITS.events, "HOST_READ");
  const lines = text.split("\n");
  requireAcquisition(lines.length === 3 && lines[2] === "", "HOST_READ");
  const result = {};
  for (const line of lines.slice(0, 2)) {
    const match = /^(populated|frozen) ([01])$/.exec(line);
    requireAcquisition(match && !Object.hasOwn(result, match[1]), "HOST_READ");
    result[match[1]] = match[2] === "1";
  }
  requireAcquisition(Object.hasOwn(result, "populated") && Object.hasOwn(result, "frozen"), "HOST_READ");
  return Object.freeze(result);
}

async function ownMembership(handle, pid) {
  const text = await readBounded(handle, HOST_READ_LIMITS.procs);
  requireAcquisition(text.endsWith("\n"), "HOST_MEMBER");
  const lines = text.slice(0, -1).split("\n");
  requireAcquisition(lines.every(s => isAcquisitionUint(s) && s !== "0") && lines.includes(String(pid)), "HOST_MEMBER");
}

/** Owns retained native handles; no command, creation, configuration or implicit retry. */
class HostIO {
  #entry;
  #handles; #files; #pending = new Set(); #reading = null; #closing = null;
  #effects = { freeze: { state: "not_requested", error: null }, kill: { state: "not_requested", error: null } };
  #promises = {}; #closed = "open";

  constructor(handles, files, entry) { this.#handles = handles; this.#files = files; this.#entry = entry; }

  #track(work) {
    this.#pending.add(work);
    void work.finally(() => this.#pending.delete(work)).catch(() => {});
    return work;
  }

  #effect(kind) {
    if (this.#promises[kind]) return this.#promises[kind];
    requireAcquisition(!this.#closing, "HOST_STOPPED");
    this.#effects[kind] = { state: "pending", error: null };
    const work = this.#write(kind);
    this.#promises[kind] = this.#track(work);
    return work;
  }

  async #write(kind) {
    try {
      const r = await this.#files[kind].write(Buffer.from("1"), 0, 1, 0);
      requireAcquisition(r.bytesWritten === 1, "HOST_WRITE");
      this.#effects[kind] = { state: "acknowledged", error: null };
    } catch {
      this.#effects[kind] = { state: "unknown", error: "HOST_WRITE" };
      throw new AcquisitionRecordError("HOST_WRITE");
    }
  }

  freeze() { return this.#effect("freeze"); }
  kill() { return this.#effect("kill"); }

  observe() {
    requireAcquisition(!this.#closing, "HOST_STOPPED");
    requireAcquisition(!this.#reading, "HOST_BUSY");
    this.#reading = this.#track(readBounded(this.#files.events, HOST_READ_LIMITS.events)
      .then(parseHostEvents).catch(() => { throw new AcquisitionRecordError("HOST_READ"); })
      .finally(() => { this.#reading = null; }));
    return this.#reading;
  }

  close() {
    if (!this.#closing) {
      this.#closed = "pending";
      this.#closing = this.#close();
    }
    return this.#closing;
  }

  async #close() {
    await Promise.allSettled([...this.#pending]);
    const settled = await Promise.allSettled(this.#handles.map(handle => handle.close()));
    this.#closed = settled.every(r => r.status === "fulfilled") ? "closed" : "unknown";
    return this.snapshot();
  }

  snapshot() {
    return freezeHostData({ freeze: { ...this.#effects.freeze }, kill: { ...this.#effects.kill },
      ioClosed: this.#closed, ioPending: this.#pending.size, ...(this.#entry ? { entry: { ...this.#entry } } : {}) });
  }
}

/** Trusted narrow syscall port for synthetic tests, never a user/plugin boundary. */
export async function openAcquisitionHost(profile, role, port = nativePort) {
  return openPreparedHost(profile, role, port, null);
}

/** Explicit trusted bootstrap entry, once before any case: never migrates a foreign PID. */
export async function enterAcquisitionHost(profile, role, {
  port = nativePort, clock = () => process.hrtime.bigint(),
} = {}) {
  requireAcquisition(typeof clock === "function", "HOST_INPUT");
  return openPreparedHost(profile, role, port, clock);
}

function checkEntryClock(profile, clock, previous = null) {
  let now;
  try { now = clock(); } catch { throw new AcquisitionRecordError("HOST_CLOCK"); }
  requireAcquisition(typeof now === "bigint" && now >= BigInt(profile.t0MonotonicNs)
    && (previous === null || now >= previous), "HOST_CLOCK");
  requireAcquisition(now - BigInt(profile.t0MonotonicNs) < BigInt(profile.stopAtNs), "HOST_DEADLINE");
  return now;
}

async function openPreparedHost(profile, role, port, entryClock) {
  const p = copyHostProfile(profile);
  requireAcquisition(HOST_ROLES.includes(role), "HOST_INPUT");
  requireAcquisition(port.platform === "linux", "HOST_PLATFORM");
  const c = port.constants;
  requireAcquisition([c.O_RDONLY, c.O_WRONLY, c.O_DIRECTORY, c.O_NOFOLLOW].every(Number.isInteger)
    && Number.isSafeInteger(port.pid) && port.pid > 0, "HOST_PLATFORM");
  const handles = [];
  const entry = entryClock ? { state: "not_requested", error: null } : null;
  let enteredAt = null;
  try {
    const root = await openRoot(p.root, port, handles);
    const groups = await openGroups(p, root, port, handles);
    const files = {};
    const nativeFiles = new Set();
    for (const [name, access] of [["cgroup.freeze", c.O_WRONLY], ["cgroup.kill", c.O_WRONLY], ["cgroup.events", c.O_RDONLY]]) {
      const handle = await port.open(`${fdPath(groups.case)}/${name}`, access | c.O_NOFOLLOW);
      handles.push(handle);
      const stat = await handle.stat({ bigint: true });
      const identity = nativeIdentity(stat, null, false);
      requireAcquisition(!nativeFiles.has(identity), "HOST_IDENTITY"); nativeFiles.add(identity);
      requireAcquisition(stat.dev.toString() === p.groups.case.at(-1).identity.dev, "HOST_IDENTITY");
      files[name.split(".")[1]] = handle;
    }
    const member = await port.open(`${fdPath(groups[role])}/cgroup.procs`, c.O_RDONLY | c.O_NOFOLLOW);
    handles.push(member);
    const stat = await member.stat({ bigint: true });
    const memberIdentity = nativeIdentity(stat, null, false);
    requireAcquisition(stat.dev.toString() === p.groups[role].at(-1).identity.dev, "HOST_IDENTITY");
    if (entry) {
      const writer = await port.open(`${fdPath(groups[role])}/cgroup.procs`, c.O_WRONLY | c.O_NOFOLLOW);
      handles.push(writer);
      requireAcquisition(nativeIdentity(await writer.stat({ bigint: true }), null, false) === memberIdentity, "HOST_IDENTITY");
      enteredAt = checkEntryClock(p, entryClock);
      entry.state = "pending";
      try {
        const result = await writer.write(Buffer.from("0"), 0, 1, 0);
        requireAcquisition(result.bytesWritten === 1, "HOST_ENTRY");
        entry.state = "acknowledged";
      } catch {
        entry.state = "unknown"; entry.error = "HOST_ENTRY";
        throw new AcquisitionRecordError("HOST_ENTRY");
      }
    }
    await ownMembership(member, port.pid);
    if (entry) { entry.state = "verified"; checkEntryClock(p, entryClock, enteredAt); }
    return new HostIO(handles, files, entry);
  } catch (error) {
    const closed = await Promise.allSettled(handles.map(handle => handle.close()));
    const failure = new AcquisitionRecordError(error instanceof AcquisitionRecordError ? error.code : "HOST_OPEN");
    failure.closeError = closed.some(r => r.status === "rejected") ? "HOST_CLOSE" : null;
    if (entry) failure.entry = Object.freeze({ ...entry });
    throw failure;
  }
}

async function openDirectory(path, expected, port, handles, cgroup) {
  const c = port.constants;
  const handle = await port.open(path, c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW);
  handles.push(handle);
  nativeIdentity(await handle.stat({ bigint: true }), expected, true);
  if (cgroup) requireAcquisition((await port.statfs(fdPath(handle), { bigint: true })).type === cgroup2Magic, "HOST_FILESYSTEM");
  return handle;
}

async function openRoot(root, port, handles) {
  let handle = await openDirectory("/", null, port, handles, false);
  const parts = root.path.split("/").slice(1);
  for (let i = 0; i < parts.length; i += 1) handle = await openDirectory(`${fdPath(handle)}/${parts[i]}`,
    i === parts.length - 1 ? root.identity : null, port, handles, i === parts.length - 1);
  return handle;
}

async function openGroups(profile, root, port, handles) {
  const cache = new Map([["", root]]);
  const groups = {};
  const leafIds = new Set([key(await root.stat({ bigint: true }))]);
  for (const role of HOST_GROUPS) {
    let path = "";
    let parent = root;
    for (const part of profile.groups[role]) {
      path += "/" + part.name;
      let handle = cache.get(path);
      if (!handle) {
        handle = await openDirectory(`${fdPath(parent)}/${part.name}`, part.identity, port, handles, true);
        cache.set(path, handle);
      } else nativeIdentity(await handle.stat({ bigint: true }), part.identity, true);
      parent = handle;
    }
    const id = key(await parent.stat({ bigint: true }));
    requireAcquisition(!leafIds.has(id), "HOST_IDENTITY");
    leafIds.add(id); groups[role] = parent;
    const type = await port.open(`${fdPath(parent)}/cgroup.type`, port.constants.O_RDONLY | port.constants.O_NOFOLLOW);
    handles.push(type);
    const s = await type.stat({ bigint: true });
    nativeIdentity(s, null, false);
    requireAcquisition(s.dev === (await parent.stat({ bigint: true })).dev
      && await readBounded(type, HOST_READ_LIMITS.type) === "domain\n", "HOST_TYPE");
  }
  return groups;
}
