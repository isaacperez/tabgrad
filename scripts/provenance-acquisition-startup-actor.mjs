import { pathToFileURL } from "node:url";
import { runAcquisitionProcessActor } from "./provenance-acquisition-process-actor.mjs";
import { createEnteringAcquisitionHostController } from "./provenance-acquisition-host.mjs";

// Only an explicit invocation enters a native prepared group. Importing is inert.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAcquisitionProcessActor(process, process.pid, { createHost: createEnteringAcquisitionHostController });
}
