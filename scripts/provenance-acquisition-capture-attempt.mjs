import { AcquisitionRecordError, acquisitionFields as fields, requireAcquisition } from "./provenance-acquisition-record.mjs";
import { copyCaptureAttemptProfile, bindCaptureLaunch } from "./provenance-acquisition-capture-attempt-profile.mjs";
import { createCaptureFiles } from "./provenance-acquisition-capture-attempt-files.mjs";
import { createAcquisitionExecAttempt } from "./provenance-acquisition-exec-attempt.mjs";
import { createAcquisitionFifos } from "./provenance-acquisition-fifo.mjs";
import { createLaunchControlDecoder } from "./provenance-acquisition-launch-protocol.mjs";

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const codeOf = error => error instanceof AcquisitionRecordError ? error.code : "CAPTURE_ATTEMPT_PROTOCOL";

/** Local composition only: the caller keeps startup, observation, validation and custody. */
class AcquisitionCaptureAttempt {
  #profile; #gate; #clock; #request; #fifoPorts; #files; #fifos = null; #decoder = null; #exec = null;
  #origin; #last; #workUntil; #closeUntil; #timer = null; #clockBroken = false;
  #opening = false; #prepared = false; #started = false; #flowPending = false; #execSettled = false;
  #firstFailure = null; #revoked = false; #cleanupError = null; #cleanupExpired = false; #finished = false;
  #openWait = null; #runWait = null; #closed = deferred(); #closing = null; #closeDone = false; #localComplete = false;

  constructor(profile, gate, ports) {
    this.#profile = profile; this.#gate = gate; this.#clock = ports.clock; this.#request = ports.request; this.#fifoPorts = ports.fifo;
    this.#origin = BigInt(profile.exec.timing.t0MonotonicNs); this.#last = this.#origin;
    this.#workUntil = BigInt(profile.exec.timing.deadlineNs); this.#closeUntil = this.#workUntil;
    this.#files = createCaptureFiles(profile, this.#dataClock, ports.files, () => this.#fail("CAPTURE_ATTEMPT_DAEMON_OUTPUT"));
  }

  #sample = () => {
    let now;
    try { now = this.#clock(); } catch { this.#clockBroken = true; throw new AcquisitionRecordError("CAPTURE_ATTEMPT_CLOCK"); }
    if (typeof now !== "bigint" || now < this.#last || now < this.#origin) {
      this.#clockBroken = true; throw new AcquisitionRecordError("CAPTURE_ATTEMPT_CLOCK");
    }
    this.#last = now; return now;
  };
  // Existing admitted deliveries can finish after revocation, within the original
  // data cutoff. FIFO/HTTP owners prevent new deliveries; clocks never grant permission.
  #dataClock = () => {
    try {
      const now = this.#sample();
      const bound = !this.#started && this.#workUntil > 15000000000n ? 15000000000n : this.#workUntil;
      requireAcquisition(now - this.#origin < bound, "CAPTURE_ATTEMPT_DEADLINE");
      return now;
    } catch (error) { this.#fail(codeOf(error)); throw error; }
  };
  #checkGate = (closing = false) => {
    if (this.#revoked) throw new AcquisitionRecordError(this.#firstFailure);
    try {
      const bound = closing ? this.#closeUntil : this.#workUntil;
      requireAcquisition(this.#sample() - this.#origin < bound, "CAPTURE_ATTEMPT_DEADLINE");
      const now = this.#gate.check();
      requireAcquisition(!this.#revoked, this.#firstFailure ?? "CAPTURE_ATTEMPT_STOPPED");
      requireAcquisition(typeof now === "bigint" && now >= this.#last, "CAPTURE_ATTEMPT_CLOCK");
      this.#last = now;
      requireAcquisition(now - this.#origin < bound, "CAPTURE_ATTEMPT_DEADLINE");
      const fifo = this.#fifos?.snapshot();
      if (fifo?.firstError) throw new AcquisitionRecordError(fifo.firstError);
      return now;
    } catch (error) {
      this.#fail(error instanceof AcquisitionRecordError ? error.code : "CAPTURE_ATTEMPT_GATE");
      throw new AcquisitionRecordError(this.#firstFailure);
    }
  };
  #arm() {
    if (!this.#timer && !this.#finished) this.#timer = setInterval(this.#poll, this.#profile.exec.timing.pollMs);
  }
  #poll = () => {
    if (this.#finished) return;
    try {
      const elapsed = this.#sample() - this.#origin;
      if (elapsed >= this.#closeUntil) {
        this.#cleanupExpired = true; this.#fail("CAPTURE_ATTEMPT_DEADLINE"); this.#finishWait(); return;
      }
      if (!this.#revoked && !this.#localComplete) {
        requireAcquisition(elapsed < (this.#started ? this.#workUntil : 15000000000n), "CAPTURE_ATTEMPT_DEADLINE");
        if (this.#started) this.#checkGate();
      } else if (!this.#revoked) this.#checkGate(true);
    } catch (error) {
      this.#fail(codeOf(error));
      if (this.#clockBroken) { this.#cleanupExpired = true; this.#finishWait(); return; }
    }
    this.#progress();
  };
  #fail(code) {
    this.#firstFailure ??= code;
    if (!this.#revoked) {
      this.#revoked = true;
      try { this.#gate.revoke(this.#firstFailure); } catch { this.#cleanupError ??= "CAPTURE_ATTEMPT_GATE"; }
      this.#fifos?.stop(); this.#exec?.stop();
      if (!this.#prepared) this.#files.stop();
    }
    this.#arm(); this.#beginClose();
  }
  #beginClose() {
    if (this.#closing) return;
    this.#closing = Promise.resolve().then(async () => {
      // Release/close readers first, without waiting for our sentinels' EOF.
      // Their close wait accounts for already admitted sink deliveries.
      if (this.#fifos) await this.#fifos.close();
      await this.#files.close();
      if (this.#exec) await this.#exec.join();
    }).catch(() => { this.#cleanupError ??= "CAPTURE_ATTEMPT_CLEANUP"; })
      .finally(() => { this.#closeDone = true; this.#progress(); });
  }
  #progress() {
    if (this.#finished || !this.#closeDone || this.#opening || this.#flowPending) return;
    if (this.#exec?.snapshot().workPending) return;
    const f = this.#files.snapshot();
    if (f.pendingEffects || f.checks.some(c => c.state === "open" || c.state === "pending")) return;
    const stores = [f.program, f.daemon, f.control].filter(Boolean);
    if (f.cleanupError || stores.some(s => s.ioClosed !== "closed")) this.#cleanupError ??= "CAPTURE_ATTEMPT_CLEANUP";
    if (this.#fifos?.snapshot().ioClosed !== undefined && this.#fifos.snapshot().ioClosed !== "closed") {
      this.#cleanupError ??= "CAPTURE_ATTEMPT_CLEANUP";
    }
    // A poll cannot stand in for observing the return of the last owned await.
    // Retain closure facts, but never admit a success outside its original horizon.
    try {
      requireAcquisition(this.#sample() - this.#origin < this.#closeUntil, "CAPTURE_ATTEMPT_DEADLINE");
      if (this.#localComplete && !this.#revoked) this.#checkGate(true);
    } catch (error) {
      const code = codeOf(error);
      if (this.#clockBroken || /_(CLOCK|DEADLINE)$/.test(code)) this.#cleanupExpired = true;
      this.#fail(code);
    }
    this.#finishWait();
  }
  #finishWait() {
    if (this.#finished) return;
    this.#finished = true;
    if (this.#timer) clearInterval(this.#timer); this.#timer = null;
    const result = this.snapshot();
    this.#openWait?.resolve(result); this.#runWait?.resolve(result); this.#closed.resolve(result);
  }

  open() {
    if (this.#openWait) return this.#openWait.promise;
    this.#openWait = deferred();
    if (this.#revoked || this.#finished) { this.#closed.promise.then(this.#openWait.resolve); return this.#openWait.promise; }
    this.#opening = true; this.#arm();
    void Promise.resolve().then(async () => {
      this.#dataClock(); await this.#files.open();
      requireAcquisition(!this.#revoked, this.#firstFailure ?? "CAPTURE_ATTEMPT_STOPPED");
      const launch = this.#files.launch;
      const fifo = bindCaptureLaunch(this.#profile, launch);
      const root = this.#files.rootIdentity;
      requireAcquisition(root.dev !== this.#profile.ipcHostRoot.identity.dev || root.ino !== this.#profile.ipcHostRoot.identity.ino,
        "CAPTURE_ATTEMPT_INPUT");
      this.#workUntil = BigInt(launch.profile.timing.workUntilNs); this.#closeUntil = BigInt(launch.profile.timing.closeUntilNs);
      this.#dataClock();
      this.#decoder = createLaunchControlDecoder({ operationId: this.#profile.exec.operationId, profileSha256: launch.sha256 });
      this.#fifos = createAcquisitionFifos(fifo, { ...this.#fifoPorts, clock: this.#sample });
      const ready = await this.#fifos.open();
      requireAcquisition(ready.prepared && !ready.firstError && !this.#revoked, ready.firstError ?? this.#firstFailure ?? "CAPTURE_ATTEMPT_FILE");
      this.#dataClock();
      const capture = { write: bytes => this.#files.daemon.write(bytes), finish: () => this.#files.daemon.finish() };
      const { body, recipeSha256, ...execInput } = this.#profile.exec;
      this.#exec = createAcquisitionExecAttempt(execInput, { gate: { context: this.#gate.context, check: this.#checkGate,
        appendIntent: event => this.#gate.appendIntent(event), revoke: code => this.#fail(code) }, capture, request: this.#request });
      this.#prepared = true;
    }).then(() => { this.#opening = false; if (!this.#revoked) this.#openWait.resolve(this.snapshot()); }, error => this.#fail(codeOf(error)))
      .finally(() => { this.#opening = false; this.#progress(); });
    return this.#openWait.promise;
  }
  #observeDaemon() {
    const channels = this.#files.daemon.snapshot().channels;
    if (channels.stdout.receivedBytes || channels.stderr.receivedBytes) this.#fail("CAPTURE_ATTEMPT_DAEMON_OUTPUT");
  }
  #release() {
    if (!this.#revoked && this.#execSettled && this.#decoder.snapshot().observations.E) void this.#fifos.releaseSentinels();
  }
  #controlWrite = async bytes => {
    await this.#files.control.write("control", bytes);
    try {
      this.#decoder.push(bytes);
      const d = this.#decoder.snapshot();
      for (const r of Object.values(d.observations)) if (r?.atNs !== null && r?.atNs !== undefined) {
        requireAcquisition(BigInt(r.atNs) < this.#closeUntil
          && (!["R", "S"].includes(r.kind) || BigInt(r.atNs) < this.#workUntil), "CAPTURE_ATTEMPT_LAUNCH");
      }
      if (d.observations.F) this.#fail("CAPTURE_ATTEMPT_LAUNCH");
      this.#release();
    } catch (error) { this.#fail(codeOf(error)); throw error; }
  };
  async #flow() {
    this.#checkGate();
    requireAcquisition(this.#last - this.#origin < 15000000000n, "CAPTURE_ATTEMPT_DEADLINE");
    const draining = this.#fifos.drain({ stdout: bytes => this.#files.program.write("stdout", bytes),
      stderr: bytes => this.#files.program.write("stderr", bytes), control: this.#controlWrite });
    const execution = this.#exec.run().then(result => {
      this.#execSettled = true;
      if (!result.protocolComplete || result.firstFailure) this.#fail(result.firstFailure ?? "CAPTURE_ATTEMPT_EXEC");
      else if (result.after.reportedExitCode !== 0) this.#fail("CAPTURE_ATTEMPT_LAUNCH");
      this.#release(); return result;
    });
    const [fifo, exec] = await Promise.all([draining, execution]);
    requireAcquisition(!this.#revoked && fifo.state === "complete" && !fifo.firstError && exec.protocolComplete,
      this.#firstFailure ?? fifo.firstError ?? "CAPTURE_ATTEMPT_PROTOCOL");
    this.#decoder.finish();
    const d = this.#decoder.snapshot().observations;
    requireAcquisition(d.R && d.S && d.X && d.E && !d.F && d.X.exitCode === 0 && d.X.signal === null
      && d.E.exitCode === 0 && d.E.signal === null && d.E.cause === null && d.E.cleanupError === null
      && d.E.fds === "cc", "CAPTURE_ATTEMPT_LAUNCH");
    this.#files.program.finish("stdout"); this.#files.program.finish("stderr"); this.#files.control.finish("control");
    this.#observeDaemon();
    requireAcquisition(!this.#revoked, this.#firstFailure ?? "CAPTURE_ATTEMPT_PROTOCOL");
    this.#localComplete = true;
  }
  run() {
    if (this.#runWait) return this.#runWait.promise;
    this.#runWait = deferred();
    if (this.#finished) { this.#runWait.resolve(this.snapshot()); return this.#runWait.promise; }
    if (!this.#prepared || this.#revoked) { this.#fail(this.#firstFailure ?? "CAPTURE_ATTEMPT_NOT_READY"); return this.#runWait.promise; }
    this.#started = true; this.#flowPending = true;
    void Promise.resolve().then(() => this.#flow()).catch(error => this.#fail(codeOf(error)))
      .finally(() => { this.#flowPending = false; this.#beginClose(); this.#progress(); });
    return this.#runWait.promise;
  }
  stop() { if (!this.#finished) this.#fail("CAPTURE_ATTEMPT_STOPPED"); return this.snapshot(); }
  join() { return this.#closed.promise; }
  /** Already copied immutable timing; no input reread, clock sample or I/O. */
  get timing() { return this.#profile.exec.timing; }
  snapshot() {
    const files = this.#files.snapshot();
    return Object.freeze({ operationId: this.#profile.exec.operationId, prepared: this.#prepared, opening: this.#opening,
      started: this.#started, finished: this.#finished, localComplete: this.#finished && this.#localComplete
        && !this.#firstFailure && !this.#cleanupError && !this.#cleanupExpired,
      firstFailure: this.#firstFailure, cleanupError: this.#cleanupError, cleanupWaitExpired: this.#cleanupExpired,
      revoked: this.#revoked, lastAtNs: (this.#last - this.#origin).toString(), files,
      fifo: this.#fifos?.snapshot() ?? null, control: this.#decoder?.snapshot() ?? null,
      exec: this.#exec?.snapshot() ?? null, flowPending: this.#flowPending,
      execBodySha256: this.#profile.exec.recipeSha256, profileSha256: this.#profile.launcherProfile.sha256,
      programRecipeSha256: this.#files.launch?.profile.programRecipeSha256 ?? null,
      otherInputSeparation: "unqualified", payloadOrigin: "unqualified", externalClosure: "unqualified",
      clockAdmission: "unqualified", releaseAdmission: "unqualified" });
  }
}

/** Creation performs no I/O. open prepares; only run borrows permission to execute. */
export function createAcquisitionCaptureAttempt(input, ports) {
  requireAcquisition(ports && Object.getPrototypeOf(ports) === Object.prototype
    && fields(ports, Object.keys(ports))
    && Reflect.ownKeys(ports).every(k => ["gate", "clock", "files", "fifo", "request"].includes(k)
      && Object.hasOwn(Object.getOwnPropertyDescriptor(ports, k), "value")), "CAPTURE_ATTEMPT_INPUT");
  const p = copyCaptureAttemptProfile(input, ports.gate);
  const g = ports.gate;
  const gate = Object.freeze({ context: Object.freeze({ ...g.context }), check: g.check.bind(g),
    appendIntent: g.appendIntent.bind(g), revoke: g.revoke.bind(g) });
  requireAcquisition((ports.clock === undefined || typeof ports.clock === "function")
    && (ports.request === undefined || typeof ports.request === "function"), "CAPTURE_ATTEMPT_INPUT");
  // Optional ports are trusted finite-test seams, selected before any await.
  const fifo = ports.fifo === undefined ? {} : ports.fifo;
  requireAcquisition(fifo && Object.getPrototypeOf(fifo) === Object.prototype
    && fields(fifo, Object.keys(fifo)) && Reflect.ownKeys(fifo).every(k =>
    ["root", "open", "read", "close", "schedule", "cancel"].includes(k) && typeof fifo[k] === "function"), "CAPTURE_ATTEMPT_INPUT");
  return Object.freeze(new AcquisitionCaptureAttempt(p, gate, { clock: ports.clock ?? (() => process.hrtime.bigint()),
    files: ports.files === undefined ? {} : ports.files, fifo: Object.freeze({ ...fifo }), request: ports.request }));
}
