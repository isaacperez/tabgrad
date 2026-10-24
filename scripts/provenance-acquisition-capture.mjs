import { setImmediate as yieldTurn } from "node:timers/promises";
import { requireAcquisition } from "./provenance-acquisition-record.mjs";
import { ACQUISITION_PAYLOAD_LIMITS, openAcquisitionPayloadStore } from "./provenance-acquisition-payload.mjs";

export const ACQUISITION_CAPTURE_LIMITS = ACQUISITION_PAYLOAD_LIMITS;

/** Owns Docker framing and serial calls over the shared identified-file writer. */
class AcquisitionCapture {
  #store; #header = Buffer.alloc(8); #headerUsed = 0;
  #role = null; #remaining = 0; #busy = null; #closing = null; #onPayload;

  constructor(store, onPayload) { this.#store = store; this.#onPayload = onPayload; }

  #frame() {
    const type = this.#header[0];
    if (![1, 2].includes(type) || this.#header[1] || this.#header[2] || this.#header[3]) this.#store.fail("CAPTURE_PROTOCOL");
    const role = type === 1 ? "stdout" : "stderr";
    const length = this.#header.readUInt32BE(4);
    if (length > this.#store.remaining(role)) this.#store.fail("CAPTURE_LIMIT", role);
    this.#role = role; this.#remaining = length;
  }

  async #consume(bytes) {
    let offset = 0;
    this.#store.check();
    while (offset < bytes.length) {
      this.#store.check();
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
          this.#store.check();
          continue;
        }
      }
      const count = Math.min(this.#remaining, bytes.length - offset);
      if (!count) continue;
      const payload = bytes.subarray(offset, offset + count);
      offset += count; this.#remaining -= count;
      const writing = this.#store.append(this.#role, payload);
      // Observe actual submission here, irrespective of earlier empty-frame
      // yields or chunk boundaries, without abandoning the borrowed write.
      try { this.#onPayload?.(); } finally { await writing; }
      if (!this.#remaining) { this.#headerUsed = 0; this.#role = null; }
    }
  }

  /** Borrow an immutable Buffer until settlement; caller awaits each call, no queue. */
  async write(bytes) {
    requireAcquisition(!this.#busy, "CAPTURE_BUSY");
    this.#store.check();
    if (!Buffer.isBuffer(bytes)) this.#store.fail("CAPTURE_INPUT");
    this.#busy = Promise.resolve().then(() => this.#consume(bytes)).finally(() => { this.#busy = null; });
    await this.#busy;
    return this.snapshot();
  }

  finish() {
    requireAcquisition(!this.#busy, "CAPTURE_BUSY");
    if (this.#store.state === "complete") return this.snapshot();
    this.#store.check();
    if (this.#headerUsed || this.#role !== null) this.#store.fail("CAPTURE_TRUNCATED");
    this.#store.finish("stdout"); this.#store.finish("stderr");
    return this.snapshot();
  }

  stop() { this.#store.stop(); return this.snapshot(); }

  close() {
    if (!this.#closing) this.#closing = this.#store.close(this.#busy ? [this.#busy] : []).then(() => this.snapshot());
    return this.#closing;
  }

  snapshot() {
    const stored = this.#store.snapshot();
    const channels = Object.fromEntries(Object.entries(stored.channels).map(([role, c]) => {
      const { submittedBytes, ...confirmed } = c;
      return [role, Object.freeze({ receivedBytes: submittedBytes, ...confirmed })];
    }));
    return Object.freeze({ state: stored.state, firstError: stored.firstError, channels: Object.freeze(channels),
      lastAtNs: stored.lastAtNs, headerBytes: this.#headerUsed, pendingFrameBytes: this.#remaining,
      busy: this.#busy !== null, ioPending: stored.ioPending, ioClosed: stored.ioClosed,
      externalClosure: stored.externalClosure, clockAdmission: stored.clockAdmission, releaseAdmission: stored.releaseAdmission });
  }
}

/** Existing identified reservations only; no create/truncate/append, transport or native preparation. */
export async function openAcquisitionCapture(input, ports = {}) {
  return Object.freeze(new AcquisitionCapture(await openAcquisitionPayloadStore(input, ports)));
}

/** Internal decoder for an already owned store; it performs no opening. */
export function createAcquisitionCapture(store, onPayload) {
  requireAcquisition(onPayload === undefined || typeof onPayload === "function", "CAPTURE_INPUT");
  return Object.freeze(new AcquisitionCapture(store, onPayload));
}
