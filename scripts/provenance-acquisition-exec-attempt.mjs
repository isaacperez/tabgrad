import { AcquisitionRecordError, requireAcquisition } from "./provenance-acquisition-record.mjs";
import { copyExecAttemptProfile, createdExec, inspectedExec } from "./provenance-acquisition-exec-profile.mjs";
import { createExecHttp } from "./provenance-acquisition-exec-http.mjs";

const empty = Buffer.alloc(0);
const startBody = Buffer.from('{"Detach":false,"Tty":false}');
const failureCode = error => error instanceof AcquisitionRecordError && /^EXEC_/.test(error.code) ? error.code : "EXEC_PROTOCOL";

/** One HTTP attempt, borrowing permission and framing, never global lifecycle ownership. */
class AcquisitionExecAttempt {
  #profile; #gate; #capture; #http; #last; #launchAt = null;
  #revoked = false; #complete = false; #firstFailure = null; #revocationError = null;
  #execId = null; #before = null; #after = null; #create = "not_requested"; #start = "not_requested";
  #workPending = false; #run = null; #timer = null; #resolveStop; #stopped;

  constructor(profile, gate, capture, request) {
    this.#profile = profile;
    // Freeze the ports selected before any await, keeping each callback's receiver.
    this.#gate = { check: gate.check.bind(gate), appendIntent: gate.appendIntent.bind(gate), revoke: gate.revoke.bind(gate) };
    this.#capture = { write: capture.write.bind(capture), finish: capture.finish.bind(capture) };
    this.#last = BigInt(profile.timing.t0MonotonicNs);
    this.#http = createExecHttp(profile, this.#check, request);
    this.#stopped = new Promise(resolve => { this.#resolveStop = resolve; });
  }

  #check = () => {
    if (this.#revoked) throw new AcquisitionRecordError(this.#firstFailure);
    try {
      // The gate owns the operation's clock history and current permission. There
      // is no second clock: enforce this attempt's possibly tighter bounds on it.
      const now = this.#gate.check();
      requireAcquisition(typeof now === "bigint" && now >= this.#last, "EXEC_CLOCK");
      this.#last = now;
      requireAcquisition(now - BigInt(this.#profile.timing.t0MonotonicNs) < BigInt(this.#profile.timing.deadlineNs)
        && (this.#launchAt === null || now - this.#launchAt < BigInt(this.#profile.timing.processBudgetNs)), "EXEC_DEADLINE");
      return now;
    } catch (error) {
      this.#fail(error instanceof AcquisitionRecordError && /^EXEC_/.test(error.code) ? error.code : "EXEC_GATE");
      throw new AcquisitionRecordError(this.#firstFailure);
    }
  };

  #fail(code) {
    this.#firstFailure ??= code;
    if (!this.#revoked) {
      this.#revoked = true;
      // Notify the owner first: it can revoke the borrowed sink before HTTP abort
      // callbacks. A reentrant stop still aborts our own transport, exactly once.
      try { this.#gate.revoke(this.#firstFailure); } catch { this.#revocationError = "EXEC_GATE"; }
    }
    this.#http.stop(); this.#resolveStop();
  }

  #poll = () => {
    if (this.#complete || this.#revoked) return;
    try { this.#check(); } catch { /* #check retains and notifies the first failure. */ }
  };

  #consume = async bytes => {
    this.#check();
    try { await this.#capture.write(bytes); }
    catch { this.#fail("EXEC_CAPTURE"); throw new AcquisitionRecordError("EXEC_CAPTURE"); }
    this.#check();
  };

  async #execute() {
    this.#check();
    await this.#gate.appendIntent({ phase: "acquire", kind: "transition", subject: "client", code: "begun",
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

  run() {
    if (this.#run) return this.#run;
    let work;
    if (!this.#revoked) {
      this.#workPending = true;
      work = this.#execute().catch(error => { this.#fail(failureCode(error)); })
        .finally(() => { this.#workPending = false; });
      this.#timer = setInterval(this.#poll, this.#profile.timing.pollMs);
    }
    this.#run = Promise.race([work, this.#stopped]).then(() => {
      clearInterval(this.#timer); this.#http.stop(); return this.snapshot();
    });
    return this.#run;
  }

  stop() { if (!this.#complete || this.#revoked) this.#fail("EXEC_STOPPED"); return this.snapshot(); }

  /** Passive observation of currently known HTTP closes, not borrowed ACK/write settlement. */
  join() { return this.#http.join(); }

  snapshot() {
    const transport = this.#http.snapshot();
    return Object.freeze({ operationId: this.#profile.operationId, recipeSha256: this.#profile.recipeSha256,
      containerId: this.#profile.containerId, execId: this.#execId,
      createState: this.#create === "pending" && this.#revoked ? "unknown" : this.#create,
      startState: this.#start === "pending" && this.#revoked ? "unknown" : this.#start,
      before: this.#before, after: this.#after, firstFailure: this.#firstFailure, revocationError: this.#revocationError,
      protocolComplete: this.#complete && this.#firstFailure === null, workPending: this.#workPending,
      transportClosed: Object.values(transport).every(t => t.requestClosed && (!t.responseObserved || t.streamClosed)), transport,
      payloadOrigin: "unqualified", externalClosure: "unqualified", clockAdmission: "unqualified", releaseAdmission: "unqualified" });
  }
}

/** Internal seam for the convenience owner's already copied and validated profile. */
export function createExecAttempt(profile, gate, capture, request) {
  requireAcquisition(capture && ["write", "finish"].every(k => typeof capture[k] === "function"), "EXEC_INPUT");
  return new AcquisitionExecAttempt(profile, gate, capture, request);
}

/** Copies before effects; the caller retains startup, capture files and global closure. */
export function createAcquisitionExecAttempt(input, { gate, capture, request } = {}) {
  requireAcquisition(request === undefined || typeof request === "function", "EXEC_INPUT");
  const { capture: _files, ...profile } = copyExecAttemptProfile(input, gate);
  return createExecAttempt(profile, gate, capture, request);
}
