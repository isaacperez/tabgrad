import { AcquisitionRecordError, acquisitionFields as fields, acquisitionSha256, requireAcquisition,
  isAcquisitionUint } from "./provenance-acquisition-record.mjs";
import { encodeLaunchObservation } from "./provenance-acquisition-launch-protocol.mjs";
import { freezeHostData } from "./provenance-acquisition-host-profile.mjs";
import { copyPlacementProfile } from "./provenance-acquisition-placement-profile.mjs";
import { createPlacementIO, placementIoCode } from "./provenance-acquisition-placement-io.mjs";

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const checkInput = value => requireAcquisition(value, "PLACEMENT_INPUT");

/** Conditional local placement checks, never preparation, physical retirement or trust admission. */
class AcquisitionPlacement {
  #profile; #gate; #io; #origin; #last; #permission = false; #started = false;
  #steps = new Map(); #pending = null; #revoked = false; #closing = null;
  #firstFailure = null; #revocationError = null; #cleanupError = null; #sources = {};

  constructor(profile, gate, port) {
    this.#profile = profile; this.#gate = gate;
    this.#origin = BigInt(profile.context.t0MonotonicNs); this.#last = this.#origin;
    this.#io = createPlacementIO(profile, this.#check, port);
  }

  get binding() { return this.#profile; }

  #check = () => {
    requireAcquisition(!this.#revoked && !this.#closing, this.#firstFailure ?? "PLACEMENT_STOPPED");
    let now;
    try { now = this.#permission ? this.#gate.check() : this.#gate.observe(); }
    catch { throw new AcquisitionRecordError("PLACEMENT_GATE"); }
    requireAcquisition(!this.#revoked && !this.#closing, this.#firstFailure ?? "PLACEMENT_STOPPED");
    requireAcquisition(typeof now === "bigint" && now >= this.#origin && now >= this.#last, "PLACEMENT_CLOCK");
    this.#last = now;
    requireAcquisition(now - this.#origin < BigInt(this.#profile.context.deadlineNs), "PLACEMENT_DEADLINE");
    return now;
  };

  #fail(code) {
    this.#firstFailure ??= code;
    if (!this.#revoked) {
      this.#revoked = true;
      try { this.#gate.revoke(this.#firstFailure); } catch { this.#revocationError ??= "PLACEMENT_GATE"; }
    }
    this.#close();
  }

  #step(name, effect) {
    if (this.#steps.has(name)) return this.#steps.get(name).promise;
    const wait = deferred(); this.#steps.set(name, wait);
    if (this.#revoked || this.#closing) { wait.resolve(this.snapshot()); return wait.promise; }
    if (this.#pending) { this.#fail("PLACEMENT_PROTOCOL"); wait.resolve(this.snapshot()); return wait.promise; }
    this.#pending = name; this.#started = true;
    void Promise.resolve().then(async () => { this.#check(); await effect(); this.#check(); })
      .catch(error => this.#fail(placementIoCode(error)))
      .finally(() => { this.#pending = null; wait.resolve(this.snapshot()); });
    return wait.promise;
  }

  open() { return this.#step("open", () => this.#io.open()); }
  beforeStart() {
    return this.#step("before", async () => {
      requireAcquisition(this.#io.snapshot().opened, "PLACEMENT_PROTOCOL");
      this.#permission = true; this.#check();
      await this.#io.beforeStart();
    });
  }
  afterStart() {
    return this.#step("after", async () => {
      requireAcquisition(this.#permission && this.#io.snapshot().beforeChecked, "PLACEMENT_PROTOCOL");
      await this.#io.afterStart();
    });
  }

  #launchSource(value, kind) {
    requireAcquisition(value?.kind === kind, "PLACEMENT_PROTOCOL");
    const hash = acquisitionSha256(encodeLaunchObservation(value));
    requireAcquisition(value.operationId === this.#profile.context.operationId
      && value.profileSha256 === this.#profile.launcherProfileSha256 && value.atNs !== null
      && isAcquisitionUint(value.atNs) && BigInt(value.atNs) <= this.#last - this.#origin
      && BigInt(value.launcherPid) > 1n && (kind !== "S" || value.childPid !== value.launcherPid
        && BigInt(value.childPid) > 1n), "PLACEMENT_PROTOCOL");
    if (this.#sources[kind]) requireAcquisition(this.#sources[kind].sha256 === hash, "PLACEMENT_PROTOCOL");
    else this.#sources[kind] = Object.freeze({ sha256: hash, launcherPid: value.launcherPid, childPid: value.childPid });
    return this.#sources[kind];
  }

  observeExecution(observations) {
    if (this.#revoked || this.#closing) return Promise.resolve(this.snapshot());
    let r; let s;
    try {
      this.#check();
      requireAcquisition(fields(observations, ["R", "S", "X", "F", "E"]), "PLACEMENT_PROTOCOL");
      requireAcquisition(this.#io.snapshot().subjects.init, "PLACEMENT_PROTOCOL");
      r = observations.R ? this.#launchSource(observations.R, "R") : null;
      s = observations.S ? this.#launchSource(observations.S, "S") : null;
      requireAcquisition(!s || r && s.launcherPid === r.launcherPid, "PLACEMENT_PROTOCOL");
    } catch { this.#fail("PLACEMENT_PROTOCOL"); return Promise.resolve(this.snapshot()); }
    if (!r) return Promise.resolve(this.snapshot());
    return this.#step("launcher", () => this.#io.observe("launcher", r.launcherPid)).then(() => {
      if (s && !this.#revoked && !this.#closing) return this.#step("program", () => this.#io.observe("program", s.childPid));
      return this.snapshot();
    });
  }

  poll() {
    if (this.#started && !this.#closing && !this.#revoked) {
      try { this.#check(); } catch (error) { this.#fail(placementIoCode(error)); }
    }
    return this.snapshot();
  }
  stop() { if (!this.#closing) this.#fail("PLACEMENT_STOPPED"); return this.snapshot(); }

  #close() {
    if (!this.#closing) this.#closing = Promise.resolve().then(async () => {
      await this.#io.close();
      if (this.#io.snapshot().ioClosed !== "closed") this.#cleanupError ??= "PLACEMENT_CLOSE";
      return this.snapshot();
    }).catch(() => { this.#cleanupError ??= "PLACEMENT_CLOSE"; return this.snapshot(); });
    return this.#closing;
  }
  close() { return this.#close(); }
  join() { return this.#closing ?? Promise.resolve(this.snapshot()); }
  collect() { return this.#io.collect(); }

  snapshot() {
    const io = this.#io.snapshot();
    return freezeHostData({ operationId: this.#profile.context.operationId, containerId: this.#profile.containerId,
      preparedContainerSha256: this.#profile.preparedContainerSha256, revoked: this.#revoked,
      mayExec: !!io.subjects.init && !this.#revoked && !this.#closing,
      executionObserved: !!io.subjects.launcher && !!io.subjects.program && !this.#firstFailure,
      pending: this.#pending, closing: this.#closing !== null, firstFailure: this.#firstFailure,
      revocationError: this.#revocationError, cleanupError: this.#cleanupError,
      lastAtNs: (this.#last - this.#origin).toString(), sources: { ...this.#sources }, io,
      externalClosure: "unqualified", clockAdmission: "unqualified", releaseAdmission: "unqualified" });
  }
}

/** Inert construction; pre-control reads borrow observe(), later admission borrows check(). */
export function createAcquisitionPlacement(input, ports) {
  const p = copyPlacementProfile(input);
  checkInput(ports && fields(ports, Object.keys(ports)) && Object.hasOwn(ports, "gate")
    && Reflect.ownKeys(ports).every(k => ["gate", "io"].includes(k)));
  const gate = ports.gate; const io = Object.hasOwn(ports, "io") ? ports.io : undefined;
  checkInput(fields(gate, ["context", "observe", "check", "revoke"])
    && fields(gate.context, ["operationId", "t0MonotonicNs", "deadlineNs", "root"])
    && Object.keys(p.context).every(k => p.context[k] === gate.context[k])
    && ["observe", "check", "revoke"].every(k => typeof gate[k] === "function"));
  const g = Object.freeze({ observe: gate.observe.bind(gate), check: gate.check.bind(gate), revoke: gate.revoke.bind(gate) });
  return Object.freeze(new AcquisitionPlacement(p, g, io));
}
