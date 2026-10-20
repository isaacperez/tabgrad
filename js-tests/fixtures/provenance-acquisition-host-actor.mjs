import { runAcquisitionProcessActor } from "../../scripts/provenance-acquisition-process-actor.mjs";
import { createAcquisitionHostController } from "../../scripts/provenance-acquisition-host.mjs";
import { openAcquisitionHost } from "../../scripts/provenance-acquisition-host-io.mjs";
import { hostModel } from "./provenance-acquisition-host.mjs";

// Actual finite IPC actor; only its native host syscall boundary is synthetic.
const model = hostModel({ pid: process.pid });
runAcquisitionProcessActor(process, process.pid, {
  createHost: (profile, role) => createAcquisitionHostController(profile, role, {
    openHost: (data, actor) => openAcquisitionHost(data, actor, model.port),
  }),
});
