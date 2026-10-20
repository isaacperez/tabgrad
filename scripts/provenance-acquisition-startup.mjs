import { fork } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import {
  acquisitionFields as fields, requireAcquisition, AcquisitionRecordError, isAcquisitionUtc,
} from "./provenance-acquisition-record.mjs";
import { copyHostProfile, freezeHostData, validateHostReportProgress } from "./provenance-acquisition-host-profile.mjs";
import { readHostGuardProfile } from "./provenance-acquisition-host-guard.mjs";
import { createEnteringAcquisitionProcessSession, ENTERING_PROCESS_FIELDS } from "./provenance-acquisition-process.mjs";
import { ACQUISITION_PROCESS_CAUSES, sendAcquisitionProcessMessage, validateProcessTiming } from "./provenance-acquisition-process-protocol.mjs";
import { decodeStartupGuardMessage, encodeStartupGuardStop } from "./provenance-acquisition-startup-protocol.mjs";

const guardEntry = new URL("./provenance-acquisition-startup-guard.mjs", import.meta.url);
function nativeGuard(entry, args, options) { return fork(entry, args, options); }

function hostCause(report) {
  return { HOST_CLOCK: "clock", HOST_DEADLINE: "deadline", HOST_PROTOCOL: "protocol", HOST_PEER: "peer",
    HOST_CHANNEL: "channel", HOST_READ: "storage", HOST_WRITE: "storage", HOST_ENTRY: "startup" }[report?.firstFailure] ?? "controller";
}

/** Composes existing owners. Its gate is local observed permission, never a physical lease. */
class AcquisitionStartup {
  #process; #host; #file; #root; #timing; #fork; #guard = null; #phase = null; #sequence = 0n; #report = null;
  #spawned = false; #exited = false; #closed = false; #exitCode = null; #signal = null; #channelError = null;
  #stopSent = false; #term = false; #kill = false; #started = false; #ready = false; #revoked = false;
  #firstFailure = null; #starting = null; #finishing = null; #finished = false; #timer = null; #last = null;
  #resolveReady; #guardReady; #resolveClosed; #guardClosed;

  constructor(session, host, file, root, timing, forkGuard) {
    this.#process = session; this.#host = host; this.#file = file; this.#root = root; this.#timing = timing; this.#fork = forkGuard;
    this.#guardReady = new Promise(resolve => { this.#resolveReady = resolve; });
    this.#guardClosed = new Promise(resolve => { this.#resolveClosed = resolve; });
    this.supervisor = Object.freeze({ append: this.#append.bind(this) });
    Object.defineProperty(this, "context", { enumerable: true, value: session.context });
  }

  #check = () => {
    if (this.#finished) return;
    const elapsed = process.hrtime.bigint() - BigInt(this.#host.t0MonotonicNs);
    if (elapsed < 0n || this.#last !== null && elapsed < this.#last) this.#fail("guard", "clock");
    else { this.#last = elapsed; if (elapsed >= BigInt(this.#host.stopAtNs)) this.#fail("guard", "deadline"); }
    const p = this.#process.snapshot();
    if (p.firstFailure) this.#fail(p.firstFailure.actor, p.firstFailure.code);
    if (this.#ready && !p.mayStart) this.#fail("supervisor", "peer");
  };

  #sendStop() {
    if (this.#stopSent || !this.#guard || !this.#guard.connected) return;
    this.#stopSent = true;
    void sendAcquisitionProcessMessage(this.#guard, encodeStartupGuardStop(this.#host.operationId,
      this.#firstFailure?.code ?? "controller")).catch(() => { this.#channelError ??= "PROCESS_CHANNEL"; });
  }

  #fail(actor, code) {
    if (this.#finished) return;
    this.#firstFailure ??= Object.freeze({ actor, code });
    if (this.#revoked) return;
    this.#revoked = true; this.#ready = false; this.#resolveReady(false); this.#sendStop();
    if (!this.#finishing && this.#process.snapshot().collection === null) {
      this.#process.stop(actor === "guard" ? "supervisor" : actor, code);
    }
    if (!this.#finishing) void this.finish({ observedUtc: new Date().toISOString() });
  }

  #message = wire => {
    if (this.#finished) return;
    try {
      const m = decodeStartupGuardMessage(wire);
      requireAcquisition(this.#spawned && m.pid === this.#guard.pid && m.profileSha256 === this.#file.sha256
        && m.report.operationId === this.#host.operationId && BigInt(m.sequence) > this.#sequence, "PROCESS_PROTOCOL");
      requireAcquisition(this.#phase === null ? ["armed", "failed"].includes(m.phase)
        : this.#phase === "armed" || this.#phase === "observation" ? ["observation", "boundary"].includes(m.phase)
          : this.#phase === "boundary" && m.phase === "settled", "PROCESS_PROTOCOL");
      validateHostReportProgress(this.#report, m.report, "PROCESS_PROTOCOL");
      this.#sequence = BigInt(m.sequence); this.#phase = m.phase; this.#report = freezeHostData(m.report);
      const expectedStop = this.#finishing && [null, "HOST_CONTROLLER", "HOST_DEADLINE"].includes(m.report.firstFailure);
      if (!expectedStop && (m.report.revoked || m.report.firstFailure || m.phase === "failed")) this.#fail("guard", hostCause(m.report));
      if (m.phase === "observation" && !this.#revoked) {
        requireAcquisition(m.report.entry.state === "verified" && m.report.ioClosed === "open"
          && m.report.observation.atNs !== null && m.report.observation.error === null, "PROCESS_PROTOCOL");
        if (!this.#ready) requireAcquisition(m.report.observation.populated === false && m.report.observation.frozen === false, "PROCESS_PROTOCOL");
        this.#resolveReady(true);
      }
      if (!this.#finishing && (m.phase === "boundary" || m.phase === "settled")) this.#fail("guard", "deadline");
    } catch { this.#fail("guard", "protocol"); }
  };

  #adopt(child) {
    this.#guard = child;
    child.on("message", this.#message);
    child.once("spawn", () => { this.#spawned = true; if (this.#revoked) this.#sendStop(); });
    child.on("error", () => this.#fail("guard", this.#spawned ? "channel" : "startup"));
    child.on("disconnect", () => {
      if (this.#phase !== "settled" && this.#phase !== "failed") { this.#channelError ??= "PROCESS_CHANNEL"; this.#fail("guard", "channel"); }
    });
    child.once("exit", (code, signal) => {
      this.#exited = true; this.#exitCode = code; this.#signal = signal;
      if (!this.#finishing) this.#fail("guard", "peer");
    });
    child.once("close", (code, signal) => {
      this.#closed = true; this.#exitCode = code; this.#signal = signal; this.#resolveReady(false); this.#resolveClosed();
      if (!this.#finishing) this.#fail("guard", "peer");
    });
  }

  start() {
    if (this.#started || this.#finishing) {
      this.#fail("supervisor", "protocol");
      return Promise.reject(new AcquisitionRecordError("PROCESS_STOPPED"));
    }
    this.#started = true;
    this.#starting = this.#start().finally(() => { this.#starting = null; });
    return this.#starting;
  }

  async #start() {
    this.#timer = setInterval(this.#check, this.#timing.heartbeatMs);
    this.#check();
    try {
      if (this.#revoked) return this.snapshot();
      try {
        this.#adopt(this.#fork(guardEntry, [this.#file.path, this.#file.sha256], {
          execPath: process.execPath, execArgv: [], env: {}, cwd: this.#root,
          stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json",
        }));
      } catch { this.#fail("guard", "startup"); return this.snapshot(); }
      let timeout;
      const expired = new Promise(resolve => { timeout = setTimeout(() => { this.#fail("guard", "startup"); resolve(false); }, this.#timing.peerTimeoutMs); });
      const ready = await Promise.race([this.#guardReady, expired]);
      clearTimeout(timeout);
      if (!ready || this.#revoked) return this.snapshot();
      const p = await this.#process.start();
      if (!this.#revoked && p.mayStart) {
        requireAcquisition(["supervisor", "watchdog"].every(role => p.actors[role]?.host?.entry?.state === "verified"
          && p.actors[role].host.observation.populated === false && p.actors[role].host.observation.frozen === false)
          && this.#report.observation.populated === false && this.#report.observation.frozen === false, "PROCESS_PROTOCOL");
        this.#ready = true;
      } else this.#fail(p.firstFailure?.actor ?? "supervisor", p.firstFailure?.code ?? "startup");
      this.#check();
    } catch (error) { this.#fail("supervisor", error?.code === "PROCESS_PROTOCOL" ? "protocol" : "startup"); }
    return this.snapshot();
  }

  async #append(input) {
    this.#check();
    if (this.#starting || !this.snapshot().mayStart) {
      this.#fail("supervisor", "protocol");
      throw new AcquisitionRecordError("PROCESS_STOPPED");
    }
    await this.#process.supervisor.append(input);
    this.#check();
    return this.snapshot();
  }

  stop(actor = "supervisor", code = "controller") {
    requireAcquisition(!this.#finished && ["supervisor", "watchdog", "guard"].includes(actor)
      && ACQUISITION_PROCESS_CAUSES.includes(code), "PROCESS_INPUT");
    this.#fail(actor, code);
    return this.snapshot();
  }

  #signalGuard(signal) {
    if (!this.#guard || this.#closed || this.#exited) return;
    if (signal === "SIGTERM") this.#term = true; else this.#kill = true;
    try { if (!this.#guard.kill(signal)) this.#firstFailure ??= Object.freeze({ actor: "guard", code: "cleanup" }); }
    catch { this.#firstFailure ??= Object.freeze({ actor: "guard", code: "cleanup" }); }
  }

  finish({ observedUtc }) {
    if (this.#finishing) return this.#finishing;
    requireAcquisition(isAcquisitionUtc(observedUtc), "PROCESS_INPUT");
    // Publish revocation synchronously; late ready replies cannot re-enter admission.
    this.#revoked = true; this.#ready = false; this.#resolveReady(false); this.#sendStop();
    if (this.#timer) clearInterval(this.#timer);
    this.#finishing = this.#finish(observedUtc);
    return this.#finishing;
  }

  async #joinGuard() {
    if (!this.#guard) return;
    const remaining = BigInt(this.#host.t0MonotonicNs) + BigInt(this.#host.observeUntilNs) - process.hrtime.bigint();
    const horizonMs = Number((remaining > 0n ? remaining + 999999n : 0n) / 1000000n);
    const term = setTimeout(() => this.#signalGuard("SIGTERM"), horizonMs + this.#timing.termAfterMs);
    const kill = setTimeout(() => this.#signalGuard("SIGKILL"), horizonMs + this.#timing.killAfterMs);
    let timeout;
    const wait = new Promise(resolve => { timeout = setTimeout(resolve, horizonMs + this.#timing.closeWaitMs); });
    await Promise.race([this.#guardClosed, wait]);
    clearTimeout(term); clearTimeout(kill); clearTimeout(timeout);
    this.#guard.removeListener("message", this.#message);
    if (!this.#closed || this.#exitCode !== 0 || this.#signal !== null || this.#phase !== "settled"
      || this.#report?.ioClosed !== "closed") this.#firstFailure ??= Object.freeze({ actor: "guard", code: "cleanup" });
  }

  async #finish(observedUtc) {
    const [session] = await Promise.all([this.#process.finish({ observedUtc }), this.#joinGuard()]);
    if (session.firstFailure) this.#firstFailure ??= session.firstFailure;
    this.#finished = true;
    return Object.freeze({ ...this.snapshot(), process: session });
  }

  snapshot() {
    return Object.freeze({ mayStart: this.#ready && !this.#revoked && !this.#finishing && this.#process.snapshot().mayStart,
      firstFailure: this.#firstFailure, finished: this.#finished, process: this.#process.snapshot(),
      guard: Object.freeze({ pid: this.#guard?.pid ?? null, spawnObserved: this.#spawned, exitObserved: this.#exited,
        closed: this.#closed, exitCode: this.#exitCode, signal: this.#signal, phase: this.#phase, report: this.#report,
        channelError: this.#channelError, stopSent: this.#stopSent, termRequested: this.#term, killRequested: this.#kill }),
      externalClosure: "unqualified", clockAdmission: "unqualified", releaseAdmission: "unqualified" });
  }
}

/** Validate owned files and independent expectations without launching or opening any cgroup. */
export async function createAcquisitionStartup(input, { forkActor, forkGuard = nativeGuard } = {}) {
  requireAcquisition(fields(input, ["process", "guardProfile"]) && fields(input.process, ENTERING_PROCESS_FIELDS)
    && fields(input.guardProfile, ["path", "sha256"])
    && typeof forkGuard === "function", "PROCESS_INPUT");
  const host = copyHostProfile(input.process?.host);
  const root = input.process.root;
  const timing = validateProcessTiming(input.process.timing);
  const file = Object.freeze({ ...input.guardProfile });
  const session = await createEnteringAcquisitionProcessSession(input.process, { forkActor });
  const profile = await readHostGuardProfile(file.path, file.sha256);
  const remaining = BigInt(host.t0MonotonicNs) + BigInt(host.observeUntilNs) - process.hrtime.bigint();
  requireAcquisition(isDeepStrictEqual(profile, host)
    && remaining <= BigInt(2147483647 - timing.closeWaitMs) * 1000000n, "PROCESS_INPUT");
  return new AcquisitionStartup(session, host, file, root, timing, forkGuard);
}
