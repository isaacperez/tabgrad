import { request as nativeRequest } from "node:http";
import { lstat } from "node:fs/promises";
import { AcquisitionRecordError, requireAcquisition } from "./provenance-acquisition-record.mjs";
import { identityMatches } from "./provenance-acquisition-file-io.mjs";
import { AcquisitionHttpTransaction } from "./provenance-acquisition-http-transaction.mjs";
import { copyActivationProfile } from "./provenance-acquisition-activation-profile.mjs";

const empty = Buffer.alloc(0);
const failures = new Set(["ACTIVATION_GATE", "ACTIVATION_CLOCK", "ACTIVATION_DEADLINE", "ACTIVATION_IDENTITY",
  "ACTIVATION_HTTP", "ACTIVATION_PROTOCOL", "ACTIVATION_STOPPED", "ACTIVATION_CLEANUP"]);

/** Start has a bodyless response, unlike Exec's JSON/upgrade protocols. */
function admitResponse({ response, upgraded }) {
  requireAcquisition(!upgraded && response.statusCode === 204 && response.httpVersion === "1.1", "ACTIVATION_PROTOCOL");
  const headers = new Map();
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    const name = response.rawHeaders[i].toLowerCase();
    if (!["content-length", "transfer-encoding", "content-encoding", "connection", "upgrade"].includes(name)) continue;
    requireAcquisition(!headers.has(name), "ACTIVATION_PROTOCOL");
    headers.set(name, response.rawHeaders[i + 1].toLowerCase());
  }
  requireAcquisition(!headers.has("content-length") && !headers.has("transfer-encoding") && !headers.has("upgrade")
    && (!headers.has("content-encoding") || headers.get("content-encoding") === "identity")
    && (!headers.has("connection") || headers.get("connection") === "close"), "ACTIVATION_PROTOCOL");
}

/** One borrowed Start; neither HTTP success nor closure admits native placement. */
class AcquisitionActivation {
  #profile; #binding; #gate; #request; #tx = null;
  #last; #lastAtNs = null; #origin; #deadline;
  #intent = "not_requested"; #requested = false; #bodyBytes = 0;
  #revoked = false; #complete = false; #firstFailure = null; #revocationError = null;
  #workPending = false; #run = null; #timer = null; #stopped; #resolveStop;

  constructor(profile, gate, request) {
    this.#profile = profile; this.#request = request;
    this.#binding = Object.freeze({ context: profile.context, containerId: profile.containerId,
      preparedContainerSha256: profile.preparedContainerSha256, socket: Object.freeze({ path: profile.socket.path,
        identity: Object.freeze({ ...profile.socket.identity }) }) });
    this.#gate = { check: gate.check.bind(gate), appendIntent: gate.appendIntent.bind(gate), revoke: gate.revoke.bind(gate) };
    this.#origin = BigInt(profile.context.t0MonotonicNs); this.#last = this.#origin;
    this.#deadline = BigInt(profile.context.deadlineNs);
    this.#stopped = new Promise(resolve => { this.#resolveStop = resolve; });
  }

  /** Copied immutable identity for composition; never a clock, request or admission. */
  get binding() { return this.#binding; }

  #fail(code) {
    this.#firstFailure ??= code;
    if (!this.#revoked) {
      this.#revoked = true;
      try { this.#gate.revoke(this.#firstFailure); } catch { this.#revocationError = "ACTIVATION_GATE"; }
    }
    this.#tx?.abort(); this.#resolveStop();
  }

  #check = () => {
    if (this.#revoked) throw new AcquisitionRecordError(this.#firstFailure);
    let now;
    try { now = this.#gate.check(); }
    catch { this.#fail("ACTIVATION_GATE"); throw new AcquisitionRecordError(this.#firstFailure); }
    if (this.#revoked) throw new AcquisitionRecordError(this.#firstFailure);
    if (typeof now !== "bigint" || now < this.#origin || now < this.#last) this.#fail("ACTIVATION_CLOCK");
    else {
      this.#last = now; this.#lastAtNs = String(now - this.#origin);
      if (now - this.#origin >= this.#deadline) this.#fail("ACTIVATION_DEADLINE");
    }
    if (this.#revoked) throw new AcquisitionRecordError(this.#firstFailure);
  };

  #poll = () => {
    if (this.#complete || this.#revoked) return;
    try { this.#check(); } catch { /* #check retains and notifies the first failure. */ }
  };

  async #execute() {
    this.#check(); this.#intent = "pending";
    try {
      await this.#gate.appendIntent({ phase: "setup", kind: "transition", subject: "group", code: "begun",
        reference: this.#profile.intentSha256, value: null });
      this.#intent = "acknowledged";
    } catch { this.#intent = "failed"; throw new AcquisitionRecordError("ACTIVATION_GATE"); }
    this.#check();
    let stat;
    try {
      stat = await lstat(this.#profile.socket.path, { bigint: true });
      requireAcquisition(stat.isSocket() && !stat.isSymbolicLink(), "ACTIVATION_IDENTITY");
      identityMatches(stat, this.#profile.socket.identity);
    } catch { throw new AcquisitionRecordError("ACTIVATION_IDENTITY"); }
    this.#check();
    this.#tx = new AcquisitionHttpTransaction("ACTIVATION_HTTP", "ACTIVATION_CLEANUP", true);
    this.#requested = true;
    const result = await this.#tx.begin({ socketPath: this.#profile.socket.path, method: this.#profile.method,
      path: this.#profile.route, headers: { Host: "docker", "Content-Length": "0", Connection: "close" },
      agent: false, maxHeaderSize: this.#profile.limits.headerBytes }, empty, this.#request);
    this.#check(); admitResponse(result);
    for await (const chunk of result.stream) {
      this.#check();
      requireAcquisition(Buffer.isBuffer(chunk), "ACTIVATION_PROTOCOL");
      this.#bodyBytes += chunk.length;
      requireAcquisition(chunk.length === 0, "ACTIVATION_PROTOCOL");
    }
    this.#check();
    requireAcquisition(this.#tx.ended && result.response.complete, "ACTIVATION_HTTP");
    this.#complete = true;
  }

  run() {
    if (this.#run) return this.#run;
    let resolveRun; let rejectRun;
    this.#run = new Promise((resolve, reject) => { resolveRun = resolve; rejectRun = reject; });
    let work;
    if (!this.#revoked) {
      this.#workPending = true;
      work = this.#execute().catch(error => {
        const code = error instanceof AcquisitionRecordError && failures.has(error.code) ? error.code : "ACTIVATION_HTTP";
        this.#fail(code);
      }).finally(() => { this.#workPending = false; });
      if (!this.#revoked) this.#timer = setInterval(this.#poll, this.#profile.pollMs);
    }
    Promise.race([work, this.#stopped]).then(() => {
      clearInterval(this.#timer); this.#tx?.abort(); return this.snapshot();
    }).then(resolveRun, rejectRun);
    return this.#run;
  }

  stop() {
    if (!this.#complete || this.#revoked) this.#fail("ACTIVATION_STOPPED");
    else this.#tx?.abort();
    return this.snapshot();
  }

  join() { return this.#tx?.closed ?? Promise.resolve(); }

  snapshot() {
    const transport = this.#tx?.snapshot() ?? null;
    return Object.freeze({ context: this.#profile.context, containerId: this.#profile.containerId,
      preparedContainerSha256: this.#profile.preparedContainerSha256, intentSha256: this.#profile.intentSha256,
      intentState: this.#intent, requestState: transport?.responseObserved ? "response_observed" : this.#requested ? "attempted" : "not_requested",
      statusCode: this.#tx?.statusCode ?? null, observedBodyBytes: this.#bodyBytes, lastAtNs: this.#lastAtNs,
      revoked: this.#revoked, protocolComplete: this.#complete, effectState: this.#requested ? "unknown" : "not_requested",
      workPending: this.#workPending, firstFailure: this.#firstFailure, revocationError: this.#revocationError,
      cleanupError: transport?.cleanupError ?? null,
      transportClosed: transport === null || transport.requestClosed && (!transport.responseObserved || transport.streamClosed), transport,
      externalClosure: "unqualified", clockAdmission: "unqualified", releaseAdmission: "unqualified" });
  }
}

export function createAcquisitionActivation(input, { gate, request = nativeRequest } = {}) {
  requireAcquisition(typeof request === "function", "ACTIVATION_INPUT");
  return new AcquisitionActivation(copyActivationProfile(input, gate), gate, request);
}
