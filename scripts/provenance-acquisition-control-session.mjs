import {
  AcquisitionRecordError, ACQUISITION_LIMITS, encodeAcquisitionRecord, decodeAcquisitionRecord,
  inspectAcquisitionRecord, requireAcquisition, isAcquisitionUtc,
} from "./provenance-acquisition-record.mjs";
import { openAcquisitionRecord, readAcquisitionPart } from "./provenance-acquisition-record-io.mjs";
import { createAcquisitionControl } from "./provenance-acquisition-control.mjs";
import { AcquisitionActor } from "./provenance-acquisition-actor.mjs";

const actors = ["supervisor", "watchdog"];

function progressInput(input) {
  const keys = ["phase", "kind", "subject", "code", "reference", "value"];
  requireAcquisition(input !== null && typeof input === "object"
    && [Object.prototype, null].includes(Object.getPrototypeOf(input)), "SESSION_INPUT");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  requireAcquisition(Reflect.ownKeys(input).length === keys.length && keys.every(key => descriptors[key]
    && Object.hasOwn(descriptors[key], "value") && descriptors[key].enumerable), "SESSION_INPUT");
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}

/** Local composition only. No process, timer, transport, clock admission or signer. */
class AcquisitionControlSession {
  #source; #record; #actors; #busy = null; #finishing = null; #finishRequested = false;
  #started = false; #finished = false; #collection = null;

  constructor(source, record, header, clock, states) {
    this.#source = source; this.#record = record;
    this.#actors = Object.fromEntries(actors.map(role => [role,
      new AcquisitionActor({ context: states[role].context, record, header, clock })]));
    this.supervisor = Object.freeze({ append: this.#append.bind(this) });
  }

  #notifyPeer(role) {
    const peer = role === "supervisor" ? "watchdog" : "supervisor";
    if (this.#actors[role].state.gate === "revoked" && this.#actors[peer].state.gate !== "revoked") this.#actors[peer].stop("peer");
  }

  /** Revocation is synchronous and never waits behind an outstanding transfer. */
  stop(role, code = "controller") {
    requireAcquisition(!this.#finished, "SESSION_STOPPED");
    requireAcquisition(actors.includes(role), "SESSION_INPUT");
    this.#actors[role].stop(code);
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
    if (!await this.#perform("watchdog", "verify_header", this.#actors.supervisor.headerReadback)) return this.snapshot();
    const state = this.#actors.supervisor.state;
    await this.#perform("supervisor", "peer_ready", { actor: "watchdog",
      operationId: this.#actors.watchdog.state.context.operationId, phase: "setup",
      actionId: state.nextActionId, headerSha256: this.#actors.watchdog.state.context.expectedHeaderSha256 });
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

  async #perform(role, effect, payload = null) {
    const { ok } = await this.#actors[role].perform(effect, payload);
    this.#notifyPeer(role);
    return ok;
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
    for (const role of actors) await this.#perform(role, "write_ending", { observedUtc });
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
    const read = this.#actors.supervisor.headerReadback;
    const states = Object.fromEntries(actors.map(role => [role, this.#actors[role].state]));
    return Object.freeze({ actors: Object.freeze(states), writes: Object.freeze(this.#snapshots()),
      headerReadback: read && Object.freeze({ confirmedBytes: read.confirmedBytes, readBytes: read.readBytes,
        state: read.state, uncertain: read.uncertain, readError: read.readError }),
      mayStart: !this.#finishRequested && actors.every(role => states[role].gate === "ready"
        && states[role].pending === null && states[role].phase !== "close"),
      localClose: Object.freeze(Object.fromEntries(actors.map(role => [role, states[role].localClosed]))),
      collection: this.#collection, externalClosure: "unqualified", releaseAdmission: "unqualified" });
  }
}

/** Open all four destinations before data. Contexts and clock are trusted ports. */
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
