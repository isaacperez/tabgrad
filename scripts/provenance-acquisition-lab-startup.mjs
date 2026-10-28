import { requireAcquisition } from "./provenance-acquisition-record.mjs";
import { freezeHostData } from "./provenance-acquisition-host-profile.mjs";
import { labPaths } from "./provenance-acquisition-lab-profile.mjs";
import { labBusArguments, parseLabUnitPath, checkLabUnitName } from "./provenance-acquisition-lab-manager.mjs";
import { labFailureCode } from "./provenance-acquisition-lab-command.mjs";

const journalFields = "MESSAGE,PRIORITY,SYSLOG_IDENTIFIER,_PID,_SYSTEMD_UNIT,_SYSTEMD_INVOCATION_ID,UNIT,OBJECT_SYSTEMD_UNIT,COREDUMP_UNIT";
const labels = ["path", "unit", "service", "journal"];

/** Fixed current-boot/unit selection. No follow, pager, field expansion or host-wide fallback. */
export function labStartupJournalArguments(p) {
  return Object.freeze(["--system", "--boot", `--unit=${labPaths(p).unit}`, "--no-pager", "--no-tail",
    "--output=json", `--output-fields=${journalFields}`]);
}

/** Unbound startup observations. Command and exclusive-file owners retain all native resources.
 * Ports: command(name,args,{retire,label}) returns a LabCommand; files writes private JSON;
 * check is the unchanged retirement gate. Neither results nor selection grant unit ownership.
 */
export class LabStartupDiagnostics {
  #p; #command; #files; #check; #run = null; #state = "not_requested"; #first = null;
  #requests = new Map(labels.map(key => [key, { state: "not_started", firstFailure: null, command: null, args: null }]));
  constructor(p, { command, files, check }) {
    this.#p = p; this.#command = command; this.#files = files; this.#check = check;
  }
  async #capture(key, name, args) {
    const row = this.#requests.get(key); row.args = [...args];
    try {
      this.#check(); row.state = "pending";
      const label = `startup.${key}`;
      row.command = await this.#command(name, args, { retire: true, label });
      const result = await row.command.result; row.state = "settled";
      this.#check(); await this.#files.json(`${label}.result.json`, result);
      requireAcquisition(result.closed && result.exited && !result.firstFailure && !result.cleanupError
        && result.exitCode === 0 && result.signal === null, result.firstFailure ?? result.cleanupError ?? "LAB_TOOL");
      return row.command;
    } catch (error) {
      row.firstFailure = labFailureCode(error); this.#first ??= row.firstFailure; throw error;
    }
  }
  async #manager() {
    try {
      const pathCommand = await this.#capture("path", "busctl", labBusArguments(this.#p, "GetUnit"));
      const path = parseLabUnitPath(await pathCommand.collect("stdout")); this.#check();
      const unit = await this.#capture("unit", "busctl", labBusArguments(this.#p, "GetAllUnit", path));
      checkLabUnitName(await unit.collect("stdout"), labPaths(this.#p).unit); this.#check();
      await this.#capture("service", "busctl", labBusArguments(this.#p, "GetAllService", path));
    } catch (error) { this.#first ??= labFailureCode(error); throw error; }
  }
  observe() {
    if (!this.#run) this.#run = Promise.resolve().then(() => this.#observe()).catch(error => {
      this.#first ??= labFailureCode(error); throw error;
    });
    return this.#run;
  }
  async #observe() {
    this.#state = "not_started";
    try { this.#check(); }
    catch (error) { this.#first = labFailureCode(error); throw error; }
    this.#state = "pending";
    // Independent reads: a failed or held manager request cannot suppress the journal.
    const results = await Promise.allSettled([this.#manager(),
      this.#capture("journal", "journalctl", labStartupJournalArguments(this.#p))]);
    this.#state = "settled";
    // Query failures are diagnostic outcomes. Failed original publication still
    // fails conservation through the shared writer's unpreserved-record state.
    for (const result of results) if (result.status === "rejected") {
      this.#first ??= labFailureCode(result.reason);
    }
    this.#check(); await this.#files.json("startup.json", this.snapshot());
    return this.snapshot();
  }
  snapshot() {
    return freezeHostData({ state: this.#state, firstFailure: this.#first,
      selection: { unit: labPaths(this.#p).unit, boot: "current", journalFields,
        attribution: "unbound_diagnostic", completeness: "unqualified" },
      requests: Object.fromEntries([...this.#requests].map(([key, row]) => [key,
        { state: row.state, firstFailure: row.firstFailure, args: row.args }])),
      commands: Object.fromEntries([...this.#requests].filter(([, row]) => row.command)
        .map(([key, row]) => [`startup.${key}`, row.command.snapshot()])) });
  }
}
