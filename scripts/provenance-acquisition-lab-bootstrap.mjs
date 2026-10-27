import { requireAcquisition } from "./provenance-acquisition-record.mjs";
import { copyLabInputPlan } from "./provenance-acquisition-lab-profile.mjs";
import { createLabInputCandidate } from "./provenance-acquisition-lab-input.mjs";
import { createAcquisitionLab } from "./provenance-acquisition-lab.mjs";
import { NativeLabIO } from "./provenance-acquisition-lab-io.mjs";
import { labFailureCode } from "./provenance-acquisition-lab-command.mjs";
import { freezeHostData } from "./provenance-acquisition-host-profile.mjs";

const nativeLab = (profile, checks) => new NativeLabIO(profile, checks);

/** Input observation and existing prepare/retire share one origin, never a renewed allowance. */
class LabBootstrap {
  #input; #io; #clock; #lab = null; #run = null; #stopped = false; #finished = false; #first = null;
  constructor(plan, inputIo, labIo, clock) {
    requireAcquisition(typeof labIo === "function", "LAB_INPUT");
    this.#input = createLabInputCandidate(plan, { io: inputIo, clock }); this.#io = labIo; this.#clock = clock;
  }
  run() {
    if (!this.#run) this.#run = (async () => {
      try {
        const input = await this.#input.run();
        requireAcquisition(!this.#stopped, "LAB_STOPPED");
        requireAcquisition(input.locallyComplete, input.firstFailure ?? input.cleanupError ?? "LAB_PROFILE");
        const { profile } = this.#input.collect();
        this.#lab = createAcquisitionLab(profile, { io: this.#io, clock: this.#clock });
        await this.#lab.run();
      } catch (error) { this.#first ??= labFailureCode(error, "LAB_PROFILE"); }
      this.#finished = true; return this.snapshot();
    })(); return this.#run;
  }
  stop() {
    if (!this.#finished) { this.#stopped = true; this.#input.stop(); this.#lab?.stop(); }
    return this.snapshot();
  }
  close() { this.stop(); return this.#run ?? this.#input.close().then(() => this.snapshot()); }
  snapshot() {
    const input = this.#input.snapshot(); const lab = this.#lab?.snapshot() ?? null;
    return freezeHostData({ finished: this.#finished, stopped: this.#stopped,
      firstFailure: this.#first ?? lab?.firstFailure ?? input.firstFailure,
      cleanupError: lab?.cleanupError ?? input.cleanupError, input, lab,
      locallyComplete: this.#finished && !this.#stopped && !this.#first && input.locallyComplete && lab?.locallyComplete === true,
      presentedViewAdmission: "unqualified", externalClosure: "unqualified", clockAdmission: "unqualified", releaseAdmission: "unqualified" });
  }
}

/** Native use remains explicit and separately authorized; constructing this owner performs no I/O. */
export function createLabBootstrap(input, { inputIo, labIo = nativeLab, clock = process.hrtime.bigint } = {}) {
  return new LabBootstrap(copyLabInputPlan(input), inputIo, labIo, clock);
}
