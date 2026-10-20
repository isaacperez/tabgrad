import { AcquisitionRecordError, requireAcquisition, isAcquisitionUtc } from "./provenance-acquisition-record.mjs";
import { openAcquisitionCapture } from "./provenance-acquisition-capture.mjs";
import { copyExecProfile, createdExec, inspectedExec } from "./provenance-acquisition-exec-profile.mjs";
import { createExecHttp } from "./provenance-acquisition-exec-http.mjs";

const empty = Buffer.alloc(0);
const startBody = Buffer.from('{"Detach":false,"Tty":false}');

/** A single daemon-channel attempt; reported Exec status never authenticates process output. */
class AcquisitionExec {
  #profile; #startup; #capture; #clock; #http; #last = null; #launchAt = null;
  #started = false; #revoked = false; #finished = false; #complete = false; #firstFailure = null;
  #execId = null; #before = null; #after = null; #create = "not_requested"; #start = "not_requested";
  #work = null; #workPending = false; #run = null; #timer = null; #resolveStop; #stopped;
  #captureClose = null; #captureClosePending = false; #controlsClosePending = false; #cleanupError = null;
  #cleanupExpired = false;
  #controlsResult = null; #utc = null;

  constructor(profile, startup, capture, clock, request) {
    this.#profile = profile; this.#startup = startup; this.#capture = capture; this.#clock = clock;
    this.#last = BigInt(profile.timing.t0MonotonicNs) + BigInt(capture.snapshot().lastAtNs);
    this.#http = createExecHttp(profile, this.#check, request);
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
    requireAcquisition(now - origin < BigInt(this.#profile.timing.deadlineNs)
      && (this.#launchAt === null || now - this.#launchAt < BigInt(this.#profile.timing.processBudgetNs)), "EXEC_DEADLINE");
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
    if (this.#complete || this.#revoked) return;
    try {
      if (!this.#started) this.#time();
      else this.#check();
    } catch (error) { this.#fail(error instanceof AcquisitionRecordError ? error.code : "EXEC_GATE"); }
  };

  #fail(code) {
    this.#firstFailure ??= code;
    if (this.#revoked) return;
    this.#revoked = true;
    this.#capture.stop(); this.#http.stop(); this.#resolveStop();
    try { this.#startup.stop("supervisor", code === "EXEC_CLOCK" ? "clock" : code === "EXEC_DEADLINE" ? "deadline" : "controller"); }
    catch { this.#cleanupError ??= "EXEC_CLEANUP"; }
  }

  stop() { if (!this.#finished && !this.#revoked) this.#fail("EXEC_STOPPED"); return this.snapshot(); }

  #consume = async bytes => {
    this.#check();
    try { await this.#capture.write(bytes); }
    catch { this.#fail("EXEC_CAPTURE"); throw new AcquisitionRecordError("EXEC_CAPTURE"); }
    this.#check();
  };

  async #execute() {
    this.#time();
    await this.#startup.start();
    this.#started = true; this.#check();
    // Acknowledged intent makes autonomous endings conservative before any daemon effect.
    await this.#startup.supervisor.append({ phase: "acquire", kind: "transition", subject: "client", code: "begun",
      reference: this.#profile.recipeSha256, value: null });
    this.#check();
    this.#create = "pending";
    const created = await this.#http.exchange("create", "POST", `/v1.56/containers/${this.#profile.containerId}/exec`, this.#profile.body, 201);
    this.#execId = createdExec(created); this.#create = "responded"; this.#check();
    const path = `/v1.56/exec/${this.#execId}`;
    this.#before = inspectedExec(await this.#http.exchange("before", "GET", `${path}/json`, empty, 200), this.#profile, this.#execId, true);
    this.#check();
    this.#launchAt = this.#last; this.#start = "pending";
    await this.#http.exchange("start", "POST", `${path}/start`, startBody, 101, this.#consume);
    this.#check(); this.#capture.finish(); this.#start = "stream_ended";
    this.#after = inspectedExec(await this.#http.exchange("after", "GET", `${path}/json`, empty, 200), this.#profile, this.#execId, false);
    this.#check(); this.#complete = true;
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
    this.#http.stop();
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
    try { now = this.#now(); } catch { this.#firstFailure ??= "EXEC_CLOCK"; }
    const remaining = now === undefined ? 0n : origin + BigInt(this.#profile.timing.deadlineNs) - now;
    const waitMs = Math.min(this.#profile.timing.closeWaitMs, Number(remaining > 0n ? remaining / 1000000n : 0n));
    let timer;
    const cutoff = new Promise(resolve => { timer = setTimeout(() => resolve(false), waitMs); });
    const settled = await Promise.race([Promise.all([capture, controls, this.#http.join()]).then(() => true), cutoff]);
    if (!settled) { this.#cleanupExpired = true; this.#cleanupError ??= "EXEC_CLEANUP"; }
    clearTimeout(timer);
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
    const transport = this.#http.snapshot();
    const transportClosed = Object.values(transport).every(t => t.requestClosed && (!t.responseObserved || t.streamClosed));
    const capture = this.#capture.snapshot();
    return Object.freeze({ operationId: this.#profile.operationId, recipeSha256: this.#profile.recipeSha256,
      containerId: this.#profile.containerId, execId: this.#execId,
      createState: this.#create === "pending" && this.#revoked ? "unknown" : this.#create,
      startState: this.#start === "pending" && this.#revoked ? "unknown" : this.#start,
      before: this.#before, after: this.#after, firstFailure: this.#firstFailure,
      locallyComplete: this.#complete && this.#firstFailure === null && capture.state === "complete"
        && capture.ioClosed === "closed" && !this.#cleanupError && !this.#controlsClosePending && transportClosed,
      finished: this.#finished, workPending: this.#workPending, captureClosePending: this.#captureClosePending,
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
