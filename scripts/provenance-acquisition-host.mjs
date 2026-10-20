import { AcquisitionRecordError, requireAcquisition, isAcquisitionUint } from "./provenance-acquisition-record.mjs";
import { copyHostProfile, freezeHostData, HOST_ROLES, validateHostReport } from "./provenance-acquisition-host-profile.mjs";
import { openAcquisitionHost } from "./provenance-acquisition-host-io.mjs";

const causes = Object.freeze({ controller: "HOST_CONTROLLER", peer: "HOST_PEER", channel: "HOST_CHANNEL",
  protocol: "HOST_PROTOCOL", clock: "HOST_CLOCK", deadline: "HOST_DEADLINE", storage: "HOST_READ" });

/** One independently opened route. Snapshot observation is never release/closure admission. */
class HostController {
  #profile; #role; #io; #clock; #last = null; #revoked = false; #failure = null;
  #observation = { atNs: null, populated: null, frozen: null, error: null };
  #polling = null; #containing = null; #closing = null;

  constructor(profile, role, io, clock) { this.#profile = profile; this.#role = role; this.#io = io; this.#clock = clock; }

  check() {
    let at = null;
    try {
      const now = this.#clock();
      requireAcquisition(typeof now === "bigint", "HOST_CLOCK");
      const elapsed = now - BigInt(this.#profile.t0MonotonicNs);
      requireAcquisition(elapsed >= 0n && isAcquisitionUint(elapsed.toString())
        && (this.#last === null || elapsed >= BigInt(this.#last)), "HOST_CLOCK");
      at = elapsed.toString(); this.#last = at;
    } catch { this.#failure ??= "HOST_CLOCK"; this.contain("clock"); return null; }
    if (BigInt(at) >= BigInt(this.#profile.stopAtNs)) this.contain("deadline");
    return at;
  }

  contain(cause = "controller") {
    requireAcquisition(Object.hasOwn(causes, cause), "HOST_INPUT");
    if (this.#closing || this.#containing) return this.snapshot();
    this.#revoked = true;
    this.#failure ??= causes[cause];
    // Start both requests without waiting for freeze's completion or any parent RPC.
    this.#containing = Promise.allSettled([this.#io.freeze(), this.#io.kill()]);
    void this.#containing.catch(() => {});
    return this.snapshot();
  }

  poll() {
    requireAcquisition(!this.#closing, "HOST_STOPPED");
    this.check();
    if (!this.#polling) this.#polling = this.#poll().finally(() => { this.#polling = null; });
    return this.#polling;
  }

  async #poll() {
    try {
      const value = await this.#io.observe();
      const at = this.check();
      this.#observation = at === null ? { atNs: null, populated: null, frozen: null, error: "HOST_CLOCK" }
        : { atNs: at, populated: value.populated, frozen: value.frozen, error: null };
    } catch {
      this.#failure ??= "HOST_READ";
      this.#observation = { atNs: this.#last, populated: null, frozen: null, error: "HOST_READ" };
      this.contain("storage");
    }
    return this.snapshot();
  }

  close() {
    if (!this.#closing) {
      this.#revoked = true;
      this.#closing = this.#io.close().then(() => {
        if (this.#io.snapshot().ioClosed !== "closed") this.#failure ??= "HOST_CLOSE";
        return this.snapshot();
      });
    }
    return this.#closing;
  }

  snapshot() {
    const io = this.#io.snapshot();
    const r = { actor: this.#role, operationId: this.#profile.operationId, revoked: this.#revoked,
      lastAtNs: this.#last, firstFailure: this.#failure, observation: { ...this.#observation },
      ...io, externalClosure: "unqualified", clockAdmission: "unqualified", releaseAdmission: "unqualified" };
    validateHostReport(r, this.#role);
    return freezeHostData(r);
  }
}

export async function createAcquisitionHostController(profile, role, {
  clock = () => process.hrtime.bigint(), openHost = openAcquisitionHost,
} = {}) {
  const p = copyHostProfile(profile);
  requireAcquisition(HOST_ROLES.includes(role) && typeof clock === "function" && typeof openHost === "function", "HOST_INPUT");
  let now;
  try { now = clock(); } catch { throw new AcquisitionRecordError("HOST_CLOCK"); }
  requireAcquisition(typeof now === "bigint" && now >= BigInt(p.t0MonotonicNs), "HOST_CLOCK");
  const io = await openHost(p, role);
  const controller = new HostController(p, role, io, clock);
  controller.check();
  void controller.poll().catch(() => {});
  return controller;
}
