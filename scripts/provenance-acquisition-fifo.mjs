import { acquisitionFields as fields, requireAcquisition } from "./provenance-acquisition-record.mjs";
import { FIFO_ROLES as roles, FIFO_LIMITS, copyFifoProfile } from "./provenance-acquisition-fifo-profile.mjs";
import { fifoNativePorts, verifyFifoStat } from "./provenance-acquisition-fifo-io.mjs";

const again = Symbol("would-block");
const unqualified = Object.freeze({ payloadOrigin: "unqualified", externalClosure: "unqualified",
  clockAdmission: "unqualified", releaseAdmission: "unqualified" });

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function copyPorts(ports) {
  requireAcquisition(ports && Object.getPrototypeOf(ports) === Object.prototype, "FIFO_INPUT");
  const descriptors = Object.getOwnPropertyDescriptors(ports);
  requireAcquisition(Reflect.ownKeys(ports).every(key => Object.hasOwn(fifoNativePorts, key)
    && Object.hasOwn(descriptors[key], "value") && descriptors[key].enumerable
    && typeof descriptors[key].value === "function"), "FIFO_INPUT");
  return { ...fifoNativePorts, ...ports };
}

function newSlot() {
  return { handle: null, state: "not_opened", verified: false, closeWait: null };
}

/** Returns control before native opening; this owner neither creates IPC nor owns its sinks. */
export function createAcquisitionFifos(input, ports = {}) {
  return Object.freeze(new AcquisitionFifos(copyFifoProfile(input), copyPorts(ports)));
}

class AcquisitionFifos {
  #profile; #ports; #channels; #firstError = null; #cleanupError = null; #last = null;
  #openWait = null; #drainWait = null; #closeWait = null; #releaseWait = null;
  #opening = false; #openDone = false; #prepared = false; #pumpsDone = false;
  #releaseRequested = false; #closeRequested = false; #finished = false; #waitExpired = false;
  #pending = 0; #workTimer = null; #closeTimer = null;

  constructor(profile, ports) {
    this.#profile = profile; this.#ports = ports;
    this.#channels = Object.fromEntries(roles.map(role => [role, { reader: newSlot(), sentinel: newSlot(),
      readBytes: 0, submittedBytes: 0, readUncertain: false, sinkFailed: false, overflow: false, eof: false,
      readPending: false, sinkPending: false, pause: null, buffer: null, sink: null }]));
  }

  #sample() {
    try {
      const now = this.#ports.clock();
      requireAcquisition(typeof now === "bigint", "FIFO_CLOCK");
      const elapsed = now - BigInt(this.#profile.timing.t0MonotonicNs);
      requireAcquisition(elapsed >= 0n && elapsed <= 0xffffffffffffffffn
        && (this.#last === null || elapsed >= this.#last), "FIFO_CLOCK");
      this.#last = elapsed;
      return elapsed;
    } catch {
      this.#fail("FIFO_CLOCK", "FIFO_CLOCK");
      // A broken clock cannot authenticate another local wait. Return failure while
      // retaining pending handles/effects; their late results remain observable.
      this.#finishWait();
      return null;
    }
  }

  #check(work, limitPrefix = false) {
    const at = this.#sample();
    if (at === null) return false;
    if (at >= BigInt(this.#profile.timing.closeUntilNs)) { this.#expire(); return false; }
    if (work && at >= BigInt(this.#profile.timing.workUntilNs)) { this.#fail("FIFO_DEADLINE"); return false; }
    return !this.#waitExpired && (!work || (!this.#closeRequested
      && (!this.#firstError || (limitPrefix && this.#firstError === "FIFO_LIMIT"))));
  }

  #fail(code, cleanup = null) {
    this.#firstError ??= code;
    this.#cleanupError ??= cleanup;
    this.#shutdown();
  }

  #cancel(timer) {
    if (timer === null) return;
    try { this.#ports.cancel(timer); } catch { this.#fail("FIFO_TIMER", "FIFO_TIMER"); }
  }

  #arm(work) {
    if (this.#finished || this.#waitExpired || (!work && this.#closeTimer !== null)) return;
    const at = this.#sample();
    if (at === null) return;
    const until = BigInt(this.#profile.timing[work ? "workUntilNs" : "closeUntilNs"]);
    if (at >= until) { if (work) this.#fail("FIFO_DEADLINE"); else this.#expire(); return; }
    try {
      const timer = this.#ports.schedule(() => {
        if (work) this.#workTimer = null; else this.#closeTimer = null;
        if (this.#finished) return;
        if (work && this.#workComplete()) return;
        if (this.#check(work)) this.#arm(work); // Early callback: retain the original absolute cutoff.
      }, Number((until - at + 999999n) / 1000000n));
      if (work) this.#workTimer = timer; else this.#closeTimer = timer;
    } catch { this.#fail("FIFO_TIMER", "FIFO_TIMER"); }
  }

  #expire() {
    this.#waitExpired = true;
    this.#fail("FIFO_DEADLINE", "FIFO_DEADLINE");
    this.#finishWait();
  }

  /** Adopt/classify the native result before the next clock callback can change permission. */
  async #effect(operation, code, observe = null, work = true) {
    this.#pending++;
    let ok = false; let value;
    try { value = await operation(); ok = true; } catch { /* Closed failure recorded below, never native diagnostics. */ }
    try { if (observe) value = observe(ok, value); }
    catch { ok = false; }
    if (!ok) this.#fail(code, work ? null : code);
    this.#pending--;
    this.#check(work);
    this.#progress();
    return { ok, value };
  }

  #closeSlot(role, kind) {
    const slot = this.#channels[role][kind];
    if (!slot.handle || slot.closeWait) return;
    slot.closeWait = deferred(); slot.state = "closing";
    const handle = slot.handle;
    void this.#effect(() => this.#ports.close(handle), "FIFO_CLOSE", ok => {
      slot.state = ok ? "closed" : "unknown";
      if (ok) slot.handle = null;
      if (kind === "sentinel") this.#wake(role);
    }, false).then(() => { slot.closeWait.resolve(); this.#progress(); });
  }

  #beginRelease() {
    this.#releaseRequested = true;
    this.#releaseWait ??= deferred();
    for (const role of roles) this.#closeSlot(role, "sentinel");
    this.#progress();
  }

  #shutdown() {
    this.#closeRequested = true;
    this.#beginRelease();
    for (const role of roles) {
      this.#channels[role].sink = null;
      this.#wake(role);
      this.#closeSlot(role, "reader");
    }
    this.#progress();
  }

  async #openEndpoint(role, kind) {
    if (!this.#check(true)) return;
    const slot = this.#channels[role][kind];
    slot.state = "opening";
    const opened = await this.#effect(() => this.#ports.open(this.#profile.ipc[role].path, kind), "FIFO_OPEN", (ok, handle) => {
      slot.state = ok ? "open" : "unknown";
      if (ok) {
        slot.handle = handle;
        if (this.#closeRequested || (kind === "sentinel" && this.#releaseRequested)) this.#closeSlot(role, kind);
      }
    });
    if (!opened.ok || !this.#check(true)) return;
    const handle = slot.handle;
    await this.#effect(() => handle.stat({ bigint: true }), "FIFO_IDENTITY", (ok, stat) => {
      if (ok) { verifyFifoStat(stat, this.#profile.ipc[role].identity); slot.verified = true; }
    });
  }

  async #prepare() {
    if (!this.#check(true)) return;
    await this.#effect(() => this.#ports.root(this.#profile.ipc.root), "FIFO_ROOT");
    for (const kind of ["reader", "sentinel"]) for (const role of roles) {
      if (!this.#check(true)) return;
      await this.#openEndpoint(role, kind);
    }
    if (!this.#check(true)) return;
    await this.#effect(() => this.#ports.root(this.#profile.ipc.root), "FIFO_ROOT");
    if (this.#check(true)) this.#prepared = true;
  }

  open() {
    if (this.#openWait) return this.#openWait.promise;
    this.#openWait = deferred();
    if (this.#closeRequested || this.#finished) { this.#openDone = true; this.#progress(); return this.#openWait.promise; }
    this.#opening = true;
    this.#arm(true); this.#arm(false);
    void this.#prepare().catch(() => this.#fail("FIFO_OPEN")).finally(() => {
      this.#opening = false; this.#openDone = true; this.#progress();
    });
    return this.#openWait.promise;
  }

  #wake(role) {
    const c = this.#channels[role];
    if (!c.pause) return;
    const pause = c.pause; c.pause = null;
    this.#cancel(pause.timer); pause.resolve();
  }

  #pause(role, idle) {
    if (!this.#check(true)) return Promise.resolve();
    const c = this.#channels[role];
    const wait = deferred(); const pause = { ...wait, timer: null };
    c.pause = pause;
    const remaining = BigInt(this.#profile.timing.workUntilNs) - this.#last;
    const ms = idle ? Number((remaining + 999999n) / 1000000n) : 0;
    try {
      pause.timer = this.#ports.schedule(() => {
        if (c.pause === pause) { c.pause = null; pause.resolve(); }
      }, Math.min(this.#profile.timing.pollMs, ms));
    } catch { this.#fail("FIFO_TIMER", "FIFO_TIMER"); }
    return wait.promise;
  }

  async #read(role, length) {
    const c = this.#channels[role];
    try { return await this.#ports.read(c.reader.handle, c.buffer, length); }
    catch (error) { if (["EAGAIN", "EWOULDBLOCK"].includes(error?.code)) return again; throw error; }
  }

  #readResult(role, length, ok, result) {
    const c = this.#channels[role]; c.readPending = false;
    if (ok && result === again) return again;
    c.readUncertain = true;
    if (!ok) return null;
    const count = result?.bytesRead;
    if (!Number.isInteger(count) || count < 0 || count > length) { this.#fail("FIFO_READ_EXTENT"); return null; }
    c.readUncertain = false; c.readBytes += count;
    const overflow = count > FIFO_LIMITS[role].capacity - c.submittedBytes;
    const limitPrefix = overflow && this.#firstError === null;
    if (overflow) c.overflow = true;
    if (limitPrefix) this.#firstError = "FIFO_LIMIT";
    if (count === 0 && this.#releaseRequested && c.sentinel.state === "closed") c.eof = true;
    return { count, limitPrefix };
  }

  async #pump(role) {
    const c = this.#channels[role];
    try {
      while (this.#check(true)) {
        const remaining = FIFO_LIMITS[role].capacity - c.submittedBytes;
        const length = Math.min(FIFO_LIMITS[role].quantum, remaining + 1);
        c.readPending = true;
        const read = await this.#effect(() => this.#read(role, length), "FIFO_READ",
          (ok, result) => this.#readResult(role, length, ok, result));
        // Only the first overflow read may submit its already-read allowed prefix.
        // It still needs a valid clock and no intervening stop/deadline/cleanup.
        if (!read.ok || !this.#check(true, read.value?.limitPrefix)) return;
        if (read.value === again || (read.value.count === 0 && !c.eof)) { await this.#pause(role, true); continue; }
        if (c.eof) { this.#closeSlot(role, "reader"); return; }
        const allowed = Math.min(read.value.count, remaining);
        const overflow = read.value.count > remaining;
        let delivery;
        if (allowed) {
          const sink = c.sink; const bytes = c.buffer.subarray(0, allowed);
          c.submittedBytes += allowed; c.sinkPending = true;
          delivery = this.#effect(() => sink(bytes), "FIFO_SINK", ok => { c.sinkPending = false; c.sinkFailed ||= !ok; });
        }
        if (overflow) this.#shutdown();
        if (delivery) await delivery;
        if (!this.#check(true)) return;
        await this.#pause(role, false);
      }
    } finally { c.sink = null; c.buffer = null; }
  }

  drain(sinks) {
    if (this.#drainWait) return this.#drainWait.promise;
    requireAcquisition(this.#prepared && !this.#closeRequested && !this.#finished, "FIFO_STATE");
    requireAcquisition(fields(sinks, roles) && roles.every(role => typeof sinks[role] === "function"), "FIFO_INPUT");
    this.#drainWait = deferred();
    for (const role of roles) {
      this.#channels[role].sink = sinks[role];
      this.#channels[role].buffer = Buffer.alloc(FIFO_LIMITS[role].quantum);
    }
    void Promise.allSettled(roles.map(role => this.#pump(role))).then(results => {
      if (results.some(r => r.status === "rejected")) this.#fail("FIFO_READ");
      this.#pumpsDone = true; this.#progress();
    });
    return this.#drainWait.promise;
  }

  releaseSentinels() {
    requireAcquisition(this.#prepared || this.#releaseRequested, "FIFO_STATE");
    this.#beginRelease();
    return this.#releaseWait.promise;
  }

  stop() { if (!this.#finished) this.#fail("FIFO_STOPPED"); return this.snapshot(); }

  close() {
    if (this.#closeWait) return this.#closeWait.promise;
    this.#closeWait = deferred();
    if (!this.#finished) {
      if (!this.#workComplete()) this.#fail("FIFO_STOPPED"); else this.#shutdown();
    }
    this.#progress();
    return this.#closeWait.promise;
  }

  #workComplete() { return this.#drainWait !== null && roles.every(role => this.#channels[role].eof); }
  #slots() { return roles.flatMap(role => [this.#channels[role].reader, this.#channels[role].sentinel]); }
  #settled(slots) { return slots.every(s => ["not_opened", "closed", "unknown"].includes(s.state)); }

  #finishWait() {
    if (!this.#finished) {
      this.#finished = true;
      const work = this.#workTimer; const close = this.#closeTimer;
      this.#workTimer = null; this.#closeTimer = null;
      this.#cancel(work); this.#cancel(close);
      for (const role of roles) this.#wake(role);
    }
    const result = this.snapshot();
    this.#openWait?.resolve(result); this.#drainWait?.resolve(result);
    this.#releaseWait?.resolve(result); this.#closeWait?.resolve(result);
  }

  #progress() {
    if (this.#finished) { this.#finishWait(); return; }
    if (this.#releaseRequested && this.#settled(roles.map(role => this.#channels[role].sentinel))) {
      this.#releaseWait.resolve(this.snapshot());
    }
    if (this.#openDone && this.#prepared && !this.#firstError && !this.#closeRequested) this.#openWait.resolve(this.snapshot());
    if (this.#waitExpired || (this.#pending === 0 && !this.#opening && (!this.#drainWait || this.#pumpsDone)
      && this.#settled(this.#slots()) && (this.#closeRequested || this.#workComplete()))) this.#finishWait();
  }

  snapshot() {
    const slots = this.#slots();
    const ioClosed = slots.every(s => s.state === "not_opened") ? "not_opened"
      : slots.some(s => ["opening", "closing"].includes(s.state)) ? "pending"
      : slots.some(s => s.state === "unknown") ? "unknown" : slots.some(s => s.state === "open") ? "open" : "closed";
    const complete = this.#finished && this.#workComplete() && !this.#firstError && !this.#cleanupError
      && !this.#waitExpired && ioClosed === "closed" && this.#pending === 0;
    return Object.freeze({ state: complete ? "complete" : this.#firstError === "FIFO_LIMIT" ? "limit"
      : this.#firstError ? "incomplete" : "pending", firstError: this.#firstError, cleanupError: this.#cleanupError,
      prepared: this.#prepared, opening: this.#opening, finished: this.#finished, cleanupWaitExpired: this.#waitExpired,
      releaseRequested: this.#releaseRequested, pendingEffects: this.#pending,
      lastAtNs: this.#last === null ? null : this.#last.toString(), ioClosed,
      channels: Object.freeze(Object.fromEntries(roles.map(role => {
        const c = this.#channels[role];
        return [role, Object.freeze({ readBytes: c.readBytes, submittedBytes: c.submittedBytes,
          readUncertain: c.readUncertain, sinkFailed: c.sinkFailed, overflow: c.overflow, eof: c.eof,
          readPending: c.readPending, sinkPending: c.sinkPending, pollPending: c.pause !== null,
          reader: Object.freeze({ state: c.reader.state, verified: c.reader.verified }),
          sentinel: Object.freeze({ state: c.sentinel.state, verified: c.sentinel.verified }) })];
      }))), ...unqualified });
  }
}
