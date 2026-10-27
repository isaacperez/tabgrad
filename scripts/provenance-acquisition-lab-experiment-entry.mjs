import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isAcquisitionHash, requireAcquisition } from "./provenance-acquisition-record.mjs";
import { readLabExperimentPlan } from "./provenance-acquisition-lab-files.mjs";
import { createLabExperiment } from "./provenance-acquisition-lab-experiment.mjs";
import { labFailureCode } from "./provenance-acquisition-lab-command.mjs";

/** Explicit native experiment, never selected by ordinary CI or by importing the module. */
export async function runLabExperimentEntry(args) {
  requireAcquisition(args.length === 2 && typeof args[0] === "string" && resolve(args[0]) === args[0]
    && isAcquisitionHash(args[1]), "LAB_INPUT");
  const p = await readLabExperimentPlan(args[0], args[1]); const owner = createLabExperiment(p);
  const stop = () => owner.stop(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try { await owner.run(); return owner.summary(); }
  finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { const result = await runLabExperimentEntry(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result) + "\n"); process.exitCode = result.locallyComplete ? 0 : 1;
  } catch (error) { process.stderr.write(labFailureCode(error, "LAB_PROFILE") + "\n"); process.exitCode = 1; }
}
