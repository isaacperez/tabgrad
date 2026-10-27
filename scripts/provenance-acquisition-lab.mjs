import { AcquisitionRecordError, requireAcquisition } from "./provenance-acquisition-record.mjs";
import { freezeHostData } from "./provenance-acquisition-host-profile.mjs";
import { copyLabProfile } from "./provenance-acquisition-lab-profile.mjs";
import { labFailureCode } from "./provenance-acquisition-lab-command.mjs";

/** One original lab clock. Retirement cannot renew preparation or the whole operation. */
export class LabClock {
  #p; #clock; #last; #revoked = false;
  constructor(p, clock) { this.#p = p; this.#clock = clock; this.#last = BigInt(p.context.t0MonotonicNs); }
  revoke() { this.#revoked = true; }
  observe() {
    let now; try { now = this.#clock(); } catch { throw new AcquisitionRecordError("LAB_CLOCK"); }
    requireAcquisition(typeof now === "bigint" && now >= this.#last, "LAB_CLOCK"); this.#last = now;
    const elapsed = now - BigInt(this.#p.context.t0MonotonicNs);
    requireAcquisition(elapsed < BigInt(this.#p.context.deadlineNs), "LAB_DEADLINE"); return elapsed;
  }
  work() {
    requireAcquisition(!this.#revoked, "LAB_STOPPED"); const elapsed = this.observe();
    requireAcquisition(elapsed < BigInt(this.#p.limits.prepareMs) * 1000000n, "LAB_DEADLINE"); return elapsed;
  }
  retire() { return this.observe(); }
}

/** Exterior lifecycle: native observations, not CLI success, decide local retirement. */
class AcquisitionLab {
  #p; #io; #bounds; #run = null; #close = null; #work = null; #workPending = false; #closing = false;
  #first = null; #cleanup = null; #ready = false; #retired = false; #preserved = false; #finished = false;
  #resolveStop; #stopped; #timer = null; #pending = new Set();
  #retireExpired = false;
  constructor(p, io, clock) {
    this.#p = p; this.#bounds = new LabClock(p, clock);
    const checks = { work: () => this.#bounds.work(), retire: () => {
      requireAcquisition(!this.#retireExpired, "LAB_DEADLINE"); return this.#bounds.retire();
    } };
    if (typeof io === "function") io = io(p, checks);
    const names = ["open", "launch", "readiness", "revoke", "owned", "effect", "observe", "saveBoundary",
      "waitRetired", "preserve", "collect", "close", "halt", "snapshot"];
    this.#io = Object.freeze(Object.fromEntries(names.map(name => {
      requireAcquisition(typeof io[name] === "function", "LAB_INPUT"); return [name, io[name].bind(io)];
    })));
    this.#stopped = new Promise(resolve => { this.#resolveStop = resolve; });
  }
  #fail(error) {
    this.#first ??= labFailureCode(error); this.#bounds.revoke();
    try { this.#io.revoke(); } catch { this.#cleanup ??= "LAB_CLEANUP"; }
    this.#resolveStop();
  }
  #call(name, ...args) {
    // Publish ownership before invoking ports; a late result remains joined after revocation.
    const record = { promise: null }; this.#pending.add(record);
    record.promise = Promise.resolve().then(() => {
      requireAcquisition(!this.#retireExpired, "LAB_DEADLINE"); return this.#io[name](...args);
    }).finally(() => this.#pending.delete(record));
    return record.promise;
  }
  stop() { if (!this.#finished && !this.#closing) this.#fail(new AcquisitionRecordError("LAB_STOPPED")); return this.snapshot(); }
  async #prepare() {
    this.#bounds.work(); await this.#call("open"); this.#bounds.work();
    await this.#call("launch"); this.#bounds.work();
    await this.#call("readiness"); this.#bounds.work(); this.#ready = true;
  }
  run() {
    if (this.#run) return this.#run;
    if (!this.#first) {
      this.#workPending = true;
      this.#work = this.#prepare().catch(error => this.#fail(error)).finally(() => { this.#workPending = false; });
      this.#timer = setInterval(() => {
        if (this.#ready || this.#closing) return;
        try { this.#bounds.work(); } catch (error) { this.#fail(error); }
      }, this.#p.limits.pollMs);
    }
    this.#run = Promise.race([this.#work, this.#stopped]).then(() => this.close());
    return this.#run;
  }
  async #retire() {
    this.#bounds.retire();
    if (!await this.#call("owned")) return;
    // Starting both operations precedes awaiting either. A held freeze cannot suppress kill.
    const freeze = this.#call("effect", "keeper.freeze"); const kill = this.#call("effect", "work.kill");
    const effects = Promise.allSettled([freeze, kill]);
    let observed = false;
    let observing = true; let boundaryTimer;
    try {
      const boundary = (async () => {
      const frozen = await this.#call("observe", "keeper"); this.#bounds.retire();
      requireAcquisition(observing, "LAB_DEADLINE");
      requireAcquisition(frozen.value.frozen === true, "LAB_CLEANUP");
      const empty = await this.#call("observe", "work"); this.#bounds.retire();
      requireAcquisition(observing, "LAB_DEADLINE");
      requireAcquisition(empty.value.populated === false, "LAB_CLEANUP");
      await this.#call("saveBoundary", frozen, empty); this.#bounds.retire(); observed = true;
      })();
      const cutoff = new Promise((_, reject) => { boundaryTimer = setTimeout(() => {
        observing = false; reject(new AcquisitionRecordError("LAB_CLEANUP"));
      }, this.#p.limits.stopMs); });
      await Promise.race([boundary, cutoff]);
    } catch (error) { this.#cleanup ??= labFailureCode(error, "LAB_CLEANUP"); }
    finally { observing = false; clearTimeout(boundaryTimer); }
    // A missing boundary is a failed proof, but never suppresses this exact owned containment target.
    const whole = this.#call("effect", "unit.kill");
    const all = await Promise.allSettled([effects, whole]); this.#bounds.retire();
    const first = all[0];
    const acknowledged = first.status === "fulfilled" && first.value.every(r => r.status === "fulfilled")
      && all[1].status === "fulfilled";
    if (!acknowledged) this.#cleanup ??= "LAB_CLEANUP";
    await this.#call("waitRetired"); this.#bounds.retire();
    requireAcquisition(!this.#retireExpired, "LAB_DEADLINE"); this.#retired = observed && acknowledged;
  }
  close() {
    if (this.#close) return this.#close;
    this.#closing = true; clearInterval(this.#timer); this.#bounds.revoke();
    try { this.#io.revoke(); } catch { this.#cleanup ??= "LAB_CLEANUP"; }
    this.#close = (async () => {
      const cleanup = (async () => {
      await this.#retire().catch(error => { this.#cleanup ??= labFailureCode(error, "LAB_CLEANUP"); });
      // Do not wait forever for native work. Preserve ownership and mark unknown instead.
      if (this.#workPending || this.#pending.size) this.#cleanup ??= "LAB_CLEANUP";
      else {
        try {
          await this.#call("preserve", this.snapshot()); this.#preserved = true;
          if (this.#retired) await this.#call("collect");
        } catch (error) { this.#cleanup ??= labFailureCode(error, "LAB_PRESERVATION"); }
        try { await this.#call("close"); } catch { this.#cleanup ??= "LAB_CLEANUP"; }
      }
      })();
      let timeout;
      let remainingMs = 0;
      try { remainingMs = Number((BigInt(this.#p.context.deadlineNs) - this.#bounds.retire()) / 1000000n); }
      catch (error) { this.#cleanup ??= labFailureCode(error, "LAB_CLEANUP"); }
      const cutoff = new Promise(resolve => { timeout = setTimeout(() => resolve(false), Math.min(this.#p.limits.retireMs, remainingMs)); });
      const settled = await Promise.race([cleanup.then(() => true), cutoff]); clearTimeout(timeout);
      if (!settled) {
        this.#retireExpired = true; this.#cleanup ??= "LAB_CLEANUP";
        try { this.#io.halt(); } catch { this.#cleanup ??= "LAB_CLEANUP"; }
      }
      this.#finished = true; return this.snapshot();
    })(); return this.#close;
  }
  snapshot() {
    return freezeHostData({ operationId: this.#p.context.operationId, ready: this.#ready, finished: this.#finished,
      firstFailure: this.#first, cleanupError: this.#cleanup, workPending: this.#workPending,
      pendingOperations: this.#pending.size, retirementObserved: this.#retired, locallyPreserved: this.#preserved,
      locallyComplete: this.#ready && this.#retired && this.#preserved && !this.#first && !this.#cleanup,
      io: this.#io.snapshot(), externalClosure: "unqualified", clockAdmission: "unqualified", releaseAdmission: "unqualified" });
  }
}

/** Inert construction. The explicit caller, not this profile, admits native authority. */
export function createAcquisitionLab(input, { io, clock = process.hrtime.bigint }) {
  return new AcquisitionLab(copyLabProfile(input), io, clock);
}
