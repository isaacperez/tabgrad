import { constants } from "node:fs";
import { open, link, unlink, mkdir, lstat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { AcquisitionRecordError, acquisitionSha256, requireAcquisition } from "./provenance-acquisition-record.mjs";
import { identityMatches, ownedRoot } from "./provenance-acquisition-file-io.mjs";
import { readNativeBytes } from "./provenance-acquisition-native-path.mjs";
import { copyLabProfile, LAB_PROFILE_BYTES, LAB_TOOLS, labPaths } from "./provenance-acquisition-lab-profile.mjs";
import { LabHandles, labFailureCode } from "./provenance-acquisition-lab-command.mjs";

/** Caller owns these protected originals after service stop; no data-tree deletion. */
export class LabFiles {
  #p; #f; #check; #handles; #records = new Map(); #attempted = new Set(); #unpreserved = new Set();
  constructor(p, check, handles = new LabHandles()) { this.#p = p; this.#f = labPaths(p); this.#check = check; this.#handles = handles; }
  get handles() { return this.#handles; }
  async roots() {
    for (const name of ["scratch", "evidence", "tools", "pythonEnvironment"]) {
      this.#check(); const p = this.#p.roots[name];
      const actual = await ownedRoot(p.path); this.#check();
      requireAcquisition(actual.dev === p.identity.dev && actual.ino === p.identity.ino, "LAB_IDENTITY");
      const s = await lstat(p.path, { bigint: true }); this.#check();
      requireAcquisition((s.mode & (["tools", "pythonEnvironment"].includes(name) ? 0o022n : 0o077n)) === 0n, "LAB_IDENTITY");
    }
  }
  async scratch() {
    this.#check(); await mkdir(this.#f.scratch, { mode: 0o700 }); this.#check();
    for (const path of [this.#f.data, this.#f.exec]) { await mkdir(path, { mode: 0o700 }); this.#check(); }
  }
  async verifyTool(name, hash = true) {
    requireAcquisition(LAB_TOOLS.includes(name), "LAB_TOOL");
    const t = this.#p.tools[name]; this.#check();
    requireAcquisition(await realpath(t.path) === t.realPath, "LAB_TOOL"); this.#check();
    const h = await open(t.realPath, constants.O_RDONLY | constants.O_NOFOLLOW); this.#handles.push(h); this.#check();
    let failure;
    try {
      const s = await h.stat({ bigint: true }); this.#check(); identityMatches(s, t.identity);
      requireAcquisition(s.isFile() && s.nlink === 1n && s.size === BigInt(t.bytes)
        && (s.mode & 0o022n) === 0n && (s.mode & 0o111n) !== 0n, "LAB_TOOL");
      if (hash) {
        const digest = createHash("sha256"); const chunk = Buffer.alloc(64 * 1024); let offset = 0;
        while (offset < t.bytes) {
          this.#check(); const r = await h.read(chunk, 0, Math.min(chunk.length, t.bytes - offset), offset); this.#check();
          requireAcquisition(Number.isInteger(r.bytesRead) && r.bytesRead > 0 && r.bytesRead <= Math.min(chunk.length, t.bytes - offset), "LAB_READ");
          digest.update(chunk.subarray(0, r.bytesRead)); offset += r.bytesRead;
        }
        const tail = await h.read(chunk, 0, 1, offset); this.#check();
        const after = await h.stat({ bigint: true }); this.#check();
        requireAcquisition(tail.bytesRead === 0 && digest.digest("hex") === t.sha256
          && after.size === s.size && after.mtimeNs === s.mtimeNs && after.ctimeNs === s.ctimeNs, "LAB_TOOL");
        identityMatches(after, t.identity);
      }
    } catch (error) { failure = error; }
    try { await this.#handles.close(h); } catch { failure ??= new AcquisitionRecordError("LAB_CLEANUP"); }
    if (failure) throw failure;
  }
  #path(label) {
    requireAcquisition(typeof label === "string" && /^[a-z][a-z0-9.-]{0,127}$/.test(label), "LAB_PROFILE");
    return `${this.#f.prefix}.${label}`;
  }
  async write(label, bytes, limit = this.#p.limits.observationBytes) {
    requireAcquisition(Buffer.isBuffer(bytes) && bytes.length <= limit && !this.#attempted.has(label), "LAB_LIMIT");
    const path = this.#path(label); const temporary = path + ".pending";
    this.#attempted.add(label); this.#unpreserved.add(label); this.#check();
    const h = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    this.#handles.push(h); this.#check();
    let offset = 0; let failure;
    try {
      while (offset < bytes.length) {
        this.#check(); const r = await h.write(bytes, offset, bytes.length - offset, offset);
        requireAcquisition(Number.isInteger(r.bytesWritten) && r.bytesWritten > 0 && r.bytesWritten <= bytes.length - offset, "LAB_WRITE");
        offset += r.bytesWritten; this.#check();
      }
      await h.sync(); this.#check();
    } catch (error) { failure = error; }
    try { await this.#handles.close(h); } catch { failure ??= new AcquisitionRecordError("LAB_CLEANUP"); }
    if (failure) throw failure;
    // Atomic exclusive publication. Readers wait through the transient two-link state.
    this.#check(); await link(temporary, path); this.#check(); await unlink(temporary); this.#check();
    const record = Object.freeze({ label, bytes: bytes.length, sha256: acquisitionSha256(bytes) });
    this.#records.set(label, record); this.#unpreserved.delete(label); return record;
  }
  json(label, value, limit) { return this.write(label, Buffer.from(JSON.stringify(value)), limit); }
  async read(label, limit = this.#p.limits.observationBytes) {
    this.#check(); let h;
    try { h = await open(this.#path(label), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (error?.code === "ENOENT") { this.#check(); return null; } throw error; }
    this.#handles.push(h); this.#check(); let bytes; let failure;
    try {
      const s = await h.stat({ bigint: true }); this.#check();
      requireAcquisition(s.isFile() && (s.nlink === 1n || s.nlink === 2n) && s.size >= 0n && s.size <= BigInt(limit), "LAB_IDENTITY");
      if (s.nlink === 1n) bytes = await readNativeBytes(h, limit, this.#check);
      else bytes = null;
    } catch (error) { failure = error; }
    try { await this.#handles.close(h); } catch { failure ??= new AcquisitionRecordError("LAB_CLEANUP"); }
    if (failure) throw failure;
    return bytes;
  }
  async readJson(label) {
    const bytes = await this.read(label); if (bytes === null) return null;
    const text = bytes.toString("utf8"); const parsed = JSON.parse(text);
    requireAcquisition(Buffer.from(text).equals(bytes) && JSON.stringify(parsed) === text, "LAB_PROTOCOL");
    return parsed;
  }
  /** Read only a separately observed confirmed prefix, never the preallocated tail. */
  async verifyPrefix(label, file, channel) {
    requireAcquisition(file && channel && Number.isSafeInteger(file.capacity) && file.capacity > 0
      && file.capacity <= this.#p.limits.observationBytes && typeof file.identity === "string"
      && /^[0-9]+:[1-9][0-9]*$/.test(file.identity) && Number.isSafeInteger(channel.confirmedBytes)
      && channel.confirmedBytes >= 0 && channel.confirmedBytes <= file.capacity, "LAB_PRESERVATION");
    this.#check(); const h = await open(this.#path(label), constants.O_RDONLY | constants.O_NOFOLLOW);
    this.#handles.push(h); this.#check(); let failure;
    try {
      const s = await h.stat({ bigint: true }); this.#check();
      requireAcquisition(s.isFile() && s.nlink === 1n && s.size === BigInt(file.capacity)
        && `${s.dev}:${s.ino}` === file.identity, "LAB_PRESERVATION");
      const bytes = Buffer.alloc(channel.confirmedBytes); let offset = 0;
      while (offset < bytes.length) {
        this.#check(); const r = await h.read(bytes, offset, bytes.length - offset, offset); this.#check();
        requireAcquisition(Number.isInteger(r.bytesRead) && r.bytesRead > 0 && r.bytesRead <= bytes.length - offset, "LAB_READ");
        offset += r.bytesRead;
      }
      requireAcquisition(acquisitionSha256(bytes) === channel.sha256, "LAB_PRESERVATION");
    } catch (error) { failure = error; }
    try { await this.#handles.close(h); } catch { failure ??= new AcquisitionRecordError("LAB_CLEANUP"); }
    if (failure) throw failure;
  }
  snapshot() { return Object.freeze({ records: Object.freeze(Object.fromEntries(this.#records)),
    unpreservedRecords: Object.freeze([...this.#unpreserved]), handles: this.#handles.snapshot() }); }
  close() { return this.#handles.closeAll(); }
}

/** Explicit native entry profile reader, never discovery or an authority source. */
export async function readLabProfile(path, expectedSha256) {
  const handles = new LabHandles(); let value; let failure;
  try {
    const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); handles.push(h);
    const s = await h.stat({ bigint: true });
    requireAcquisition(s.isFile() && s.nlink === 1n && s.size > 0n && s.size <= BigInt(LAB_PROFILE_BYTES), "LAB_PROFILE");
    const bytes = await readNativeBytes(h, LAB_PROFILE_BYTES);
    requireAcquisition(bytes.length === Number(s.size) && acquisitionSha256(bytes) === expectedSha256, "LAB_PROFILE");
    const text = bytes.toString("utf8"); const parsed = JSON.parse(text);
    requireAcquisition(Buffer.from(text).equals(bytes) && JSON.stringify(parsed) === text, "LAB_PROFILE");
    value = copyLabProfile(parsed);
  } catch (error) { failure = error; }
  const closed = await handles.closeAll();
  if (failure || closed.retained) {
    const error = new AcquisitionRecordError(failure ? labFailureCode(failure, "LAB_PROFILE") : "LAB_CLEANUP");
    error.handleOwner = handles;
    throw error;
  }
  return value;
}
