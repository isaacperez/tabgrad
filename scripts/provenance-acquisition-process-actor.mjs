import { pathToFileURL } from "node:url";
import { AcquisitionActor } from "./provenance-acquisition-actor.mjs";
import { decodeAcquisitionRecord, isAcquisitionUint } from "./provenance-acquisition-record.mjs";
import { openAcquisitionActorRecord } from "./provenance-acquisition-record-io.mjs";
import { createAcquisitionHostController } from "./provenance-acquisition-host.mjs";
import { failedHostReport } from "./provenance-acquisition-host-profile.mjs";
import {
  decodeAcquisitionProcessMessage, encodeAcquisitionProcessMessage, processHeader,
  sendAcquisitionProcessMessage,
} from "./provenance-acquisition-process-protocol.mjs";

function hostCause(code) {
  return ["peer", "channel", "protocol", "clock", "deadline", "storage"].includes(code) ? code : "controller";
}

/** Explicit child entry, no client execution or module-import effects. */
export class AcquisitionProcessActor {
  #endpoint; #pid; #actor = null; #context = null; #timing; #record = null; #busy = null; #closing = null;
  #requestId = 0n; #pulseId = 0n; #lastPeerId = 0n; #lastPeerSeen = null; #peerLost = false;
  #timer = null; #pulseSending = false; #replySending = false; #faultSent = false; #firstStop = null;
  #autoClosing = false; #disconnectRequested = false;
  #host = null; #hostExpected = false; #hostPolling = false; #openHost; #hostFailure = null;

  constructor(endpoint, pid, { createHost = createAcquisitionHostController } = {}) {
    this.#endpoint = endpoint; this.#pid = pid; this.#openHost = createHost;
  }

  #now = () => {
    const at = process.hrtime.bigint() - BigInt(this.#context.t0MonotonicNs);
    return at >= 0n && isAcquisitionUint(at.toString()) ? at.toString() : null;
  };

  #wire(kind, id, payload) {
    return encodeAcquisitionProcessMessage(kind, this.#context.role, this.#context.operationId, id, payload);
  }

  #report() {
    const s = this.#actor.state;
    return { pid: this.#pid, gate: s.gate, phase: s.phase, stage: s.stage, nextActionId: s.nextActionId,
      lastAtNs: s.lastAtNs, firstFailure: s.firstFailure, localClosed: s.localClosed, writes: this.#actor.writes(),
      ...(this.#hostExpected ? { host: this.#host?.snapshot() ?? this.#hostFailure } : {}) };
  }

  async #reply(message, ok, header = null) {
    this.#replySending = true;
    try {
      await sendAcquisitionProcessMessage(this.#endpoint, this.#wire("reply", message.id,
        { command: message.payload.command, ok, report: this.#report(), header }));
    } finally { this.#replySending = false; }
  }

  #tick = () => {
    if (!this.#actor || this.#closing) return;
    this.#actor.tick();
    if (this.#host) {
      this.#host.check();
      if (this.#host.snapshot().revoked) { this.#fail(this.#hostCause()); return; }
      if (!this.#hostPolling) {
        this.#hostPolling = true;
        void this.#host.poll().then(() => {
          if (!this.#closing && this.#host.snapshot().revoked) this.#fail(this.#hostCause());
        }).catch(() => { if (!this.#closing) this.#fail("storage"); }).finally(() => { this.#hostPolling = false; });
      }
    }
    const now = this.#now();
    if (this.#actor.state.gate === "revoked") { this.#fail(this.#actor.state.firstFailure.code); return; }
    if (now === null) { this.#fail("clock"); return; }
    if (this.#lastPeerSeen !== null && BigInt(now) - BigInt(this.#lastPeerSeen) > BigInt(this.#timing.peerTimeoutMs) * 1000000n) {
      this.#peerLost = true; this.#fail("peer"); return;
    }
    if (this.#pulseSending || this.#replySending) return;
    this.#pulseSending = true;
    this.#pulseId += 1n;
    let wire;
    try { wire = this.#wire("pulse", this.#pulseId.toString(), { atNs: now }); }
    catch { this.#pulseSending = false; this.#fail("protocol"); return; }
    void sendAcquisitionProcessMessage(this.#endpoint, wire)
      .catch(() => this.#fail("channel")).finally(() => { this.#pulseSending = false; });
  };

  #peer(message) {
    if (!this.#actor || this.#closing) return;
    if (message.actor === this.#context.role || message.operationId !== this.#context.operationId
      || BigInt(message.id) <= this.#lastPeerId) { this.#fail("protocol"); return; }
    const at = this.#now();
    if (at === null) { this.#fail("clock"); return; }
    this.#lastPeerId = BigInt(message.id);
    this.#lastPeerSeen = at;
  }

  #fail(code) {
    this.#firstStop ??= code;
    this.#peerLost ||= code === "peer";
    this.#host?.contain(hostCause(code));
    this.#actor?.stop(["protocol", "peer", "clock", "deadline", "storage"].includes(code) ? code : "controller");
    if (this.#context && !this.#faultSent && this.#endpoint.connected) {
      this.#faultSent = true;
      const safe = ["protocol", "peer", "clock", "deadline", "storage", "channel"].includes(code) ? code : "controller";
      void sendAcquisitionProcessMessage(this.#endpoint, this.#wire("fault", "0", { code: safe })).catch(() => {});
    }
    if (!this.#autoClosing) {
      this.#autoClosing = true;
      void this.#failureClose();
    }
  }

  async #failureClose() {
    try {
      await this.#close(new Date().toISOString());
      if (this.#actor?.state.localClosed && this.#endpoint.connected) {
        await sendAcquisitionProcessMessage(this.#endpoint, this.#wire("closed", "0", { report: this.#report() }));
      }
    } catch { /* Missing receipt remains unconfirmed; never emit native diagnostics. */ }
    finally { this.#disconnect(); }
  }

  #disconnect = () => {
    this.#disconnectRequested = true;
    if (this.#endpoint.connected) {
      try { this.#endpoint.disconnect(); } catch { /* Already lost: no closure claim follows. */ }
    }
  };

  disconnected = () => { if (!this.#disconnectRequested) this.#fail("channel"); };
  terminated = () => { this.#fail("controller"); };

  async #initialize(message) {
    const data = message.payload.data;
    this.#context = Object.freeze({ ...data.context });
    this.#timing = Object.freeze({ ...data.timing });
    this.#record = await openAcquisitionActorRecord({ role: this.#context.role,
      root: data.root, destinations: data.destinations });
    const header = data.header === null ? null : decodeAcquisitionRecord("header", processHeader(data.header));
    this.#actor = new AcquisitionActor({ context: this.#context, record: this.#record, header, clock: this.#now });
    this.#hostExpected = Object.hasOwn(data, "host");
    if (this.#hostExpected) {
      try { this.#host = await this.#openHost(data.host, this.#context.role); }
      catch (error) { this.#hostFailure = failedHostReport(this.#context.role, this.#context.operationId, error); throw error; }
      if (this.#firstStop) this.#host.contain(hostCause(this.#firstStop));
      await this.#host.poll();
      if (this.#host.snapshot().revoked) this.#fail(this.#hostCause());
    }
    this.#lastPeerSeen = this.#now();
    if (this.#firstStop) this.#actor.stop("controller");
    else if (!this.#closing) this.#timer = setInterval(this.#tick, this.#timing.heartbeatMs);
    return { ok: this.#actor.state.gate !== "revoked", header: null };
  }

  async #command(message) {
    const { command, data } = message.payload;
    if (command === "init") return this.#initialize(message);
    if (!this.#actor) throw new Error("PROCESS_PROTOCOL");
    let result;
    let header = null;
    if (command === "prepare") {
      result = await this.#actor.perform("write_header");
      if (result.ok) result = await this.#actor.perform("read_header");
      if (result.ok) header = this.#actor.headerReadback.bytes.toString("base64");
    } else if (command === "verify") {
      const bytes = processHeader(data.header);
      result = await this.#actor.perform("verify_header", { bytes, confirmedBytes: bytes.length,
        readBytes: bytes.length, state: "complete", uncertain: false });
    } else if (command === "ready") result = await this.#actor.perform("peer_ready", data);
    else if (command === "append") result = await this.#actor.perform("write_progress", data);
    else throw new Error("PROCESS_PROTOCOL");
    return { ok: result.ok, header };
  }

  #close(observedUtc) {
    if (this.#closing) return this.#closing;
    if (this.#timer) clearInterval(this.#timer);
    this.#closing = this.#finish(observedUtc);
    return this.#closing;
  }

  async #finish(observedUtc) {
    if (this.#busy) await this.#busy.catch(() => {});
    if (!this.#actor) {
      if (this.#record) await this.#record.close();
      return;
    }
    if (this.#host) {
      const host = await this.#host.close();
      if (host.ioClosed !== "closed" || host.observation.error !== null) this.#actor.stop("storage");
    }
    if (this.#context.role === "supervisor") await this.#actor.perform("finish_progress");
    const peer = this.#peerLost ? { state: "lost", atNs: this.#lastPeerId === 0n ? null : this.#lastPeerSeen }
      : this.#lastPeerId === 0n ? null : { state: "alive", atNs: this.#lastPeerSeen };
    await this.#actor.perform("write_ending", { observedUtc, peer });
    await this.#actor.perform("close_writer");
  }

  #hostCause() {
    const code = this.#host.snapshot().firstFailure;
    return code === "HOST_CLOCK" ? "clock" : code === "HOST_DEADLINE" ? "deadline" : "storage";
  }

  receive = wire => {
    let message;
    try { message = decodeAcquisitionProcessMessage(wire); }
    catch { this.#fail("protocol"); return; }
    if (message.kind === "pulse") { this.#peer(message); return; }
    if (this.#context && (message.actor !== this.#context.role || message.operationId !== this.#context.operationId)) {
      this.#fail("protocol"); return;
    }
    if (message.kind === "stop") { this.#fail(message.payload.code); return; }
    if (message.kind !== "request" || BigInt(message.id) !== this.#requestId + 1n) { this.#fail("protocol"); return; }
    this.#requestId += 1n;
    if (message.payload.command === "finish") {
      void this.#close(message.payload.data.observedUtc).then(async () => {
        if (this.#actor) await this.#reply(message, this.#actor.state.localClosed);
      }).catch(() => {}).finally(this.#disconnect);
      return;
    }
    if (this.#busy || this.#closing || (this.#actor !== null && message.payload.command === "init")) {
      this.#fail("protocol"); return;
    }
    const work = this.#command(message);
    this.#busy = work;
    void work.then(result => {
      if (this.#busy === work) this.#busy = null;
      return this.#reply(message, result.ok, result.header);
    }).catch(() => {
      if (this.#busy === work) this.#busy = null;
      this.#fail(message.payload.command === "init" ? "storage" : "protocol");
    });
  };
}

export function runAcquisitionProcessActor(endpoint = process, pid = process.pid, options = {}) {
  const actor = new AcquisitionProcessActor(endpoint, pid, options);
  endpoint.on("message", actor.receive);
  endpoint.on("disconnect", actor.disconnected);
  endpoint.on("SIGTERM", actor.terminated);
  endpoint.on("error", actor.disconnected);
  return actor;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runAcquisitionProcessActor();
