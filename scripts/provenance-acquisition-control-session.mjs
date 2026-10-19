import {
  AcquisitionRecordError, ACQUISITION_LIMITS, encodeAcquisitionRecord, decodeAcquisitionRecord,
  inspectAcquisitionRecord, requireAcquisition, isAcquisitionUtc,
} from "./provenance-acquisition-record.mjs";
import { openAcquisitionRecord, readAcquisitionPart } from "./provenance-acquisition-record-io.mjs";
import { ACQUISITION_CONTROL_PHASES, createAcquisitionControl, advanceAcquisitionControl } from "./provenance-acquisition-control.mjs";

const actors = ["supervisor", "watchdog"];
const ownedRoles = { supervisor: ["header", "progress", "supervisor"], watchdog: ["watchdog"] };

function progressInput(input) {
  const keys = ["phase", "kind", "subject", "code", "reference", "value"];
  requireAcquisition(input !== null && typeof input === "object"
    && [Object.prototype, null].includes(Object.getPrototypeOf(input)), "SESSION_INPUT");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  requireAcquisition(Reflect.ownKeys(input).length === keys.length && keys.every(key => descriptors[key]
    && Object.hasOwn(descriptors[key], "value") && descriptors[key].enumerable), "SESSION_INPUT");
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}

function ending(role, state, headerHash, progress, observedUtc) {
  const failure = state.firstFailure;
  const stopCode = failure?.code === "clock" ? "controller" : failure?.code === "peer" ? "observer" : failure?.code ?? "normal";
  const common = { recordType: `acq_${role}_end_v1`, operationId: state.context.operationId,
    headerSha256: headerHash, atNs: state.lastAtNs, observedUtc, phaseReached: "close", stopCode,
    firstStopAtNs: failure?.atNs ?? null, observationEvidenceSha256: null };
  if (role === "watchdog") return { ...common, peerState: "unknown", peerObservedAtNs: null,
    containmentState: "unconfirmed", containmentAtNs: null, caseEmptyState: "unknown",
    lifecycleState: "unknown", helperClosureState: "unknown" };
  return { ...common, clientState: "not_started", clientExitCode: null, clientSignal: null,
    stdoutState: "unknown", stdoutReceivedBytes: null, stdoutConfirmedBytes: null, stdoutSha256: null,
    stderrState: "unknown", stderrReceivedBytes: null, stderrConfirmedBytes: null, stderrSha256: null,
    progressState: progress.state === "pending" ? "incomplete" : progress.state,
    progressConfirmedBytes: String(progress.confirmedBytes), progressSha256: progress.sha256,
    preflightState: "unknown", preflightEvidenceSha256: null, validationState: "not_run", validationEvidenceSha256: null,
    inputWritersState: "unknown", lifecycleState: "unknown", caseClosureState: "unknown", helperClosureState: "unknown",
    guardsState: "unknown", guardsEvidenceSha256: null, resultEvidenceSha256: null, applicableExpiryUtc: null,
    payloadCustodyState: "unknown", payloadCustodyEvidenceSha256: null };
}

/** Local composition only. No process, timer, transport, clock admission or signer. */
class AcquisitionControlSession {
  #source; #record; #header; #clock; #states; #busy = null; #finishing = null; #finishRequested = false;
  #started = false; #finished = false; #sequence = 1n; #headerReadback = null; #collection = null;

  constructor(source, record, header, clock, states) {
    this.#source = source; this.#record = record; this.#header = header; this.#clock = clock; this.#states = states;
    this.supervisor = Object.freeze({ append: this.#append.bind(this) });
  }

  #now() { try { return this.#clock(); } catch { return null; } }

  #event(role, kind, fields) {
    const state = this.#states[role];
    return { kind, actor: role, operationId: state.context.operationId, phase: state.phase,
      actionId: null, atNs: this.#now(), ...fields };
  }

  #advance(role, event) {
    const advanced = advanceAcquisitionControl(this.#states[role], event);
    this.#states[role] = advanced.state;
    return advanced.actions[0] ?? null;
  }

  #notifyPeer(role) {
    const peer = role === "supervisor" ? "watchdog" : "supervisor";
    if (this.#states[role].gate === "revoked" && this.#states[peer].gate !== "revoked") {
      this.#advance(peer, this.#event(peer, "stop", { code: "peer" }));
    }
  }

  /** Revocation is synchronous and never waits behind an outstanding transfer. */
  stop(role, code = "controller") {
    requireAcquisition(!this.#finished, "SESSION_STOPPED");
    requireAcquisition(actors.includes(role), "SESSION_INPUT");
    this.#advance(role, this.#event(role, "stop", { code }));
    this.#notifyPeer(role);
    return this.snapshot();
  }

  #task(operation) {
    if (this.#finished) return Promise.reject(new AcquisitionRecordError("SESSION_STOPPED"));
    if (this.#busy || this.#finishRequested) {
      this.stop("supervisor", "protocol");
      return Promise.reject(new AcquisitionRecordError("SESSION_STOPPED"));
    }
    this.#busy = Promise.resolve().then(operation).finally(() => { this.#busy = null; });
    return this.#busy;
  }

  start() {
    if (this.#finished) return Promise.reject(new AcquisitionRecordError("SESSION_STOPPED"));
    if (this.#started) { this.stop("supervisor", "protocol"); return Promise.reject(new AcquisitionRecordError("SESSION_STOPPED")); }
    this.#started = true;
    return this.#task(this.#start.bind(this));
  }

  async #start() {
    if (!await this.#perform("supervisor", "write_header")) return this.snapshot();
    if (!await this.#perform("supervisor", "read_header")) return this.snapshot();
    if (!await this.#perform("watchdog", "verify_header")) return this.snapshot();
    await this.#perform("supervisor", "peer_ready");
    return this.snapshot();
  }

  #append(input) {
    if (this.#finished) return Promise.reject(new AcquisitionRecordError("SESSION_STOPPED"));
    let data;
    try { data = progressInput(input); }
    catch { this.stop("supervisor", "protocol"); return Promise.reject(new AcquisitionRecordError("SESSION_INPUT")); }
    return this.#task(this.#writeProgress.bind(this, data));
  }

  async #writeProgress(data) {
    await this.#perform("supervisor", "write_progress", data);
    return this.snapshot();
  }

  async #execute(action, payload) {
    const { actor, kind } = action;
    switch (kind) {
      case "write_header": return this.#record.writers.header.write(this.#header);
      case "read_header": this.#headerReadback = await this.#record.readHeader(); return this.#headerReadback;
      case "verify_header": return this.#headerReadback;
      case "peer_ready": return { actor: "watchdog", operationId: this.#states.watchdog.context.operationId,
        phase: "setup", actionId: action.actionId, headerSha256: this.#states.watchdog.context.expectedHeaderSha256 };
      case "write_progress": {
        const record = { recordType: "acq_event_v1", operationId: action.operationId,
          sequence: this.#sequence.toString(), atNs: this.#states.supervisor.lastAtNs, ...payload };
        const written = await this.#record.writers.progress.write(record);
        this.#sequence += 1n;
        return written;
      }
      case "finish_progress": return this.#record.writers.progress.finish();
      case "write_ending": {
        const header = this.#record.writers.header.snapshot();
        const known = actor === "supervisor" ? header.state === "complete" && !header.uncertain : this.#states.watchdog.stage === "bound";
        return this.#record.writers[actor].write(ending(actor, this.#states[actor], known ? header.sha256 : null,
          this.#record.writers.progress.snapshot(), payload));
      }
      case "close_writer": return Promise.all(ownedRoles[actor].map(role => this.#record.writers[role].close()));
      default: throw new AcquisitionRecordError("SESSION_INPUT");
    }
  }

  async #perform(role, effect, payload = null) {
    const state = this.#states[role];
    const action = this.#advance(role, this.#event(role, "request", {
      phase: ACQUISITION_CONTROL_PHASES[effect], actionId: state.nextActionId, effect,
    }));
    if (!action) { this.#notifyPeer(role); return false; }
    let value;
    let ok = true;
    let cause = "storage";
    try {
      value = await this.#execute(action, payload);
      if (["read_header", "verify_header"].includes(effect)) ok = value?.state === "complete"
        && !value.uncertain && value.readBytes === value.confirmedBytes;
      if (effect === "close_writer") ok = value.every(part => part.closeError === null);
    } catch (error) {
      ok = false;
      if (error instanceof AcquisitionRecordError
        && ["INVALID_RECORD", "EVENT_ORDER", "OPERATION_MISMATCH"].includes(error.code)) cause = "protocol";
    }
    this.#advance(role, this.#event(role, "complete", { phase: action.phase, actionId: action.actionId,
      ok, code: ok ? null : cause, bytes: ok && ["read_header", "verify_header"].includes(effect) ? value.bytes : null,
      peer: ok && effect === "peer_ready" ? value : null }));
    this.#notifyPeer(role);
    return ok && (this.#states[role].gate !== "revoked" || ["finish_progress", "write_ending", "close_writer"].includes(effect));
  }

  finish({ observedUtc }) {
    if (this.#finishing) return this.#finishing;
    requireAcquisition(isAcquisitionUtc(observedUtc), "SESSION_INPUT");
    this.#finishRequested = true;
    this.#finishing = this.#finish(observedUtc);
    return this.#finishing;
  }

  async #finish(observedUtc) {
    if (this.#busy) await this.#busy.catch(() => {});
    await this.#perform("supervisor", "finish_progress");
    for (const role of actors) await this.#perform(role, "write_ending", observedUtc);
    for (const role of actors) await this.#perform(role, "close_writer");
    const snapshots = this.#snapshots();
    const parts = {};
    for (const role of Object.keys(ACQUISITION_LIMITS)) {
      try {
        parts[role] = await readAcquisitionPart({ ...this.#source, role,
          destination: this.#source.destinations[role], range: snapshots[role] });
      } catch {
        parts[role] = { bytes: Buffer.alloc(0), state: "unknown", uncertain: true,
          confirmedBytes: snapshots[role].confirmedBytes, readBytes: 0, readError: "COLLECTION_FAILED" };
      }
    }
    let formatComplete = false;
    let formatError = null;
    try { formatComplete = inspectAcquisitionRecord(parts).formatComplete; }
    catch { formatError = "RECORD_ASSOCIATION_FAILED"; }
    this.#collection = Object.freeze({ formatComplete, formatError });
    this.#finished = true;
    return Object.freeze({ ...this.snapshot(), parts: Object.freeze(parts) });
  }

  #snapshots() { return Object.fromEntries(Object.entries(this.#record.writers).map(([role, writer]) => [role, writer.snapshot()])); }

  snapshot() {
    const read = this.#headerReadback;
    return Object.freeze({ actors: Object.freeze({ ...this.#states }), writes: Object.freeze(this.#snapshots()),
      headerReadback: read && Object.freeze({ confirmedBytes: read.confirmedBytes, readBytes: read.readBytes,
        state: read.state, uncertain: read.uncertain, readError: read.readError }),
      mayStart: !this.#finishRequested && actors.every(role => this.#states[role].gate === "ready"
        && this.#states[role].pending === null && this.#states[role].phase !== "close"),
      localClose: Object.freeze(Object.fromEntries(actors.map(role => [role, this.#states[role].localClosed]))),
      collection: this.#collection, externalClosure: "unqualified", releaseAdmission: "unqualified" });
  }
}

/**
 * Open all four destinations before any data; this factory owns them on success.
 * Contexts are independent admitted expectations, clock is a trusted synchronous
 * elapsed-nanosecond port. transfer is the existing trusted FileHandle test seam.
 * No environment, credentials, configuration discovery or import-time effects.
 */
export async function createAcquisitionControlSession({ root, destinations, header,
  supervisorContext, watchdogContext, clock, transfer }) {
  requireAcquisition(typeof clock === "function", "SESSION_INPUT");
  const states = { supervisor: createAcquisitionControl(supervisorContext), watchdog: createAcquisitionControl(watchdogContext) };
  requireAcquisition(states.supervisor.context.role === "supervisor"
    && states.watchdog.context.role === "watchdog", "SESSION_INPUT");
  const stableHeader = Object.freeze(decodeAcquisitionRecord("header", encodeAcquisitionRecord("header", header)));
  const source = { root, destinations: Object.fromEntries(Object.keys(ACQUISITION_LIMITS).map(role => [role,
    { name: destinations?.[role]?.name, identity: { ...destinations?.[role]?.identity } }])) };
  const record = await openAcquisitionRecord({ ...source, ...(transfer === undefined ? {} : { transfer }) });
  return new AcquisitionControlSession(source, record, stableHeader, clock, states);
}
