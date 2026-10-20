import { writeFile } from "node:fs/promises";
import { runAcquisitionProcessActor } from "../../scripts/provenance-acquisition-process-actor.mjs";
import { createEnteringAcquisitionHostController } from "../../scripts/provenance-acquisition-host.mjs";
import { enterAcquisitionHost } from "../../scripts/provenance-acquisition-host-io.mjs";
import { startupGuardMain } from "../../scripts/provenance-acquisition-startup-guard.mjs";
import { hostModel } from "./provenance-acquisition-host.mjs";

// Finite ordinary Node child. Only the fixed native syscall boundary is synthetic.
const model = hostModel({ pid: process.pid, enter: true });
model.nodes.case.children.get("cgroup.events").text = "populated 0\nfrozen 0\n";
function createController(profile, role, options = {}) {
  return createEnteringAcquisitionHostController(profile, role, { ...options,
    openHost: (p, r) => enterAcquisitionHost(p, r, { port: model.port, clock: options.clock }),
  });
}
if (process.argv[2] === "actor") runAcquisitionProcessActor(process, process.pid, { createHost: createController });
else if (process.argv[2] === "guard") {
  startupGuardMain(process.argv.slice(3, 5), process, { createController }).then(async () => {
    if (process.argv[5]) await writeFile(process.argv[5], JSON.stringify(model.calls.filter(c => c.kind === "write")), { flag: "wx", mode: 0o600 });
  }).catch(() => { process.exitCode = 1; });
}
