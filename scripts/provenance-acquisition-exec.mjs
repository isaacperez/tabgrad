import { AcquisitionRecordError, requireAcquisition, isAcquisitionUtc } from "./provenance-acquisition-record.mjs";
import { openAcquisitionCapture } from "./provenance-acquisition-capture.mjs";
import { copyExecProfile } from "./provenance-acquisition-exec-profile.mjs";
import { createExecAttempt } from "./provenance-acquisition-exec-attempt.mjs";

/** A single daemon-channel attempt; reported Exec status never authenticates process output. */
class AcquisitionExec {
  #profile; #startup; #capture; #clock; #attempt; #last = null;
  #started = false; #revoked = false; #finished = false; #firstFailure = null;
  #work = null; #workPending = false; #run = null; #timer = null; #resolveStop; #stopped;
  #captureClose = null; #captureClosePending = false; #controlsClosePending = false; #cleanupError = null;
  #cleanupExpired = false;
  #controlsResult = null; #utc = null;

  constructor(profile, startup, capture, clock, request) {
    this.#profile = profile; this.#startup = startup; this.#capture = capture; this.#clock = clock;
    this.#last = BigInt(profile.timing.t0MonotonicNs) + BigInt(capture.snapshot().lastAtNs);
    this.#attempt = createExecAttempt(profile, { check: this.#check,
      appendIntent: event => this.#startup.supervisor.append(event), revoke: code => this.#fail(code) }, capture, request);
    this.#stopped = new Promise(resolve => { this.#resolveStop = resolve; });
  }

  #now() {
    let now;
    try { now = this.#clock(); } catch { throw new AcquisitionRecordError("EXEC_CLOCK"); }
    const origin = BigInt(this.#profile.timing.t0MonotonicNs);
    requireAcquisition(typeof now === "bigint" && now >= origin && (this.#last === null || now >= this.#last), "EXEC_CLOCK");
    this.#last = now;
    return now;
  }

  #time() {
    const now = this.#now();
    const origin = BigInt(this.#profile.timing.t0MonotonicNs);
    requireAcquisition(now - origin < BigInt(this.#profile.timing.deadlineNs), "EXEC_DEADLINE");
    return now;
  }

  #cleanupTime() {
    const now = this.#now();
    requireAcquisition(now - BigInt(this.#profile.timing.t0MonotonicNs) < BigInt(this.#profile.timing.deadlineNs), "EXEC_DEADLINE");
    return now;
  }

  #check = () => {
    if (this.#revoked) throw new AcquisitionRecordError(this.#firstFailure ?? "EXEC_STOPPED");
    try {
      const now = this.#time();
      requireAcquisition(this.#startup.snapshot().mayStart, "EXEC_GATE");
      return now;
    } catch (error) {
      this.#fail(error instanceof AcquisitionRecordError ? error.code : "EXEC_GATE");
      throw new AcquisitionRecordError(this.#firstFailure);
    }
  };

  #poll = () => {
    if (this.#started || this.#revoked) return;
    try {
      this.#time();
    } catch (error) { this.#fail(error instanceof AcquisitionRecordError ? error.code : "EXEC_GATE"); }
  };

  #fail(code) {
    this.#firstFailure ??= code;
    if (this.#revoked) return;
    this.#revoked = true;
    this.#capture.stop(); this.#attempt.stop(); this.#resolveStop();
    this.#closeCapture();
    try { this.#startup.stop("supervisor", code === "EXEC_CLOCK" ? "clock" : code === "EXEC_DEADLINE" ? "deadline" : "controller"); }
    catch { this.#cleanupError ??= "EXEC_CLEANUP"; }
  }

  stop() { if (!this.#finished && !this.#revoked) this.#fail("EXEC_STOPPED"); return this.snapshot(); }

  async #execute() {
    this.#time();
    await this.#startup.start();
    this.#started = true; clearInterval(this.#timer);
    await this.#attempt.run();
  }

  #closeCapture() {
    if (this.#captureClose) return this.#captureClose;
    this.#captureClosePending = true;
    this.#captureClose = this.#capture.close().catch(() => { this.#cleanupError ??= "EXEC_CLEANUP"; })
      .finally(() => { this.#captureClosePending = false; });
    return this.#captureClose;
  }

  async #cleanup() {
    if (this.#timer) clearInterval(this.#timer);
    const capture = this.#closeCapture();
    this.#controlsClosePending = true;
    const controls = Promise.resolve().then(() => this.#startup.finish({ observedUtc: this.#utc }))
      .then(value => {
        this.#controlsResult = value;
        if (value.firstFailure || value.process?.collection?.formatComplete !== true) this.#cleanupError ??= "EXEC_CLEANUP";
      })
      .catch(() => { this.#cleanupError ??= "EXEC_CLEANUP"; })
      .finally(() => { this.#controlsClosePending = false; });
    const origin = BigInt(this.#profile.timing.t0MonotonicNs);
    let now;
    try { now = this.#cleanupTime(); } catch (error) { this.#firstFailure ??= error.code; }
    const remaining = now === undefined ? 0n : origin + BigInt(this.#profile.timing.deadlineNs) - now;
    const waitMs = Math.min(this.#profile.timing.closeWaitMs, Number(remaining > 0n ? remaining / 1000000n : 0n));
    let timer;
    const cutoff = new Promise(resolve => { timer = setTimeout(() => resolve(false), waitMs); });
    const settled = await Promise.race([Promise.all([capture, controls, this.#attempt.join()]).then(() => true), cutoff]);
    if (!settled) { this.#cleanupExpired = true; this.#cleanupError ??= "EXEC_CLEANUP"; }
    clearTimeout(timer);
    try { this.#cleanupTime(); } catch (error) { this.#firstFailure ??= error.code; }
    this.#finished = true;
  }

  run({ observedUtc }) {
    requireAcquisition(isAcquisitionUtc(observedUtc), "EXEC_INPUT");
    if (this.#run) return this.#run;
    this.#utc = observedUtc;
    if (!this.#revoked) {
      this.#workPending = true;
      this.#work = this.#execute().catch(error => {
        this.#fail(error instanceof AcquisitionRecordError && /^EXEC_/.test(error.code) ? error.code : "EXEC_PROTOCOL");
      }).finally(() => { this.#workPending = false; });
      this.#timer = setInterval(this.#poll, this.#profile.timing.pollMs);
    }
    this.#run = Promise.race([this.#work, this.#stopped]).then(() => this.#cleanup()).then(() => this.snapshot());
    return this.#run;
  }

  snapshot() {
    const attempt = this.#attempt.snapshot();
    const { transport, transportClosed } = attempt;
    const capture = this.#capture.snapshot();
    return Object.freeze({ operationId: this.#profile.operationId, recipeSha256: this.#profile.recipeSha256,
      containerId: this.#profile.containerId, execId: attempt.execId,
      createState: attempt.createState, startState: attempt.startState,
      before: attempt.before, after: attempt.after, firstFailure: this.#firstFailure,
      locallyComplete: attempt.protocolComplete && this.#firstFailure === null && capture.state === "complete"
        && capture.ioClosed === "closed" && !this.#cleanupError && !this.#controlsClosePending && transportClosed,
      finished: this.#finished, workPending: this.#workPending || attempt.workPending, captureClosePending: this.#captureClosePending,
      controlsClosePending: this.#controlsClosePending, cleanupError: this.#cleanupError,
      cleanupWaitExpired: this.#cleanupExpired,
      transportClosed, transport, capture, controls: this.#controlsResult,
      payloadOrigin: "unqualified", externalClosure: "unqualified", clockAdmission: "unqualified", releaseAdmission: "unqualified" });
  }
}

/** Creation copies inputs and opens owned payload files; native Exec requires explicit run(). */
export async function createAcquisitionExec(input, { startup, clock = () => process.hrtime.bigint(), request, transfer } = {}) {
  requireAcquisition(typeof clock === "function" && (request === undefined || typeof request === "function"), "EXEC_INPUT");
  const { capture: files, ...profile } = copyExecProfile(input, startup);
  const capture = await openAcquisitionCapture({ ...files, t0MonotonicNs: profile.timing.t0MonotonicNs,
    deadlineNs: profile.timing.deadlineNs }, { clock, ...(transfer ? { transfer } : {}) });
  return new AcquisitionExec(profile, startup, capture, clock, request);
}
