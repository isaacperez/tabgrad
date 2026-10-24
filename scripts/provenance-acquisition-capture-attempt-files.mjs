import { constants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ACQUISITION_LIMITS, AcquisitionRecordError, requireAcquisition } from "./provenance-acquisition-record.mjs";
import { acquisitionFileIdentity, identityMatches } from "./provenance-acquisition-file-io.mjs";
import { copyLaunchProfile } from "./provenance-acquisition-launch-profile.mjs";
import { LAUNCH_CONTROL_LIMITS } from "./provenance-acquisition-launch-protocol.mjs";
import { ACQUISITION_PAYLOAD_LIMITS, createAcquisitionPayloadStore, createAcquisitionPayload } from "./provenance-acquisition-payload.mjs";
import { createAcquisitionCapture } from "./provenance-acquisition-capture.mjs";

const native = Object.freeze({ open, lstat, realpath, read: (h, b, o, n, p) => h.read(b, o, n, p),
  write: (h, b, o, n, p) => h.write(b, o, n, p), close: h => h.close() });
const requireFile = value => requireAcquisition(value, "CAPTURE_ATTEMPT_FILE");

/** Global admission owns only temporary checks and the five capture files, never record writers. */
class CaptureFiles {
  #profile; #clock; #ports; #slots = []; #pending = 0; #stopped = false;
  #opening = null; #closing = null; #error = null; #cleanup = null; #prepared = false; #rootIdentity = null;
  #program = null; #daemon = null; #control = null; #launch = null;

  constructor(profile, clock, ports) { this.#profile = profile; this.#clock = clock; this.#ports = ports; }
  #check() { requireAcquisition(!this.#stopped, "CAPTURE_ATTEMPT_STOPPED"); return this.#clock(); }
  async #effect(fn, adopt) {
    this.#check(); this.#pending++;
    try { const value = await fn(); adopt?.(value); this.#check(); return value; }
    finally { this.#pending--; }
  }
  async #root(path) {
    const stat = await this.#effect(() => this.#ports.lstat(path, { bigint: true }));
    requireFile(stat.isDirectory() && !stat.isSymbolicLink() && await this.#effect(() => this.#ports.realpath(path)) === path);
    return acquisitionFileIdentity(stat);
  }
  #closeSlot(slot) {
    if (slot.owner !== "temporary" || slot.closing) return slot.closing;
    slot.state = "pending";
    slot.closing = Promise.resolve().then(() => this.#ports.close(slot.handle))
      .then(() => { slot.state = "closed"; }, () => { slot.state = "unknown"; this.#cleanup ??= "CAPTURE_ATTEMPT_CLEANUP"; });
    return slot.closing;
  }
  async #openFile(path, expected, capacity, readOnly, role) {
    let slot;
    const flags = (readOnly ? constants.O_RDONLY : constants.O_RDWR) | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    requireFile(Number.isInteger(constants.O_NOFOLLOW));
    await this.#effect(() => this.#ports.open(path, flags), handle => {
      slot = { handle, role, owner: "temporary", state: "open", closing: null, identity: null };
      this.#slots.push(slot);
      if (this.#stopped) this.#closeSlot(slot);
    });
    const stat = await this.#effect(() => slot.handle.stat({ bigint: true }));
    requireFile(stat.isFile() && stat.nlink === 1n && stat.size === BigInt(capacity));
    slot.identity = identityMatches(stat, expected);
    return slot;
  }
  async #profileFile() {
    const f = this.#profile.launcherProfile;
    const root = await this.#root(dirname(f.hostPath));
    const slot = await this.#openFile(f.hostPath, f.identity, f.bytes, true, "launcherProfile");
    const bytes = Buffer.alloc(f.bytes + 1);
    let offset = 0;
    while (offset < f.bytes) {
      const result = await this.#effect(() => this.#ports.read(slot.handle, bytes, offset, f.bytes - offset, offset));
      requireFile(Number.isInteger(result?.bytesRead) && result.bytesRead > 0 && result.bytesRead <= f.bytes - offset);
      offset += result.bytesRead;
    }
    const end = await this.#effect(() => this.#ports.read(slot.handle, bytes, offset, 1, offset));
    requireFile(end?.bytesRead === 0);
    const stat = await this.#effect(() => slot.handle.stat({ bigint: true }));
    requireFile(stat.isFile() && stat.nlink === 1n && stat.size === BigInt(f.bytes)); identityMatches(stat, f.identity);
    identityMatches(await this.#effect(() => this.#ports.lstat(dirname(f.hostPath), { bigint: true })), root);
    const launch = copyLaunchProfile(bytes.subarray(0, offset), { sha256: f.sha256, bytes: f.bytes });
    await this.#effect(() => this.#closeSlot(slot)); requireFile(slot.state === "closed");
    return launch;
  }
  async #prepare() {
    const p = this.#profile;
    this.#launch = await this.#profileFile();
    this.#rootIdentity = await this.#root(p.exec.capture.root);
    const groups = [ ["daemon", p.exec.capture.destinations, ACQUISITION_PAYLOAD_LIMITS, false],
      ["program", p.programCapture.destinations, ACQUISITION_PAYLOAD_LIMITS, false],
      ["control", { control: p.controlCapture.destination }, { control: LAUNCH_CONTROL_LIMITS.total }, false],
      ["record", p.recordCapture.destinations, ACQUISITION_LIMITS, true] ];
    const seen = new Set([`${p.launcherProfile.identity.dev}:${p.launcherProfile.identity.ino}`]);
    const parts = {};
    for (const [group, destinations, limits, readOnly] of groups) {
      parts[group] = {};
      for (const [role, d] of Object.entries(destinations)) {
        const slot = await this.#openFile(join(p.exec.capture.root, d.name), d.identity, limits[role], readOnly, `${group}.${role}`);
        requireAcquisition(!seen.has(slot.identity), "FILE_ALIAS"); seen.add(slot.identity); parts[group][role] = slot;
      }
    }
    identityMatches(await this.#effect(() => this.#ports.lstat(p.exec.capture.root, { bigint: true })), this.#rootIdentity);
    // Close only our readonly check handles, leaving the caller's record writers alone.
    await this.#effect(() => Promise.all(Object.values(parts.record).map(slot => this.#closeSlot(slot))));
    requireFile(Object.values(parts.record).every(slot => slot.state === "closed"));
    this.#check();
    const timing = { origin: BigInt(p.exec.timing.t0MonotonicNs), deadline: BigInt(this.#launch.profile.timing.workUntilNs) };
    const transfer = { write: this.#ports.write, close: this.#ports.close };
    const last = this.#clock();
    const store = (group, limits) => {
      const result = createAcquisitionPayloadStore(parts[group], timing, last, this.#clock, transfer, limits);
      for (const slot of Object.values(parts[group])) slot.owner = "store";
      return result;
    };
    this.#program = createAcquisitionPayload(store("program", ACQUISITION_PAYLOAD_LIMITS));
    this.#daemon = createAcquisitionCapture(store("daemon", ACQUISITION_PAYLOAD_LIMITS));
    this.#control = createAcquisitionPayload(store("control", { control: LAUNCH_CONTROL_LIMITS.total }));
    this.#prepared = true;
  }
  open() {
    if (!this.#opening) this.#opening = this.#prepare().catch(error => {
      this.#error ??= error instanceof AcquisitionRecordError ? error.code : "CAPTURE_ATTEMPT_FILE";
      this.stop(); throw new AcquisitionRecordError(this.#error);
    });
    return this.#opening;
  }
  stop() { this.#stopped = true; for (const slot of this.#slots) this.#closeSlot(slot); }
  close() {
    if (!this.#closing) {
      this.stop();
      this.#closing = (async () => {
        if (this.#opening) await this.#opening.catch(() => {});
        await Promise.all(this.#slots.filter(s => s.owner === "temporary").map(s => this.#closeSlot(s)));
        await Promise.all([this.#program, this.#daemon, this.#control].filter(Boolean).map(s => s.close()));
      })();
    }
    return this.#closing;
  }
  get launch() { return this.#launch; }
  get rootIdentity() { return this.#rootIdentity; }
  get program() { return this.#program; }
  get daemon() { return this.#daemon; }
  get control() { return this.#control; }
  snapshot() {
    return Object.freeze({ prepared: this.#prepared, pendingEffects: this.#pending, firstError: this.#error, cleanupError: this.#cleanup,
      checks: Object.freeze(this.#slots.filter(s => s.owner === "temporary").map(s => Object.freeze({ role: s.role, state: s.state }))),
      program: this.#program?.snapshot() ?? null, daemon: this.#daemon?.snapshot() ?? null, control: this.#control?.snapshot() ?? null });
  }
}

export function createCaptureFiles(profile, clock, ports = {}) {
  requireFile(ports && Object.getPrototypeOf(ports) === Object.prototype
    && Reflect.ownKeys(ports).every(k => Object.hasOwn(native, k)
      && Object.hasOwn(Object.getOwnPropertyDescriptor(ports, k), "value")
      && Object.getOwnPropertyDescriptor(ports, k).enumerable && typeof ports[k] === "function"));
  return new CaptureFiles(profile, clock, Object.freeze({ ...native, ...ports }));
}
