import { requireAcquisition } from "./provenance-acquisition-record.mjs";
import { LabCaseFiles } from "./provenance-acquisition-lab-case-files.mjs";
import { LabDiagnosticDocker } from "./provenance-acquisition-lab-docker.mjs";
import { labContainerRequest } from "./provenance-acquisition-lab-container.mjs";
import { buildLabCaseProfiles } from "./provenance-acquisition-lab-case-profile.mjs";
import { labCaseAttemptMetadata, labCasePrefixes, labCaseOutcome, labCaseLocallyJoined } from "./provenance-acquisition-lab-case-result.mjs";
import { createAcquisitionStartup } from "./provenance-acquisition-startup.mjs";
import { createActivatedAcquisitionAttempt } from "./provenance-acquisition-attempt.mjs";
import { labFailureCode } from "./provenance-acquisition-lab-command.mjs";
import { freezeHostData } from "./provenance-acquisition-host-profile.mjs";

const nativeUtc = () => new Date().toISOString();

/** Exactly one case in one verified worker; the exterior still owns the entire producer domain. */
export class LabDiagnosticCase {
  #lab; #plan; #kind; #ports; #docker; #files; #attempt = null; #startup = null; #run = null; #stopped = false;
  #parentCheck;
  #first = null; #finished = false; #report = null; #prefixes = null; #preserved = true; #close = null; #cleanup = null;
  constructor(lab, plan, socket, ports) {
    this.#lab = lab; this.#plan = plan; this.#kind = lab.diagnostic.case; this.#parentCheck = ports.check.bind(ports);
    this.#ports = Object.freeze({ ...ports, socket, check: () => this.#check(),
      kernel: Object.freeze({ caseHierarchy: ports.kernel.caseHierarchy.bind(ports.kernel) }),
      startupFactory: ports.startupFactory, attemptFactory: ports.attemptFactory });
    this.#docker = new LabDiagnosticDocker(plan, socket, this.#ports);
    this.#files = new LabCaseFiles(lab, plan, this.#kind, this.#ports);
  }
  stop() {
    this.#stopped = true; this.#docker.stop(); this.#attempt?.stop();
    if (this.#startup && !this.#startup.snapshot().finished) this.#startup.stop();
  }
  #check() {
    requireAcquisition(!this.#stopped, "LAB_STOPPED"); const observed = this.#parentCheck();
    requireAcquisition(!this.#stopped, "LAB_STOPPED"); return observed;
  }
  async #execute() {
    this.#check(); await this.#docker.prepareImage(); this.#check();
    // UTC is an earlier observation, never a later preparation sample projected forward.
    // Millisecond truncation is conservative; native clock correlation still needs admission.
    const startedUtc = (this.#ports.utcNow ?? nativeUtc)();
    const clock = this.#ports.clock ?? process.hrtime.bigint; const origin = clock();
    requireAcquisition(typeof origin === "bigint" && origin >= BigInt(this.#lab.context.t0MonotonicNs), "LAB_CLOCK");
    requireAcquisition(origin + BigInt(this.#plan.timing.deadlineNs) < BigInt(this.#lab.context.t0MonotonicNs)
      + BigInt(this.#lab.context.deadlineNs) - BigInt(this.#lab.limits.retireMs) * 1000000n, "LAB_DEADLINE");
    await this.#files.prepare(); this.#check();
    const hierarchy = await this.#ports.kernel.caseHierarchy(); this.#check();
    const body = labContainerRequest(this.#plan, hierarchy.casePath, this.#files.paths.input, this.#files.paths.ipc);
    const container = await this.#docker.create(this.#plan.operations[this.#kind], body); this.#check();
    const profiles = await buildLabCaseProfiles({ lab: this.#lab, plan: this.#plan, kind: this.#kind,
      t0MonotonicNs: origin.toString(), startedUtc, caseFiles: this.#files, groups: hierarchy.groups,
      container, socket: this.#ports.socket, records: this.#ports.files });
    this.#check();
    const startupFactory = this.#ports.startupFactory ?? createAcquisitionStartup;
    this.#startup = await startupFactory(profiles.startup); this.#check();
    const attemptFactory = this.#ports.attemptFactory ?? createActivatedAcquisitionAttempt;
    this.#attempt = attemptFactory(profiles.input, { startup: this.#startup, clock });
    // Construction/factory selection can reenter stop before the new owner is assigned.
    if (this.#stopped) this.#attempt.stop(); this.#check();
    const state = await this.#attempt.run({ observedUtc: nativeUtc() });
    await this.#attempt.join();
    this.#prefixes = labCasePrefixes(this.#files.snapshot(), state);
    const outcome = labCaseOutcome(this.#kind, state);
    const placement = this.#attempt.collectPlacement();
    for (const [role, originals] of Object.entries(placement)) for (const [name, bytes] of Object.entries(originals)) {
      await this.#ports.retirementFiles.write(`${this.#files.prefix}.proc.${role.toLowerCase()}.${name.toLowerCase()}`, bytes);
    }
    this.#report = { kind: this.#kind, operationId: this.#plan.operations[this.#kind], t0MonotonicNs: origin.toString(),
      profileSha256: profiles.profileSha256, container, files: this.#files.snapshot(),
      outcome, attempt: labCaseAttemptMetadata(state), prefixes: this.#prefixes, docker: this.#docker.snapshot() };
    await this.#ports.retirementFiles.json(`${this.#files.prefix}.result.json`, this.#report);
  }
  run() {
    if (!this.#run) this.#run = (async () => {
      try { await this.#execute(); }
      catch (error) {
        this.#first ??= labFailureCode(error, "LAB_DIAGNOSTIC"); this.stop();
        try {
          await this.#files.preserveFailure();
          this.#prefixes ??= labCasePrefixes(this.#files.snapshot(), this.#attempt?.snapshot());
          await this.#ports.retirementFiles.json(`${this.#files.prefix}.failed.json`, this.snapshot());
        } catch { this.#preserved = false; }
      }
      this.#finished = true; return this.snapshot();
    })(); return this.#run;
  }
  close() {
    if (!this.#close) {
      this.stop(); this.#close = (async () => {
        await Promise.allSettled(this.#run ? [this.#run] : []);
        const result = await Promise.allSettled([this.#attempt?.join(), this.#startup?.finish({ observedUtc: new Date().toISOString() }), this.#docker.close()]);
        const state = this.#attempt?.snapshot(); const docker = this.#docker.snapshot();
        if (result.some(r => r.status === "rejected") || state && !labCaseLocallyJoined(state)
          || docker.pendingJobs || docker.pendingTransactions) this.#cleanup ??= "LAB_CLEANUP";
        return this.snapshot();
      })();
    }
    return this.#close;
  }
  report() { return this.#report; }
  prefixes() { return this.#prefixes; }
  snapshot() {
    return freezeHostData({ kind: this.#kind, operationId: this.#plan.operations[this.#kind], finished: this.#finished,
      stopped: this.#stopped, firstFailure: this.#first, cleanupError: this.#cleanup,
      preservationComplete: this.#preserved && this.#files.snapshot().preservationComplete && this.#docker.snapshot().preservationComplete,
      outcome: this.#report?.outcome ?? null, prefixes: this.#prefixes,
      docker: this.#docker.snapshot(), caseRetirement: "unknown", releaseAdmission: "unqualified" });
  }
}
