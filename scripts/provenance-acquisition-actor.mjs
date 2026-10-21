import { AcquisitionRecordError } from "./provenance-acquisition-record.mjs";
import { ACQUISITION_ACTOR_PARTS } from "./provenance-acquisition-record-io.mjs";
import { ACQUISITION_CONTROL_PHASES, createAcquisitionControl, advanceAcquisitionControl } from "./provenance-acquisition-control.mjs";

function ending(role, state, headerHash, progress, observedUtc, peer, clientAttempted) {
  const failure = state.firstFailure;
  const stopCode = failure?.code === "clock" ? "controller" : failure?.code === "peer" ? "observer" : failure?.code ?? "normal";
  const common = { recordType: `acq_${role}_end_v1`, operationId: state.context.operationId,
    headerSha256: headerHash, atNs: state.lastAtNs, observedUtc, phaseReached: "close", stopCode,
    firstStopAtNs: failure?.atNs ?? null, observationEvidenceSha256: null };
  if (role === "watchdog") return { ...common, peerState: peer?.state ?? "unknown", peerObservedAtNs: peer?.atNs ?? null,
    containmentState: "unconfirmed", containmentAtNs: null, caseEmptyState: "unknown",
    lifecycleState: "unknown", helperClosureState: "unknown" };
  return { ...common, clientState: clientAttempted ? "unknown" : "not_started", clientExitCode: null, clientSignal: null,
    stdoutState: "unknown", stdoutReceivedBytes: null, stdoutConfirmedBytes: null, stdoutSha256: null,
    stderrState: "unknown", stderrReceivedBytes: null, stderrConfirmedBytes: null, stderrSha256: null,
    progressState: progress.state === "pending" ? "incomplete" : progress.state,
    progressConfirmedBytes: String(progress.confirmedBytes), progressSha256: progress.sha256,
    preflightState: "unknown", preflightEvidenceSha256: null, validationState: "not_run", validationEvidenceSha256: null,
    inputWritersState: "unknown", lifecycleState: "unknown", caseClosureState: "unknown", helperClosureState: "unknown",
    guardsState: "unknown", guardsEvidenceSha256: null, resultEvidenceSha256: null, applicableExpiryUtc: null,
    payloadCustodyState: "unknown", payloadCustodyEvidenceSha256: null };
}

/** One actor's state and owned effects, shared by local and process composition. */
export class AcquisitionActor {
  #record; #header; #clock; #state; #sequence = 1n; #headerReadback = null;
  #clientAttempted = false;

  constructor({ context, record, header = null, clock }) {
    this.#state = createAcquisitionControl(context);
    this.#record = record; this.#header = header; this.#clock = clock;
  }

  get state() { return this.#state; }
  get headerReadback() { return this.#headerReadback; }
  writes() { return Object.fromEntries(ACQUISITION_ACTOR_PARTS[this.#state.context.role]
    .map(role => [role, this.#record.writers[role].snapshot()])); }
  now() { try { return this.#clock(); } catch { return null; } }

  #event(kind, fields) {
    return { kind, actor: this.#state.context.role, operationId: this.#state.context.operationId,
      phase: this.#state.phase, actionId: null, atNs: this.now(), ...fields };
  }

  #advance(event) {
    const result = advanceAcquisitionControl(this.#state, event);
    this.#state = result.state;
    return result.actions[0] ?? null;
  }

  stop(code = "controller") { this.#advance(this.#event("stop", { code })); }
  tick() { this.#advance(this.#event("tick", {})); }

  async #execute(effect, payload) {
    const role = this.#state.context.role;
    switch (effect) {
      case "write_header": return this.#record.writers.header.write(this.#header);
      case "read_header": this.#headerReadback = await this.#record.readHeader(); return this.#headerReadback;
      case "verify_header": return payload;
      case "peer_ready": return payload;
      case "write_progress": {
        // Keep an ending conservative even if this intent's write/ack later fails.
        if (payload.phase === "acquire" && payload.kind === "transition"
          && payload.subject === "client" && payload.code === "begun") this.#clientAttempted = true;
        const record = { recordType: "acq_event_v1", operationId: this.#state.context.operationId,
          sequence: this.#sequence.toString(), atNs: this.#state.lastAtNs, ...payload };
        const written = await this.#record.writers.progress.write(record);
        this.#sequence += 1n;
        return written;
      }
      case "finish_progress": return this.#record.writers.progress.finish();
      case "write_ending": {
        const header = this.#record.writers.header?.snapshot();
        const known = role === "supervisor" ? header.state === "complete" && !header.uncertain : this.#state.stage === "bound";
        return this.#record.writers[role].write(ending(role, this.#state,
          known ? (role === "supervisor" ? header.sha256 : this.#state.context.expectedHeaderSha256) : null,
          this.#record.writers.progress?.snapshot(),
          payload.observedUtc, payload.peer, this.#clientAttempted));
      }
      case "close_writer": return Promise.all(ACQUISITION_ACTOR_PARTS[role].map(part => this.#record.writers[part].close()));
      default: throw new AcquisitionRecordError("SESSION_INPUT");
    }
  }

  async perform(effect, payload = null) {
    const action = this.#advance(this.#event("request", {
      phase: ACQUISITION_CONTROL_PHASES[effect], actionId: this.#state.nextActionId, effect,
    }));
    if (!action) return { ok: false, value: null };
    let value = null;
    let ok = true;
    let cause = "storage";
    try {
      value = await this.#execute(effect, payload);
      if (["read_header", "verify_header"].includes(effect)) ok = value?.state === "complete"
        && !value.uncertain && value.readBytes === value.confirmedBytes;
      if (effect === "close_writer") ok = value.every(part => part.closeError === null);
    } catch (error) {
      ok = false;
      if (error instanceof AcquisitionRecordError
        && ["INVALID_RECORD", "EVENT_ORDER", "OPERATION_MISMATCH"].includes(error.code)) cause = "protocol";
    }
    this.#advance(this.#event("complete", { phase: action.phase, actionId: action.actionId,
      ok, code: ok ? null : cause, bytes: ok && ["read_header", "verify_header"].includes(effect) ? value.bytes : null,
      peer: ok && effect === "peer_ready" ? value : null }));
    return { ok: ok && (this.#state.gate !== "revoked" || ["finish_progress", "write_ending", "close_writer"].includes(effect)), value };
  }
}
