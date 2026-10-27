import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inputModel } from "./provenance-acquisition-lab-input.mjs";
import { diagnosticPlan } from "./provenance-acquisition-lab-diagnostic.mjs";
import { labNativePorts } from "./provenance-acquisition-lab.mjs";
import { createLabBootstrap } from "../../scripts/provenance-acquisition-lab-bootstrap.mjs";
import { NativeLabIO } from "../../scripts/provenance-acquisition-lab-io.mjs";
import { acquisitionSha256, ACQUISITION_LIMITS } from "../../scripts/provenance-acquisition-record.mjs";
import { ACQUISITION_PAYLOAD_LIMITS } from "../../scripts/provenance-acquisition-payload.mjs";
import { LAUNCH_CONTROL_LIMITS } from "../../scripts/provenance-acquisition-launch-protocol.mjs";

/** Actual input/bootstrap/exterior owners; a finite worker publishes only explicit synthetic observations. */
export async function experimentModel(options = {}) {
  const input = await inputModel(); const diagnostic = diagnosticPlan();
  const path = join(input.directory, "diagnostic.json"); const bytes = Buffer.from(JSON.stringify(diagnostic));
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  const reference = { path, sha256: acquisitionSha256(bytes) };
  const labs = Object.fromEntries(["A", "B", "C"].map((kind, i) => {
    const p = structuredClone(input.plan); p.context.operationId = String(i + 6).repeat(32);
    p.diagnostic = { ...reference, case: kind }; p.limits.observationBytes = 1048576; return [kind, p];
  }));
  const plan = { schemaVersion: 1, context: { operationId: "9".repeat(32), sourceRevision: diagnostic.sourceRevision, deadlineNs: "10000000000" },
    diagnostic: reference, labs, limits: { pollMs: 1, closeWaitMs: 50 } };
  const ports = []; const events = []; const written = []; let writerClosed = false;
  const bootstrap = (p, { clock }) => {
    events.push(["select", p.diagnostic.case]);
    return createLabBootstrap(p, { inputIo: input.port, clock, labIo(profile, checks) {
      const native = labNativePorts(profile); ports.push(native);
      const write = native.files.json;
      native.files.json = async (label, value) => {
        const record = await write(label, value);
        if (label === "diagnostic.start.json") {
          const ready = JSON.parse(native.originals.get("ready.json")); const prefixes = {};
          const capacities = { "program.stdout": ACQUISITION_PAYLOAD_LIMITS.stdout, "program.stderr": ACQUISITION_PAYLOAD_LIMITS.stderr,
            "daemon.stdout": ACQUISITION_PAYLOAD_LIMITS.stdout, "daemon.stderr": ACQUISITION_PAYLOAD_LIMITS.stderr,
            control: LAUNCH_CONTROL_LIMITS.total, ...ACQUISITION_LIMITS };
          const kind = profile.diagnostic.case; const token = diagnostic.operations[kind]; let ino = 900;
          for (const [part, capacity] of Object.entries(capacities)) {
            const label = "case-" + kind.toLowerCase() + "-" + token + "." + part;
            native.originals.set(label, Buffer.alloc(capacity)); native.fileIdentities.set(label, "4:" + ino);
            prefixes[part] = { name: profile.context.operationId + "." + label, identity: { dev: "4", ino: String(ino++) },
              capacity, confirmedBytes: 0, sha256: acquisitionSha256(Buffer.alloc(0)), producerObservation: "unavailable", uncertain: true };
          }
          const result = { kind: "lab_diagnostic_result_v1", operationId: profile.context.operationId,
            profileSha256: acquisitionSha256(JSON.stringify(profile)), planSha256: profile.diagnostic.sha256, case: kind,
            readySha256: value.readySha256, worker: ready.processes.worker,
            state: { finished: true, firstFailure: null, cleanupError: null, preservationComplete: true, outcome: { expected: true }, prefixes },
            evidence: ready.evidence };
          options.result?.(result, native); native.originals.set("diagnostic.result.json", Buffer.from(JSON.stringify(result)));
        }
        return record;
      };
      const effect = native.kernel.effect;
      native.kernel.effect = async target => { events.push(["effect", profile.diagnostic.case, target]); await effect(target); };
      options.native?.(native, profile);
      return new NativeLabIO(profile, checks, native);
    } });
  };
  const evidence = (p, token, check) => ({ async write(value) { check(); written.push(value); await options.write?.(); check(); },
    async close() { writerClosed = true; }, snapshot: () => ({ record: written.length ? { sha256: acquisitionSha256(JSON.stringify(written[0])) } : null,
      files: { handles: { retained: 0 }, unpreservedRecords: [] } }) });
  return { input, plan, diagnostic, ports, events, written, bootstrap, evidence, writerClosed: () => writerClosed, close: input.close };
}
