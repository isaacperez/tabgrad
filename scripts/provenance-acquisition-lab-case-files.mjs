import { constants } from "node:fs";
import { open, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ACQUISITION_LIMITS, AcquisitionRecordError, acquisitionFields as fields, acquisitionSha256, isAcquisitionUint,
  requireAcquisition } from "./provenance-acquisition-record.mjs";
import { LAUNCH_CONTROL_LIMITS } from "./provenance-acquisition-launch-protocol.mjs";
import { ACQUISITION_PAYLOAD_LIMITS } from "./provenance-acquisition-payload.mjs";
import { LAB_LAUNCH_FILES } from "./provenance-acquisition-lab-diagnostic-profile.mjs";
import { labPaths } from "./provenance-acquisition-lab-profile.mjs";
import { freezeHostData } from "./provenance-acquisition-host-profile.mjs";
import { readNativeBytes, nativeFdPath } from "./provenance-acquisition-native-path.mjs";
import { identityMatches, ownedRoot } from "./provenance-acquisition-file-io.mjs";
import { parseAcquisitionJson } from "./provenance-acquisition-json.mjs";
import { labFailureCode } from "./provenance-acquisition-lab-command.mjs";

const native = Object.freeze({ open, mkdir, constants });
const id = s => ({ dev: s.dev.toString(), ino: s.ino.toString() });

/** Owns only one fresh case's private directories, fixed launcher closure, FIFO and nine reservations. */
export class LabCaseFiles {
  #lab; #plan; #kind; #token; #prefix; #paths; #port; #check; #command; #handles; #files; #retire;
  #directories = {}; #raw = {}; #assets = {}; #fifo = null; #attempted = false; #first = null; #preserved = true; #partial = null;
  constructor(lab, plan, kind, { check, command, handles, files, retirementFiles, filesystem = native }) {
    this.#lab = lab; this.#plan = plan; this.#kind = kind; this.#token = plan.operations[kind];
    requireAcquisition(typeof this.#token === "string", "LAB_INPUT");
    this.#prefix = `case-${kind.toLowerCase()}-${this.#token}`;
    this.#paths = { root: join(labPaths(lab).scratch, this.#prefix), input: join(labPaths(lab).scratch, this.#prefix, "input"),
      ipc: join(labPaths(lab).scratch, this.#prefix, "ipc") };
    this.#port = Object.freeze({ open: filesystem.open.bind(filesystem), mkdir: filesystem.mkdir.bind(filesystem),
      constants: Object.freeze({ ...filesystem.constants }) });
    this.#check = check; this.#command = command; this.#handles = handles; this.#files = files; this.#retire = retirementFiles;
  }
  get prefix() { return this.#prefix; }
  get paths() { return Object.freeze({ ...this.#paths }); }
  async #close(h, original, record = null) {
    try { await this.#handles.close(h); if (record) record.closeState = "closed"; }
    catch { if (record) record.closeState = "unknown"; original ??= new AcquisitionRecordError("LAB_CLEANUP"); }
    if (original) throw original;
  }
  async #directory(path, parent = null, name = null) {
    this.#check();
    if (parent) { await this.#port.mkdir(`${nativeFdPath(parent)}/${name}`, { mode: 0o750 }); this.#check(); }
    const c = this.#port.constants;
    const h = await this.#port.open(parent ? `${nativeFdPath(parent)}/${name}` : path, c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW);
    this.#handles.push(h); this.#check(); let failure; let stat;
    try {
      if (parent) { await h.chown(0, Number(this.#plan.credentials.gid)); this.#check(); await h.chmod(0o750); this.#check(); }
      stat = await h.stat({ bigint: true }); this.#check();
      requireAcquisition(stat.isDirectory() && stat.uid === 0n
        && (parent ? stat.gid === BigInt(this.#plan.credentials.gid) && (stat.mode & 0o777n) === 0o750n
          : (stat.mode & 0o077n) === 0n), "LAB_IDENTITY");
    } catch (error) { failure = error; }
    if (failure) await this.#close(h, failure);
    return { h, identity: id(stat) };
  }
  async #file(path, bytes, capacity = bytes.length, gid = null, record = {}) {
    Object.assign(record, { capacity, identity: null, fileState: "opening", closeState: "not_opened", firstFailure: null });
    this.#check(); const c = this.#port.constants;
    const h = await this.#port.open(path, c.O_CREAT | c.O_EXCL | c.O_RDWR | c.O_NOFOLLOW, gid === null ? 0o600 : 0o640);
    this.#handles.push(h); record.fileState = "opened"; record.closeState = "open"; this.#check(); let failure; let identity;
    try {
      const opened = await h.stat({ bigint: true }); this.#check(); record.identity = id(opened);
      requireAcquisition(opened.isFile() && opened.nlink === 1n, "LAB_IDENTITY");
      if (gid !== null) { await h.chown(0, Number(gid)); this.#check(); await h.chmod(0o640); this.#check(); }
      await h.truncate(capacity); this.#check(); let offset = 0;
      while (offset < bytes.length) {
        this.#check(); const r = await h.write(bytes, offset, bytes.length - offset, offset);
        requireAcquisition(Number.isInteger(r.bytesWritten) && r.bytesWritten > 0 && r.bytesWritten <= bytes.length - offset, "LAB_WRITE");
        offset += r.bytesWritten; this.#check();
      }
      await h.sync(); this.#check(); const stat = await h.stat({ bigint: true }); this.#check();
      requireAcquisition(stat.isFile() && stat.nlink === 1n && stat.size === BigInt(capacity), "LAB_IDENTITY"); identity = id(stat);
      record.fileState = "written";
    } catch (error) { failure = error; record.firstFailure = labFailureCode(error); }
    await this.#close(h, failure, record); return { identity, capacity, bytes: bytes.length, sha256: acquisitionSha256(bytes) };
  }
  async #source(name) {
    const expected = this.#plan.launcherFiles[name]; const c = this.#port.constants; this.#check();
    const h = await this.#port.open(fileURLToPath(new URL(`./${name}`, import.meta.url)), c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK);
    this.#handles.push(h); this.#check(); let bytes; let failure;
    try {
      const s = await h.stat({ bigint: true }); this.#check();
      requireAcquisition(s.isFile() && s.nlink === 1n && s.size === BigInt(expected.bytes), "LAB_IDENTITY");
      bytes = await readNativeBytes(h, expected.bytes, this.#check); const after = await h.stat({ bigint: true }); this.#check();
      identityMatches(after, id(s)); requireAcquisition(bytes.length === expected.bytes && acquisitionSha256(bytes) === expected.sha256
        && s.size === after.size && s.mtimeNs === after.mtimeNs && s.ctimeNs === after.ctimeNs, "LAB_IDENTITY");
    } catch (error) { failure = error; }
    await this.#close(h, failure); return bytes;
  }
  async prepare() {
    requireAcquisition(!this.#attempted, "LAB_PROTOCOL"); this.#attempted = true;
    try {
      const scratch = await this.#directory(labPaths(this.#lab).scratch);
      const base = await this.#directory(this.#paths.root, scratch.h, this.#prefix); this.#directories.root = base.identity;
      const input = await this.#directory(this.#paths.input, base.h, "input"); this.#directories.input = input.identity;
      const ipc = await this.#directory(this.#paths.ipc, base.h, "ipc"); this.#directories.ipc = ipc.identity;
      const fifoPayload = { schemaVersion: 1, root: { path: this.#paths.ipc, identity: ipc.identity }, gid: this.#plan.credentials.gid };
      const helper = fileURLToPath(new URL("./provenance_case_fifo.py", import.meta.url));
      const result = await this.#command("python", ["-I", helper, "32768", this.#lab.roots.pythonEnvironment.path],
        { label: `${this.#prefix}.fifo`, stdin: Buffer.from(JSON.stringify(fifoPayload)) });
      const fifo = parseAcquisitionJson(result.stdout, "LAB_PROTOCOL");
      requireAcquisition(fields(fifo, ["complete", "error", "created", "closeUnknown"])
        && fifo.complete === true && fifo.error === null && Array.isArray(fifo.closeUnknown) && !fifo.closeUnknown.length
        && Array.isArray(fifo.created) && fifo.created.length === 3
        && fifo.created.every((e, index) => fields(e, ["name", "ready", "identity"]) && e.ready === true
          && e.name === ["stdout", "stderr", "control"][index] && fields(e.identity, ["dev", "ino"])
          && isAcquisitionUint(e.identity.dev) && isAcquisitionUint(e.identity.ino) && e.identity.ino !== "0")
        && new Set([ipc.identity, ...fifo.created.map(e => e.identity)].map(v => `${v.dev}:${v.ino}`)).size === 4, "LAB_IDENTITY");
      this.#fifo = Object.fromEntries(fifo.created.map(e => [e.name, { name: e.name, identity: e.identity }]));
      for (const name of LAB_LAUNCH_FILES) {
        const bytes = await this.#source(name); const entry = { name }; this.#assets[name] = entry;
        Object.assign(entry, await this.#file(`${nativeFdPath(input.h)}/${name}`, bytes, bytes.length, this.#plan.credentials.gid, entry));
      }
      this.#check(); const actual = await ownedRoot(this.#lab.roots.evidence.path); this.#check();
      requireAcquisition(actual.dev === this.#lab.roots.evidence.identity.dev && actual.ino === this.#lab.roots.evidence.identity.ino, "LAB_IDENTITY");
      const capacities = { "daemon.stdout": ACQUISITION_PAYLOAD_LIMITS.stdout, "daemon.stderr": ACQUISITION_PAYLOAD_LIMITS.stderr,
        "program.stdout": ACQUISITION_PAYLOAD_LIMITS.stdout, "program.stderr": ACQUISITION_PAYLOAD_LIMITS.stderr,
        "control": LAUNCH_CONTROL_LIMITS.total, ...ACQUISITION_LIMITS };
      for (const [part, capacity] of Object.entries(capacities)) {
        const label = `${this.#prefix}.${part}`; const name = `${this.#lab.context.operationId}.${label}`;
        const entry = { name, identity: null, capacity }; this.#raw[part] = entry;
        Object.assign(entry, await this.#file(join(this.#lab.roots.evidence.path, name), Buffer.alloc(0), capacity, null, entry));
      }
      await this.#files.json(`${this.#prefix}.files-prepared.json`, this.snapshot());
      return this.snapshot();
    } catch (error) {
      this.#first ??= labFailureCode(error); await this.preserveFailure(); throw error;
    }
  }
  async writeInput(name, bytes) {
    requireAcquisition(name === "profile.json" && this.#directories.input && !Object.hasOwn(this.#assets, name), "LAB_PROTOCOL");
    const entry = { name }; this.#assets[name] = entry;
    this.#check();
    const root = await this.#port.open(this.#paths.input, this.#port.constants.O_RDONLY | this.#port.constants.O_DIRECTORY | this.#port.constants.O_NOFOLLOW);
    this.#handles.push(root); this.#check(); let record; let failure;
    try {
      const s = await root.stat({ bigint: true }); this.#check(); identityMatches(s, this.#directories.input);
      record = await this.#file(`${nativeFdPath(root)}/${name}`, bytes, bytes.length, this.#plan.credentials.gid, entry); Object.assign(entry, record);
    } catch (error) { failure = error; }
    await this.#close(root, failure); return record;
  }
  preserveFailure() {
    if (!this.#partial) this.#partial = Promise.resolve().then(() => this.#retire.json(`${this.#prefix}.files-partial.json`, this.snapshot()))
      .catch(() => { this.#preserved = false; });
    return this.#partial;
  }
  snapshot() {
    return freezeHostData({ kind: this.#kind, operationId: this.#token, paths: { ...this.#paths },
      directories: JSON.parse(JSON.stringify(this.#directories)), raw: JSON.parse(JSON.stringify(this.#raw)),
      assets: JSON.parse(JSON.stringify(this.#assets)), fifo: this.#fifo && JSON.parse(JSON.stringify(this.#fifo)),
      firstFailure: this.#first, preservationComplete: this.#preserved, physicalReservation: "unqualified" });
  }
}
