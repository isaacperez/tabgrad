import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isAcquisitionHash, requireAcquisition } from "./provenance-acquisition-record.mjs";
import { readLabProfile } from "./provenance-acquisition-lab-files.mjs";
import { labPaths } from "./provenance-acquisition-lab-profile.mjs";
import { NativeLabIO } from "./provenance-acquisition-lab-io.mjs";
import { createAcquisitionLab, LabClock } from "./provenance-acquisition-lab.mjs";
import { labFailureCode } from "./provenance-acquisition-lab-command.mjs";

/** Explicit experimental native entry, including privileged host effects; never run by default CI. */
export async function runLabEntry(args) {
  requireAcquisition(args.length === 3 && ["prepare", "keeper", "worker"].includes(args[0])
    && typeof args[1] === "string" && resolve(args[1]) === args[1] && isAcquisitionHash(args[2]), "LAB_INPUT");
  const [role, path, hash] = args; const p = await readLabProfile(path, hash);
  // prepare receives an external input; child entries must consume the exact exclusive published copy.
  if (role !== "prepare") requireAcquisition(path === labPaths(p).profile, "LAB_PROFILE");
  if (role === "prepare") {
    const owner = createAcquisitionLab(p, { io: (profile, checks) => new NativeLabIO(profile, checks) });
    const stop = () => owner.stop(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try { return await owner.run(); }
    finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  }
  const bounds = new LabClock(p, process.hrtime.bigint);
  const io = new NativeLabIO(p, { work: () => bounds.work(), retire: () => bounds.retire(), beginDiagnostic: () => bounds.beginDiagnostic() });
  let timer;
  if (role === "worker") timer = setInterval(() => {
    try { bounds.work(); } catch { bounds.revoke(); io.revoke(); }
  }, p.limits.pollMs);
  try { await io[role](); }
  catch (error) { if (role === "worker") await io.workerFailure(labFailureCode(error)); throw error; }
  finally { clearInterval(timer); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await runLabEntry(process.argv.slice(2));
    if (result) { process.stdout.write(JSON.stringify(result) + "\n"); process.exitCode = result.locallyComplete ? 0 : 1; }
  } catch (error) { process.stderr.write(labFailureCode(error, "LAB_PROFILE") + "\n"); process.exitCode = 1; }
}
