import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import {
  acquisitionFields as fields, isAcquisitionUint, requireAcquisition, AcquisitionRecordError,
} from "./provenance-acquisition-record.mjs";
import { ownedRoot, identityMatches, openOwnedAcquisitionFile, closeHandles } from "./provenance-acquisition-file-io.mjs";

export const ACQUISITION_PAYLOAD_LIMITS = Object.freeze({ stdout: 1024 * 1024, stderr: 256 * 1024 });
const roles = Object.keys(ACQUISITION_PAYLOAD_LIMITS);
const nativeTransfer = Object.freeze({
  write: (handle, bytes, offset, length, position) => handle.write(bytes, offset, length, position),
  close: handle => handle.close(),
});

function payloadTime(timing, previous, clock) {
  let now;
  try { now = clock(); } catch { throw new AcquisitionRecordError("CAPTURE_CLOCK"); }
  requireAcquisition(typeof now === "bigint" && now >= timing.origin
    && (previous === null || now >= previous), "CAPTURE_CLOCK");
  requireAcquisition(now - timing.origin < timing.deadline, "CAPTURE_DEADLINE");
  return now;
}

function payloadInputs(input) {
  requireAcquisition(fields(input, ["root", "destinations", "t0MonotonicNs", "deadlineNs"])
    && fields(input.destinations, roles) && isAcquisitionUint(input.t0MonotonicNs)
    && isAcquisitionUint(input.deadlineNs) && input.deadlineNs !== "0", "CAPTURE_INPUT");
  const destinations = {};
  for (const role of roles) {
    const d = input.destinations[role];
    requireAcquisition(fields(d, ["name", "identity"]) && fields(d.identity, ["dev", "ino"])
      && isAcquisitionUint(d.identity.dev) && isAcquisitionUint(d.identity.ino) && d.identity.ino !== "0", "CAPTURE_INPUT");
    destinations[role] = { name: d.name, identity: { ...d.identity } };
  }
  return { root: input.root, destinations,
    timing: { origin: BigInt(input.t0MonotonicNs), deadline: BigInt(input.deadlineNs) } };
}

/** Shared identified-file owner. Framing and call scheduling belong to its two adapters. */
class AcquisitionPayloadStore {
  #channels; #timing; #last; #clock; #transfer;
  #state = "pending"; #firstError = null; #closed = false; #closing = null;
  #ioClosed = "open"; #ioPending = 0;

  constructor(parts, timing, last, clock, transfer) {
    this.#channels = Object.fromEntries(roles.map(role => [role, { ...parts[role], submittedBytes: 0, confirmedBytes: 0,
      digest: createHash("sha256"), uncertain: false, firstError: null, closeError: null, complete: false }]));
    this.#timing = timing; this.#last = last; this.#clock = clock; this.#transfer = transfer;
  }

  fail(code, role = null, uncertain = false) {
    this.#firstError ??= code;
    this.#state = this.#firstError === "CAPTURE_LIMIT" ? "limit" : "incomplete";
    if (role) { this.#channels[role].firstError ??= code; this.#channels[role].uncertain ||= uncertain; }
    throw new AcquisitionRecordError(this.#firstError);
  }

  check() {
    if (this.#closed || this.#state !== "pending") throw new AcquisitionRecordError(this.#firstError ?? "CAPTURE_STOPPED");
    try { this.#last = payloadTime(this.#timing, this.#last, this.#clock); }
    catch (error) { this.fail(error.code); }
  }

  remaining(role) { return ACQUISITION_PAYLOAD_LIMITS[role] - this.#channels[role].submittedBytes; }
  complete(role) { return this.#channels[role].complete; }
  get state() { return this.#state; }

  finish(role) {
    this.#channels[role].complete = true;
    if (roles.every(name => this.#channels[name].complete)) this.#state = "complete";
  }

  /** Validated, stable payload only. Caller serializes each role and enforces its allowance. */
  async append(role, bytes) {
    const channel = this.#channels[role];
    channel.submittedBytes += bytes.length;
    let offset = 0;
    while (offset < bytes.length) {
      this.check();
      let result;
      this.#ioPending += 1;
      try { result = await this.#transfer.write(channel.handle, bytes, offset, bytes.length - offset, channel.confirmedBytes); }
      catch { this.fail("WRITE_FAILED", role, true); }
      finally { this.#ioPending -= 1; }
      const count = result?.bytesWritten;
      if (!Number.isInteger(count) || count < 0 || count > bytes.length - offset) this.fail("WRITE_EXTENT_UNKNOWN", role, true);
      if (!count) this.fail("WRITE_NO_PROGRESS", role);
      channel.digest.update(bytes.subarray(offset, offset + count));
      channel.confirmedBytes += count; offset += count;
      // Preserve late confirmed effects without restoring permission or renewing the cutoff.
      this.check();
    }
  }

  stop() {
    if (this.#state === "pending") { this.#firstError ??= "CAPTURE_STOPPED"; this.#state = "incomplete"; }
  }

  async #close(pending) {
    if (pending.length) await Promise.allSettled(pending);
    const results = await Promise.allSettled(roles.map(role => Promise.resolve().then(() => this.#transfer.close(this.#channels[role].handle))));
    for (const [index, result] of results.entries()) if (result.status === "rejected") {
      const channel = this.#channels[roles[index]];
      channel.closeError = "CLOSE_FAILED"; channel.firstError ??= "CLOSE_FAILED";
      this.#firstError ??= "CLOSE_FAILED"; this.#state = "incomplete";
    }
    this.#ioClosed = results.every(result => result.status === "fulfilled") ? "closed" : "unknown";
  }

  /** Adapters pass all borrowed-input work, including decode work not yet at a file await. */
  close(pending) {
    if (this.#closing) return this.#closing;
    this.stop(); this.#closed = true; this.#ioClosed = "pending";
    this.#closing = this.#close(pending);
    return this.#closing;
  }

  snapshot() {
    const channels = Object.fromEntries(roles.map(role => {
      const c = this.#channels[role];
      return [role, Object.freeze({ submittedBytes: c.submittedBytes, confirmedBytes: c.confirmedBytes,
        sha256: c.digest.copy().digest("hex"), uncertain: c.uncertain, firstError: c.firstError, closeError: c.closeError })];
    }));
    return Object.freeze({ state: this.#state, firstError: this.#firstError, channels: Object.freeze(channels),
      lastAtNs: (this.#last - this.#timing.origin).toString(), ioPending: this.#ioPending, ioClosed: this.#ioClosed,
      externalClosure: "unqualified", clockAdmission: "unqualified", releaseAdmission: "unqualified" });
  }
}

/** Internal seam for raw and Docker adapters; not an independently scheduled public writer. */
export async function openAcquisitionPayloadStore(input, { clock = () => process.hrtime.bigint(), transfer = nativeTransfer } = {}) {
  const p = payloadInputs(input);
  requireAcquisition(typeof clock === "function" && transfer && typeof transfer.write === "function"
    && (transfer.close === undefined || typeof transfer.close === "function"), "CAPTURE_INPUT");
  const operations = { write: transfer.write, close: transfer.close ?? nativeTransfer.close };
  let last = payloadTime(p.timing, null, clock);
  const owned = [];
  try {
    const rootIdentity = await ownedRoot(p.root);
    const parts = {};
    const seen = new Set();
    for (const role of roles) {
      parts[role] = await openOwnedAcquisitionFile(p.root, p.destinations[role], ACQUISITION_PAYLOAD_LIMITS[role], owned);
      requireAcquisition(!seen.has(parts[role].identity), "FILE_ALIAS");
      seen.add(parts[role].identity);
    }
    identityMatches(await lstat(p.root, { bigint: true }), rootIdentity);
    last = payloadTime(p.timing, last, clock);
    return Object.freeze(new AcquisitionPayloadStore(parts, p.timing, last, clock, operations));
  } catch (error) {
    const failure = error instanceof AcquisitionRecordError ? error : new AcquisitionRecordError("OPEN_FAILED");
    failure.cleanup = await closeHandles(owned);
    throw failure;
  }
}

/** Raw payload pair: one borrowed Buffer/work item per role, no framing or read-ahead. */
class AcquisitionPayload {
  #store; #busy = { stdout: null, stderr: null }; #closing = null;
  constructor(store) { this.#store = store; }

  async write(role, bytes) {
    if (!roles.includes(role)) this.#store.fail("CAPTURE_INPUT");
    requireAcquisition(!this.#busy[role], "CAPTURE_BUSY");
    this.#store.check();
    if (this.#store.complete(role)) throw new AcquisitionRecordError("CAPTURE_STOPPED");
    if (!Buffer.isBuffer(bytes)) this.#store.fail("CAPTURE_INPUT");
    if (bytes.length > this.#store.remaining(role)) this.#store.fail("CAPTURE_LIMIT", role);
    this.#busy[role] = Promise.resolve().then(() => {
      this.#store.check();
      return this.#store.append(role, bytes);
    }).finally(() => { this.#busy[role] = null; });
    await this.#busy[role];
    return this.snapshot();
  }

  finish(role) {
    if (!roles.includes(role)) this.#store.fail("CAPTURE_INPUT");
    requireAcquisition(!this.#busy[role], "CAPTURE_BUSY");
    if (this.#store.complete(role) && ["pending", "complete"].includes(this.#store.state)) return this.snapshot();
    this.#store.check(); this.#store.finish(role);
    return this.snapshot();
  }

  stop() { this.#store.stop(); return this.snapshot(); }

  close() {
    if (!this.#closing) this.#closing = this.#store.close(Object.values(this.#busy).filter(Boolean)).then(() => this.snapshot());
    return this.#closing;
  }

  snapshot() {
    return Object.freeze({ ...this.#store.snapshot(),
      busy: Object.freeze(Object.fromEntries(roles.map(role => [role, this.#busy[role] !== null]))),
      complete: Object.freeze(Object.fromEntries(roles.map(role => [role, this.#store.complete(role)]))) });
  }
}

/** Existing identified regular reservations only; opening owns no transport/process preparation. */
export async function openAcquisitionPayload(input, ports) {
  return Object.freeze(new AcquisitionPayload(await openAcquisitionPayloadStore(input, ports)));
}
