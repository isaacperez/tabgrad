import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { requireAcquisition, isAcquisitionHash } from "./provenance-acquisition-record.mjs";
import { readLabInputPlan } from "./provenance-acquisition-lab-files.mjs";
import { createLabInputCandidate } from "./provenance-acquisition-lab-input.mjs";
import { createLabBootstrap } from "./provenance-acquisition-lab-bootstrap.mjs";
import { labFailureCode } from "./provenance-acquisition-lab-command.mjs";

/** Explicit observation or native prepare/retire; neither mode runs cases or signs. */
export async function runLabInputEntry(args) {
  requireAcquisition(args.length === 3 && ["observe", "prepare"].includes(args[0]) && typeof args[1] === "string"
    && resolve(args[1]) === args[1] && isAcquisitionHash(args[2]), "LAB_INPUT");
  const plan = await readLabInputPlan(args[1], args[2]);
  const candidate = args[0] === "observe" ? createLabInputCandidate(plan) : createLabBootstrap(plan);
  const stop = () => candidate.stop(); process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try { return await candidate.run(); }
  finally { process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { const result = await runLabInputEntry(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result) + "\n"); process.exitCode = result.locallyComplete ? 0 : 1;
  } catch (error) { process.stderr.write(labFailureCode(error, "LAB_PROFILE") + "\n"); process.exitCode = 1; }
}
