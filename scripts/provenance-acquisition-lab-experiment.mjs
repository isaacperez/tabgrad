import { acquisitionSha256, AcquisitionRecordError, isAcquisitionUint, requireAcquisition } from "./provenance-acquisition-record.mjs";
import { copyLabExperimentPlan, validateLabExperimentDiagnostic } from "./provenance-acquisition-lab-experiment-profile.mjs";
import { createLabBootstrap } from "./provenance-acquisition-lab-bootstrap.mjs";
import { readLabDiagnosticPlan, LabFiles } from "./provenance-acquisition-lab-files.mjs";
import { LAB_DIAGNOSTIC_CASES } from "./provenance-acquisition-lab-diagnostic-profile.mjs";
import { labFailureCode } from "./provenance-acquisition-lab-command.mjs";
import { freezeHostData } from "./provenance-acquisition-host-profile.mjs";

/** Reuses an observed evidence anchor; there is no alternate path after failed admission. */
class LabExperimentEvidence {
  #files; #label; #record = null;
  constructor(profile, token, check) { this.#files = new LabFiles(profile, check); this.#label = "experiment-" + token + ".json"; }
  async write(value) {
    await this.#files.roots(); const record = await this.#files.json(this.#label, value);
    const bytes = await this.#files.read(this.#label);
    requireAcquisition(bytes && bytes.length === record.bytes && acquisitionSha256(bytes) === record.sha256, "LAB_PRESERVATION");
    this.#record = record;
  }
  close() { return this.#files.close(); }
  snapshot() { return { record: this.#record, files: this.#files.snapshot() }; }
}

/** This gate requires the complete exterior lifecycle, not a case or HTTP close boolean. */
export function labExperimentMayAdvance(state) {
  const lab = state?.lab; const io = lab?.io;
  return state?.finished === true && state.locallyComplete === true && !state.stopped && !state.firstFailure && !state.cleanupError
    && state.input?.locallyComplete === true && !state.input.workPending && state.input.handles.retained === 0
    && lab?.locallyComplete === true && lab.retirementObserved === true && lab.locallyPreserved === true
    && !lab.firstFailure && !lab.cleanupError && !lab.workPending && lab.pendingOperations === 0
    && io?.registrationCollected === true && io.preserved === true && io.boundarySaved === true
    && io.pendingOperations === 0 && io.activeCommands === 0 && io.kernel.handles.retained === 0
    && io.files.handles.retained === 0 && io.retirementFiles.handles.retained === 0
    && io.diagnostic?.resultObserved === true && io.diagnostic.expected === true;
}

/** One total cutoff, three fresh laboratories, no retry and no inference of native qualification. */
class LabExperiment {
  #p; #clock; #reader; #factory; #evidenceFactory; #origin = null; #last = null; #active = null; #evidence = null;
  #readHandles = null; #results = { A: null, B: null, C: null }; #input = null; #run = null; #work = null;
  #workPending = false; #finished = false; #stopped = false; #first = null; #cleanup = null; #preserved = false;
  #timer = null; #resolveStop; #stopWait;
  constructor(p, ports) {
    this.#p = p; this.#clock = ports.clock; this.#reader = ports.readDiagnosticPlan; this.#factory = ports.bootstrap;
    this.#evidenceFactory = ports.evidence;
    requireAcquisition([this.#clock, this.#reader, this.#factory, this.#evidenceFactory].every(f => typeof f === "function"), "LAB_INPUT");
    this.#stopWait = new Promise(resolve => { this.#resolveStop = resolve; });
  }
  #observe = () => {
    requireAcquisition(!this.#finished, "LAB_STOPPED");
    let now; try { now = this.#clock(); } catch { throw new AcquisitionRecordError("LAB_CLOCK"); }
    requireAcquisition(typeof now === "bigint" && this.#last !== null && now >= this.#last, "LAB_CLOCK"); this.#last = now;
    const left = this.#origin + BigInt(this.#p.context.deadlineNs) - now;
    requireAcquisition(left > 0n, "LAB_DEADLINE"); return left;
  };
  #check = () => {
    requireAcquisition(!this.#stopped && !this.#finished, this.#first ?? "LAB_STOPPED"); const left = this.#observe();
    requireAcquisition(!this.#stopped, this.#first ?? "LAB_STOPPED"); return left;
  };
  #fail(error) {
    this.#first ??= labFailureCode(error, "LAB_DIAGNOSTIC"); this.#stopped = true;
    try { this.#active?.stop(); } catch { this.#cleanup ??= "LAB_CLEANUP"; }
    this.#resolveStop();
  }
  stop() { if (!this.#finished) this.#fail(new AcquisitionRecordError("LAB_STOPPED")); return this.snapshot(); }
  async #sequence() {
    try {
      const diagnostic = await this.#reader(this.#p.diagnostic.path, this.#p.diagnostic.sha256);
      this.#check(); validateLabExperimentDiagnostic(this.#p, diagnostic);
      for (const kind of LAB_DIAGNOSTIC_CASES) {
        const input = this.#p.labs[kind];
        requireAcquisition(this.#check() > BigInt(input.context.deadlineNs)
          + BigInt(this.#p.limits.closeWaitMs) * 1000000n, "LAB_DEADLINE");
        this.#active = this.#factory(input, { clock: this.#clock });
        // A trusted factory can reenter cancellation before ownership transfers.
        if (this.#stopped) this.#active.stop(); this.#check();
        try { this.#results[kind] = await this.#active.run(); }
        finally {
          if (!this.#input) {
            try { this.#input = this.#active.collectInput().profile; }
            catch { /* Failed input admission provides no output-root authority. */ }
          }
        }
        this.#check(); requireAcquisition(labExperimentMayAdvance(this.#results[kind]), "LAB_DIAGNOSTIC");
        this.#active = null;
      }
    } catch (error) { this.#readHandles ??= error?.handleOwner ?? null; this.#fail(error); }
  }
  async #retain() {
    requireAcquisition(!this.#workPending && this.#input, "LAB_PRESERVATION");
    this.#observe();
    this.#evidence = this.#evidenceFactory(this.#input, this.#p.context.operationId, this.#observe);
    try { await this.#evidence.write({ kind: "lab_experiment_observations_v1", plan: this.#p, state: this.snapshot() }); }
    finally { await this.#evidence.close(); }
    const evidence = this.#evidence.snapshot();
    requireAcquisition(evidence.record && evidence.files.handles.retained === 0
      && (evidence.files.unpreservedRecords ?? []).length === 0, "LAB_PRESERVATION");
    this.#observe(); this.#preserved = true;
  }
  async #settle() {
    let remaining = 0;
    try { remaining = Number(this.#observe() / 1000000n); } catch (error) { this.#fail(error); }
    let timer;
    const cleanup = (async () => {
      await Promise.allSettled(this.#work ? [this.#work] : []);
      const handles = await this.#readHandles?.closeAll();
      if (handles?.retained) this.#cleanup ??= "LAB_CLEANUP";
      try { await this.#retain(); } catch (error) { this.#cleanup ??= labFailureCode(error, "LAB_PRESERVATION"); }
    })();
    const settled = await Promise.race([cleanup.then(() => true), new Promise(resolve => {
      timer = setTimeout(() => resolve(false), Math.min(this.#p.limits.closeWaitMs, remaining));
    })]); clearTimeout(timer);
    if (!settled) this.#cleanup ??= "LAB_CLEANUP";
  }
  run() {
    if (!this.#run) this.#run = (async () => {
      let deadlineTimer;
      try {
        requireAcquisition(!this.#stopped, this.#first ?? "LAB_STOPPED"); this.#origin = this.#clock(); this.#last = this.#origin;
        requireAcquisition(typeof this.#origin === "bigint" && isAcquisitionUint(this.#origin.toString()), "LAB_CLOCK");
        this.#workPending = true;
        this.#work = this.#sequence().finally(() => { this.#workPending = false; });
        this.#timer = setInterval(() => { try { this.#check(); } catch (error) { this.#fail(error); } }, this.#p.limits.pollMs);
        deadlineTimer = setTimeout(() => this.#fail(new AcquisitionRecordError("LAB_DEADLINE")), Number(BigInt(this.#p.context.deadlineNs) / 1000000n));
        await Promise.race([this.#work, this.#stopWait]);
        await this.#settle();
      } catch (error) { this.#fail(error); }
      clearInterval(this.#timer); clearTimeout(deadlineTimer); this.#finished = true; return this.snapshot();
    })(); return this.#run;
  }
  close() { this.stop(); return this.#run ?? Promise.resolve(this.snapshot()); }
  snapshot() {
    return freezeHostData({ operationId: this.#p.context.operationId, originNs: this.#origin?.toString() ?? null,
      finished: this.#finished, stopped: this.#stopped, firstFailure: this.#first, cleanupError: this.#cleanup,
      workPending: this.#workPending, results: { ...this.#results }, active: this.#active?.snapshot() ?? null,
      preserved: this.#preserved, evidence: this.#evidence?.snapshot() ?? null, readerHandles: this.#readHandles?.snapshot() ?? null,
      locallyComplete: this.#finished && !this.#first && !this.#cleanup && this.#preserved && !this.#workPending
        && LAB_DIAGNOSTIC_CASES.every(k => labExperimentMayAdvance(this.#results[k])),
      externalClosure: "unqualified", clockAdmission: "unqualified", releaseAdmission: "unqualified" });
  }
  /** Only this closed projection is eligible for caller-visible diagnostics; originals stay private. */
  summary() {
    const state = this.snapshot();
    return freezeHostData({ operationId: state.operationId, finished: state.finished, locallyComplete: state.locallyComplete,
      firstFailure: state.firstFailure, cleanupError: state.cleanupError, preserved: state.preserved,
      recordSha256: state.evidence?.record?.sha256 ?? null,
      cases: Object.fromEntries(LAB_DIAGNOSTIC_CASES.map(kind => [kind, { attempted: state.results[kind] !== null,
        locallyComplete: labExperimentMayAdvance(state.results[kind]), retirementObserved: state.results[kind]?.lab?.retirementObserved === true }])),
      externalClosure: "unqualified", clockAdmission: "unqualified", releaseAdmission: "unqualified" });
  }
}

const evidence = (profile, token, check) => new LabExperimentEvidence(profile, token, check);

/** Construction is inert. Native execution remains separately admitted and explicitly invoked. */
export function createLabExperiment(input, { clock = process.hrtime.bigint, readDiagnosticPlan: reader = readLabDiagnosticPlan,
  bootstrap = createLabBootstrap, evidence: writer = evidence } = {}) {
  return new LabExperiment(copyLabExperimentPlan(input), { clock, readDiagnosticPlan: reader, bootstrap, evidence: writer });
}
