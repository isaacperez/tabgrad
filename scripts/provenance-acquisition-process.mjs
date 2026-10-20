import { fork } from "node:child_process";
import {
  AcquisitionRecordError, ACQUISITION_LIMITS, acquisitionSha256, encodeAcquisitionRecord,
  inspectAcquisitionRecord, requireAcquisition, isAcquisitionUtc,
} from "./provenance-acquisition-record.mjs";
import { ACQUISITION_ACTOR_PARTS, openAcquisitionRecord, readAcquisitionPart } from "./provenance-acquisition-record-io.mjs";
import { createAcquisitionControl } from "./provenance-acquisition-control.mjs";
import {
  ACQUISITION_PROCESS_CAUSES, decodeAcquisitionProcessMessage, encodeAcquisitionProcessMessage,
  sendAcquisitionProcessMessage, validateProcessTiming, validateProcessProgress, processFields,
} from "./provenance-acquisition-process-protocol.mjs";

const roles = Object.keys(ACQUISITION_ACTOR_PARTS);
const actorEntry = new URL("./provenance-acquisition-process-actor.mjs", import.meta.url);

function immutable(value) {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) immutable(item);
    Object.freeze(value);
  }
  return value;
}

function nativeFork(role, entry, options) { return fork(entry, [], options); }

function childState() {
  let closed;
  let launched;
  const joined = new Promise(resolve => { closed = resolve; });
  const launch = new Promise(resolve => { launched = resolve; });
  return { child: null, closed: false, exited: false, spawned: false, launch, resolveLaunch: launched,
    joined, resolveClose: closed, initialized: false,
    initSent: false, nextId: 1n, lastPulse: 0n, pulseSending: false, pending: null, cancelled: null,
    report: null, firstError: null, channelError: null, exitCode: null, signal: null,
    finishAck: false, finalReceipt: false, termRequested: false, killRequested: false, onMessage: null };
}

function validateReportProgress(previous, next) {
  if (!previous) return;
  requireAcquisition(BigInt(next.nextActionId) >= BigInt(previous.nextActionId)
    && BigInt(next.lastAtNs) >= BigInt(previous.lastAtNs)
    && !(previous.gate === "revoked" && next.gate !== "revoked")
    && !(previous.phase === "close" && next.phase !== "close")
    && (previous.firstFailure === null || JSON.stringify(previous.firstFailure) === JSON.stringify(next.firstFailure)), "PROCESS_PROTOCOL");
  for (const [part, old] of Object.entries(previous.writes)) {
    const current = next.writes[part];
    requireAcquisition(current.confirmedBytes >= old.confirmedBytes
      && (current.confirmedBytes !== old.confirmedBytes || current.sha256 === old.sha256)
      && (!old.uncertain || current.uncertain)
      && (old.firstError === null || current.firstError === old.firstError)
      && (old.closeError === null || current.closeError === old.closeError), "PROCESS_PROTOCOL");
  }
  if (previous.host) {
    const old = previous.host;
    const h = next.host;
    requireAcquisition(h && (!old.revoked || h.revoked) && (old.firstFailure === null || h.firstFailure === old.firstFailure)
      && (h.lastAtNs === null || old.lastAtNs === null || BigInt(h.lastAtNs) >= BigInt(old.lastAtNs)), "PROCESS_PROTOCOL");
    requireAcquisition(old.ioClosed === "open" || old.ioClosed === "pending" && h.ioClosed !== "open"
      || old.ioClosed === h.ioClosed, "PROCESS_PROTOCOL");
    for (const effect of ["freeze", "kill"]) requireAcquisition(old[effect].state === "not_requested"
      || old[effect].state === "pending" && h[effect].state !== "not_requested"
      || old[effect].state === h[effect].state && old[effect].error === h[effect].error, "PROCESS_PROTOCOL");
  }
}

/** Parent owns transport/child lifetimes, not actor decisions or external containment. */
class AcquisitionProcessSession {
  #source; #initial; #inputs; #timing; #fork; #states; #operationId; #deadline; #origin;
  #started = false; #busy = null; #stopped = false; #firstFailure = null; #finishing = null; #finished = false;
  #timer = null; #collection = null;

  constructor(source, initial, inputs, timing, forkActor) {
    this.#source = source; this.#initial = initial; this.#inputs = inputs; this.#timing = timing; this.#fork = forkActor;
    this.#states = Object.fromEntries(roles.map(role => [role, childState()]));
    this.#operationId = inputs.supervisor.context.operationId;
    this.#origin = BigInt(inputs.supervisor.context.t0MonotonicNs);
    this.#deadline = BigInt(inputs.supervisor.context.deadlineNs);
    this.supervisor = Object.freeze({ append: this.#append.bind(this) });
  }

  #wire(role, kind, id, payload) { return encodeAcquisitionProcessMessage(kind, role, this.#operationId, id, payload); }

  #send(role, wire) {
    const s = this.#states[role];
    return sendAcquisitionProcessMessage(s.child, wire).catch(() => {
      s.channelError ??= "PROCESS_CHANNEL";
      if (!this.#finished && !this.#finishing) this.#fail(role, "channel");
      throw new AcquisitionRecordError("PROCESS_CHANNEL");
    });
  }

  #cancel(role) {
    const s = this.#states[role];
    if (s.pending) {
      clearTimeout(s.pending.timer);
      s.cancelled = { id: s.pending.id, command: s.pending.command };
      const reject = s.pending.reject;
      s.pending = null;
      reject(new AcquisitionRecordError("PROCESS_STOPPED"));
    }
  }

  #fail(role, code) {
    const s = this.#states[role];
    s.firstError ??= code;
    if (this.#stopped || this.#finished) return;
    this.#stopped = true;
    this.#firstFailure = Object.freeze({ actor: role, code });
    for (const actor of roles) {
      this.#states[actor].resolveLaunch(false);
      this.#cancel(actor);
      const peer = this.#states[actor];
      if (peer.child && !peer.closed) void this.#send(actor, this.#wire(actor, "stop", "0",
        { code: actor === role ? code : "peer" })).catch(() => {});
    }
    if (!this.#finishing) void this.finish({ observedUtc: new Date().toISOString() });
  }

  #observe = () => {
    const elapsed = process.hrtime.bigint() - this.#origin;
    if (elapsed < 0n) this.#fail("supervisor", "clock");
    else if (elapsed > this.#deadline) this.#fail("supervisor", "deadline");
  };

  #adopt(role, child) {
    const s = this.#states[role];
    s.child = child;
    s.onMessage = wire => this.#message(role, wire);
    child.on("message", s.onMessage);
    child.once("spawn", () => { s.spawned = true; s.resolveLaunch(true); });
    child.on("error", () => {
      const code = !s.spawned ? "startup" : this.#finishing ? "cleanup" : "channel";
      s.resolveLaunch(false);
      this.#fail(role, code);
    });
    child.on("disconnect", () => {
      if (!this.#finished && !this.#finishing) this.#fail(role, s.spawned ? "channel" : "startup");
    });
    child.once("exit", (code, signal) => {
      s.exited = true; s.exitCode = code; s.signal = signal;
      if (!this.#finishing && !this.#finished) this.#fail(role, "peer");
    });
    child.once("close", (code, signal) => {
      s.closed = true; s.exitCode = code; s.signal = signal;
      s.resolveLaunch(false);
      s.resolveClose();
      if (!this.#finishing && !this.#finished) this.#fail(role, "peer");
    });
  }

  #message(role, wire) {
    if (this.#finished) return;
    const s = this.#states[role];
    let message;
    try {
      message = decodeAcquisitionProcessMessage(wire);
      requireAcquisition(message.actor === role && message.operationId === this.#operationId, "PROCESS_PROTOCOL");
      if (message.kind === "pulse") {
        requireAcquisition(BigInt(message.id) > s.lastPulse, "PROCESS_PROTOCOL");
        s.lastPulse = BigInt(message.id);
        const peerRole = role === "supervisor" ? "watchdog" : "supervisor";
        const peer = this.#states[peerRole];
        if (!this.#finishing && s.initialized && peer.initialized && !peer.closed && !peer.pulseSending) {
          peer.pulseSending = true;
          void this.#send(peerRole, wire).catch(() => {}).finally(() => { peer.pulseSending = false; });
        }
        return;
      }
      if (message.kind === "fault") { this.#fail(role, message.payload.code); return; }
      if (message.kind === "closed") {
        requireAcquisition(!s.finalReceipt && message.payload.report.pid === s.child.pid, "PROCESS_PROTOCOL");
        validateReportProgress(s.report, message.payload.report);
        s.report = immutable(message.payload.report);
        s.finalReceipt = true;
        return;
      }
      requireAcquisition(message.kind === "reply" && message.payload.report.pid === s.child.pid, "PROCESS_PROTOCOL");
      const pending = s.pending?.id === message.id ? s.pending : s.cancelled?.id === message.id ? s.cancelled : null;
      requireAcquisition(pending && pending.command === message.payload.command, "PROCESS_PROTOCOL");
      if (pending === s.pending && message.payload.ok && !this.#finishing) {
        const expected = pending.command === "append" ? "observe" : "setup";
        const stage = pending.command === "init" ? "new" : pending.command === "prepare" ? "read" : "bound";
        requireAcquisition(message.payload.report.phase === expected && message.payload.report.stage === stage
          && !message.payload.report.localClosed, "PROCESS_PROTOCOL");
        if (this.#inputs[role].host) requireAcquisition(message.payload.report.host
          && !message.payload.report.host.revoked && message.payload.report.host.observation.error === null
          && message.payload.report.host.observation.atNs !== null, "PROCESS_PROTOCOL");
      }
      validateReportProgress(s.report, message.payload.report);
      s.report = immutable(message.payload.report);
      if (message.payload.command === "init") s.initialized = true;
      if (pending === s.cancelled) { s.cancelled = null; return; }
      clearTimeout(pending.timer);
      s.pending = null;
      if (pending.command === "finish") s.finishAck = message.payload.ok && s.report.localClosed;
      pending.resolve(message.payload);
      if (!message.payload.ok && pending.command !== "finish") this.#fail(role,
        s.report.firstFailure?.code === "observer" ? "peer" : s.report.firstFailure?.code ?? "protocol");
    } catch { this.#fail(role, "protocol"); }
  }

  #rpc(role, command, data = null) {
    const s = this.#states[role];
    if (!s.child || s.closed || s.pending || this.#finished || (this.#finishing && command !== "finish")
      || (this.#stopped && command !== "finish")) return Promise.reject(new AcquisitionRecordError("PROCESS_STOPPED"));
    const id = (s.nextId++).toString();
    let wire;
    try { wire = this.#wire(role, "request", id, { command, data }); }
    catch { this.#fail(role, "protocol"); return Promise.reject(new AcquisitionRecordError("PROCESS_PROTOCOL")); }
    if (command === "init") s.initSent = true;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(role, command === "finish" ? "cleanup" : "peer"), this.#timing.peerTimeoutMs);
      s.pending = { id, command, timer, resolve, reject };
      void this.#send(role, wire).catch(() => this.#cancel(role));
    });
  }

  start() {
    if (this.#started || this.#finishing || this.#finished) {
      if (!this.#finished) this.#fail("supervisor", "protocol");
      return Promise.reject(new AcquisitionRecordError("PROCESS_STOPPED"));
    }
    this.#started = true;
    this.#busy = this.#start().finally(() => { this.#busy = null; });
    return this.#busy;
  }

  async #start() {
    this.#timer = setInterval(this.#observe, this.#timing.heartbeatMs);
    this.#observe();
    try {
      for (const role of roles) {
        if (this.#stopped || this.#finishing) break;
        try {
          const child = this.#fork(role, actorEntry, { execPath: process.execPath, execArgv: [], env: {},
            cwd: this.#source.root, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json" });
          this.#adopt(role, child);
        } catch { this.#fail(role, "startup"); break; }
      }
      if (this.#stopped || this.#finishing) return this.snapshot();
      const launched = await Promise.all(roles.map(role => this.#states[role].launch));
      if (this.#stopped || this.#finishing || !launched.every(Boolean)) return this.snapshot();
      await Promise.all(roles.map(role => this.#rpc(role, "init", this.#inputs[role])));
      const prepared = await this.#rpc("supervisor", "prepare");
      if (!prepared.ok) return this.snapshot();
      const verified = await this.#rpc("watchdog", "verify", { header: prepared.header });
      if (!verified.ok) return this.snapshot();
      await this.#rpc("supervisor", "ready", { actor: "watchdog", operationId: this.#operationId,
        phase: "setup", actionId: prepared.report.nextActionId,
        headerSha256: this.#inputs.watchdog.context.expectedHeaderSha256 });
    } catch {
      if (!this.#stopped && !this.#finishing) this.#fail("supervisor", "startup");
    }
    return this.snapshot();
  }

  #append(input) {
    if (!this.#started || this.#busy || !this.snapshot().mayStart) {
      if (!this.#finished) this.#fail("supervisor", "protocol");
      return Promise.reject(new AcquisitionRecordError("PROCESS_STOPPED"));
    }
    let stable;
    try { validateProcessProgress(input); stable = { ...input }; }
    catch { this.#fail("supervisor", "protocol"); return Promise.reject(new AcquisitionRecordError("PROCESS_INPUT")); }
    this.#busy = this.#rpc("supervisor", "append", stable).then(() => this.snapshot())
      .catch(() => this.snapshot()).finally(() => { this.#busy = null; });
    return this.#busy;
  }

  stop(role, code = "controller") {
    requireAcquisition(!this.#finished && roles.includes(role) && ACQUISITION_PROCESS_CAUSES.includes(code), "PROCESS_INPUT");
    this.#fail(role, code);
    return this.snapshot();
  }

  #signal(role, signal) {
    const s = this.#states[role];
    if (!s.child || s.closed || s.exited) return;
    if (signal === "SIGTERM") s.termRequested = true;
    else s.killRequested = true;
    // The owned ChildProcess handle is used, never an uncorrelated numeric PID.
    try { if (!s.child.kill(signal)) s.firstError ??= "cleanup"; }
    catch { s.firstError ??= "cleanup"; }
  }

  finish({ observedUtc }) {
    if (this.#finishing) return this.#finishing;
    requireAcquisition(isAcquisitionUtc(observedUtc), "PROCESS_INPUT");
    this.#finishing = this.#finish(observedUtc);
    return this.#finishing;
  }

  async #finish(observedUtc) {
    if (this.#timer) clearInterval(this.#timer);
    for (const role of roles) { this.#states[role].resolveLaunch(false); this.#cancel(role); }
    const term = setTimeout(() => roles.forEach(role => this.#signal(role, "SIGTERM")), this.#timing.termAfterMs);
    const kill = setTimeout(() => roles.forEach(role => this.#signal(role, "SIGKILL")), this.#timing.killAfterMs);
    let timeout;
    const wait = new Promise(resolve => { timeout = setTimeout(resolve, this.#timing.closeWaitMs); });
    for (const role of roles) {
      const s = this.#states[role];
      if (s.initSent && !s.closed) void this.#rpc(role, "finish", { observedUtc }).catch(() => {});
      else if (s.child && !s.closed) void this.#send(role, this.#wire(role, "stop", "0", { code: "controller" })).catch(() => {});
    }
    await Promise.race([Promise.all(roles.filter(role => this.#states[role].child).map(role => this.#states[role].joined)), wait]);
    clearTimeout(term); clearTimeout(kill); clearTimeout(timeout);
    for (const role of roles) {
      this.#cancel(role);
      const s = this.#states[role];
      if (s.child && (!s.closed || !(s.finishAck || s.finalReceipt) || s.exitCode !== 0 || s.signal !== null)) {
        s.firstError ??= "cleanup";
        this.#firstFailure ??= Object.freeze({ actor: role, code: "cleanup" });
      }
      s.child?.removeListener("message", s.onMessage);
    }
    const parts = await this.#collect();
    let formatComplete = false;
    let formatError = null;
    try { formatComplete = inspectAcquisitionRecord(parts).formatComplete; }
    catch { formatError = "RECORD_ASSOCIATION_FAILED"; }
    this.#collection = Object.freeze({ formatComplete, formatError });
    this.#finished = true;
    return Object.freeze({ ...this.snapshot(), parts: Object.freeze(parts) });
  }

  async #collect() {
    const parts = {};
    for (const [actor, owned] of Object.entries(ACQUISITION_ACTOR_PARTS)) {
      const s = this.#states[actor];
      for (const role of owned) {
        const known = s.report?.writes[role] ?? this.#initial[role];
        const range = (s.finishAck || s.finalReceipt) && s.closed ? known : { ...known, state: "unknown", uncertain: true };
        if (s.child && !s.closed) {
          parts[role] = { bytes: Buffer.alloc(0), state: "unknown", uncertain: true, confirmedBytes: known.confirmedBytes,
            readBytes: 0, readError: "OWNER_UNCONFIRMED" };
          continue;
        }
        try {
          const read = await readAcquisitionPart({ ...this.#source, role, destination: this.#source.destinations[role], range });
          if (read.readBytes === known.confirmedBytes && acquisitionSha256(read.bytes) !== known.sha256) {
            read.state = "unknown"; read.uncertain = true; read.readError = "PREFIX_MISMATCH";
          }
          if (read.readError !== null) {
            s.firstError ??= "storage";
            this.#firstFailure ??= Object.freeze({ actor, code: "storage" });
          }
          parts[role] = read;
        } catch {
          s.firstError ??= "storage";
          this.#firstFailure ??= Object.freeze({ actor, code: "storage" });
          parts[role] = { bytes: Buffer.alloc(0), state: "unknown", uncertain: true, confirmedBytes: known.confirmedBytes,
            readBytes: 0, readError: "COLLECTION_FAILED" };
        }
      }
    }
    return parts;
  }

  snapshot() {
    const children = Object.fromEntries(roles.map(role => {
      const s = this.#states[role];
      return [role, Object.freeze({ pid: s.child?.pid ?? null,
        state: !s.child ? "not_started" : s.closed ? "closed" : this.#finished || s.exited ? "unconfirmed"
          : s.spawned ? "running" : "starting",
        spawnObserved: s.spawned, exitObserved: s.exited, exitCode: s.exitCode, signal: s.signal,
        firstError: s.firstError, channelError: s.channelError,
        finishAck: s.finishAck, finalReceipt: s.finalReceipt, termRequested: s.termRequested, killRequested: s.killRequested })];
    }));
    const reports = Object.fromEntries(roles.map(role => [role, this.#states[role].report]));
    return Object.freeze({ children: Object.freeze(children), actors: Object.freeze(reports), firstFailure: this.#firstFailure,
      mayStart: this.#started && !this.#stopped && !this.#finishing && !this.#finished
        && roles.every(role => reports[role]?.gate === "ready" && !this.#states[role].closed),
      collection: this.#collection, externalClosure: "unqualified", clockAdmission: "unqualified", releaseAdmission: "unqualified" });
  }
}

/**
 * Validate inputs/all four files without launching. start() adopts two fixed Node
 * actors. forkActor is a trusted test seam, not a launcher/plugin configuration.
 */
export async function createAcquisitionProcessSession(input, { forkActor = nativeFork } = {}) {
  const base = ["root", "destinations", "header", "supervisorContext", "watchdogContext", "timing"];
  const withHost = processFields(input, [...base, "host"]);
  requireAcquisition((processFields(input, base) || withHost)
    && typeof forkActor === "function", "PROCESS_INPUT");
  const timing = validateProcessTiming(input.timing);
  const header = encodeAcquisitionRecord("header", input.header).toString("base64");
  const contexts = { supervisor: createAcquisitionControl(input.supervisorContext).context,
    watchdog: createAcquisitionControl(input.watchdogContext).context };
  requireAcquisition(contexts.supervisor.operationId === contexts.watchdog.operationId
    && contexts.supervisor.t0MonotonicNs === contexts.watchdog.t0MonotonicNs
    && contexts.supervisor.deadlineNs === contexts.watchdog.deadlineNs
    && BigInt(contexts.supervisor.t0MonotonicNs) <= process.hrtime.bigint(), "PROCESS_INPUT");
  requireAcquisition(processFields(input.destinations, Object.keys(ACQUISITION_LIMITS)), "PROCESS_INPUT");
  const inputs = {};
  for (const role of roles) {
    const data = { root: input.root, destinations: Object.fromEntries(ACQUISITION_ACTOR_PARTS[role].map(part => [part,
      input.destinations?.[part]])), context: contexts[role], header: role === "supervisor" ? header : null, timing,
      ...(withHost ? { host: input.host } : {}) };
    const wire = encodeAcquisitionProcessMessage("request", role, contexts.supervisor.operationId, "1", { command: "init", data });
    inputs[role] = immutable(decodeAcquisitionProcessMessage(wire).payload.data);
  }
  const source = { root: input.root, destinations: { ...inputs.supervisor.destinations, ...inputs.watchdog.destinations } };
  const prepared = await openAcquisitionRecord(source);
  const initial = await prepared.close();
  requireAcquisition(Object.values(initial).every(part => part.closeError === null), "PROCESS_INPUT");
  return new AcquisitionProcessSession(source, initial, inputs, timing, forkActor);
}
