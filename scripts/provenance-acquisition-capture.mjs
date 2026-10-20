import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { setImmediate as yieldTurn } from "node:timers/promises";
import {
  acquisitionFields as fields, isAcquisitionUint, requireAcquisition, AcquisitionRecordError,
} from "./provenance-acquisition-record.mjs";
import { ownedRoot, identityMatches, openOwnedAcquisitionFile, closeHandles } from "./provenance-acquisition-file-io.mjs";

export const ACQUISITION_CAPTURE_LIMITS = Object.freeze({ stdout: 1024 * 1024, stderr: 256 * 1024 });
const roles = Object.keys(ACQUISITION_CAPTURE_LIMITS);
const nativeTransfer = Object.freeze({
  write: (handle, bytes, offset, length, position) => handle.write(bytes, offset, length, position),
  close: handle => handle.close(),
});

function captureTime(timing, previous, clock) {
  let now;
  try { now = clock(); } catch { throw new AcquisitionRecordError("CAPTURE_CLOCK"); }
  requireAcquisition(typeof now === "bigint" && now >= timing.origin
    && (previous === null || now >= previous), "CAPTURE_CLOCK");
  requireAcquisition(now - timing.origin < timing.deadline, "CAPTURE_DEADLINE");
  return now;
}

function captureInputs(input) {
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

/** Owns binary framing and confirmed writes only; no client/transport/lifecycle admission. */
class AcquisitionCapture {
  #channels; #timing; #last; #clock; #transfer; #header = Buffer.alloc(8); #headerUsed = 0;
  #role = null; #remaining = 0; #state = "pending"; #firstError = null; #busy = null;
  #closing = null; #closed = false; #ioClosed = "open"; #ioPending = 0;

  constructor(parts, timing, last, clock, transfer) {
    this.#channels = Object.fromEntries(roles.map(role => [role, { ...parts[role], receivedBytes: 0, confirmedBytes: 0,
      digest: createHash("sha256"), uncertain: false, firstError: null, closeError: null }]));
    this.#timing = timing; this.#last = last; this.#clock = clock; this.#transfer = transfer;
  }

  #fail(code, role = null, uncertain = false) {
    this.#firstError ??= code;
    this.#state = this.#firstError === "CAPTURE_LIMIT" ? "limit" : "incomplete";
    if (role) { this.#channels[role].firstError ??= code; this.#channels[role].uncertain ||= uncertain; }
    throw new AcquisitionRecordError(this.#firstError);
  }

  #active() {
    if (this.#closed || this.#state !== "pending") throw new AcquisitionRecordError(this.#firstError ?? "CAPTURE_STOPPED");
    try { this.#last = captureTime(this.#timing, this.#last, this.#clock); }
    catch (error) { this.#fail(error.code); }
  }

  #frame() {
    const type = this.#header[0];
    if (![1, 2].includes(type) || this.#header[1] || this.#header[2] || this.#header[3]) this.#fail("CAPTURE_PROTOCOL");
    const role = type === 1 ? "stdout" : "stderr";
    const length = this.#header.readUInt32BE(4);
    if (length > ACQUISITION_CAPTURE_LIMITS[role] - this.#channels[role].receivedBytes) this.#fail("CAPTURE_LIMIT", role);
    this.#role = role; this.#remaining = length;
  }

  async #payload(role, bytes) {
    const channel = this.#channels[role];
    channel.receivedBytes += bytes.length;
    let offset = 0;
    while (offset < bytes.length) {
      this.#active();
      let result;
      this.#ioPending = 1;
      try { result = await this.#transfer.write(channel.handle, bytes, offset, bytes.length - offset, channel.confirmedBytes); }
      catch { this.#fail("WRITE_FAILED", role, true); }
      finally { this.#ioPending = 0; }
      const count = result?.bytesWritten;
      if (!Number.isInteger(count) || count < 0 || count > bytes.length - offset) this.#fail("WRITE_EXTENT_UNKNOWN", role, true);
      if (!count) this.#fail("WRITE_NO_PROGRESS", role);
      channel.digest.update(bytes.subarray(offset, offset + count));
      channel.confirmedBytes += count; offset += count;
      // A late confirmed effect is recorded, but cannot reverse stop or extend the original deadline.
      this.#active();
    }
  }

  async #consume(bytes) {
    let offset = 0;
    this.#active();
    while (offset < bytes.length) {
      this.#active();
      if (this.#headerUsed < 8) {
        const count = Math.min(8 - this.#headerUsed, bytes.length - offset);
        bytes.copy(this.#header, this.#headerUsed, offset, offset + count);
        this.#headerUsed += count; offset += count;
        if (this.#headerUsed < 8) continue;
        this.#frame();
        if (!this.#remaining) {
          this.#headerUsed = 0; this.#role = null;
          // Empty frames have no filesystem await; do not let them starve cancellation.
          await yieldTurn();
          this.#active();
          continue;
        }
      }
      const count = Math.min(this.#remaining, bytes.length - offset);
      if (!count) continue;
      const payload = bytes.subarray(offset, offset + count);
      offset += count; this.#remaining -= count;
      await this.#payload(this.#role, payload);
      if (!this.#remaining) { this.#headerUsed = 0; this.#role = null; }
    }
  }

  /** Borrow an immutable Buffer until settlement; caller awaits each call, no queue. */
  async write(bytes) {
    requireAcquisition(!this.#busy, "CAPTURE_BUSY");
    this.#active();
    if (!Buffer.isBuffer(bytes)) this.#fail("CAPTURE_INPUT");
    this.#busy = Promise.resolve().then(() => this.#consume(bytes)).finally(() => { this.#busy = null; });
    await this.#busy;
    return this.snapshot();
  }

  finish() {
    requireAcquisition(!this.#busy, "CAPTURE_BUSY");
    if (this.#state === "complete") return this.snapshot();
    this.#active();
    if (this.#headerUsed || this.#role !== null) this.#fail("CAPTURE_TRUNCATED");
    this.#state = "complete";
    return this.snapshot();
  }

  stop() {
    if (this.#state === "pending") { this.#firstError ??= "CAPTURE_STOPPED"; this.#state = "incomplete"; }
    return this.snapshot();
  }

  async #close() {
    if (this.#busy) await this.#busy.catch(() => {});
    const results = await Promise.allSettled(roles.map(role => Promise.resolve().then(() => this.#transfer.close(this.#channels[role].handle))));
    for (const [index, result] of results.entries()) if (result.status === "rejected") {
      const channel = this.#channels[roles[index]];
      channel.closeError = "CLOSE_FAILED"; channel.firstError ??= "CLOSE_FAILED";
      this.#firstError ??= "CLOSE_FAILED"; this.#state = "incomplete";
    }
    this.#ioClosed = results.every(result => result.status === "fulfilled") ? "closed" : "unknown";
    return this.snapshot();
  }

  close() {
    if (this.#closing) return this.#closing;
    this.stop(); this.#closed = true; this.#ioClosed = "pending";
    this.#closing = this.#close();
    return this.#closing;
  }

  snapshot() {
    const channels = Object.fromEntries(roles.map(role => {
      const c = this.#channels[role];
      return [role, Object.freeze({ receivedBytes: c.receivedBytes, confirmedBytes: c.confirmedBytes,
        sha256: c.digest.copy().digest("hex"), uncertain: c.uncertain, firstError: c.firstError, closeError: c.closeError })];
    }));
    return Object.freeze({ state: this.#state, firstError: this.#firstError, channels: Object.freeze(channels),
      lastAtNs: (this.#last - this.#timing.origin).toString(), headerBytes: this.#headerUsed,
      pendingFrameBytes: this.#remaining, busy: this.#busy !== null, ioPending: this.#ioPending, ioClosed: this.#ioClosed,
      externalClosure: "unqualified", clockAdmission: "unqualified", releaseAdmission: "unqualified" });
  }
}

/** Existing identified reservations only; no create/truncate/append, transport or native preparation. */
export async function openAcquisitionCapture(input, { clock = () => process.hrtime.bigint(), transfer = nativeTransfer } = {}) {
  const p = captureInputs(input);
  requireAcquisition(typeof clock === "function" && transfer && typeof transfer.write === "function"
    && (transfer.close === undefined || typeof transfer.close === "function"), "CAPTURE_INPUT");
  const operations = { write: transfer.write, close: transfer.close ?? nativeTransfer.close };
  let last = captureTime(p.timing, null, clock);
  const owned = [];
  try {
    const rootIdentity = await ownedRoot(p.root);
    const parts = {};
    const seen = new Set();
    for (const role of roles) {
      parts[role] = await openOwnedAcquisitionFile(p.root, p.destinations[role], ACQUISITION_CAPTURE_LIMITS[role], owned);
      requireAcquisition(!seen.has(parts[role].identity), "FILE_ALIAS");
      seen.add(parts[role].identity);
    }
    identityMatches(await lstat(p.root, { bigint: true }), rootIdentity);
    last = captureTime(p.timing, last, clock);
    return Object.freeze(new AcquisitionCapture(parts, p.timing, last, clock, operations));
  } catch (error) {
    const failure = error instanceof AcquisitionRecordError ? error : new AcquisitionRecordError("OPEN_FAILED");
    failure.cleanup = await closeHandles(owned);
    throw failure;
  }
}
