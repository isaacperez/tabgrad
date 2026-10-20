import { writeFile } from "node:fs/promises";
import { readHostGuardProfile, runAcquisitionHostGuard } from "../../scripts/provenance-acquisition-host-guard.mjs";
import { createAcquisitionHostController } from "../../scripts/provenance-acquisition-host.mjs";
import { openAcquisitionHost } from "../../scripts/provenance-acquisition-host-io.mjs";
import { hostModel } from "./provenance-acquisition-host.mjs";

// Ordinary finite process with a synthetic syscall port, not a Linux laboratory.
const [path, hash, output] = process.argv.slice(2);
try {
  const p = await readHostGuardProfile(path, hash);
  const m = hostModel({ pid: process.pid });
  const result = await runAcquisitionHostGuard(p, { async createController(profile, role, options) {
    const c = await createAcquisitionHostController(profile, role, { ...options,
      openHost: (data, actor) => openAcquisitionHost(data, actor, m.port) });
    if (process.connected) process.send({ kind: "ready", operationId: p.operationId });
    return c;
  } });
  const settled = await result.settled;
  await writeFile(output, JSON.stringify({ observation: result.observation, settled,
    writes: m.calls.filter(c => c.kind === "write").map(c => [c.name, c.text]) }), { flag: "wx", mode: 0o600 });
  if (process.connected) process.disconnect();
} catch { process.exitCode = 1; if (process.connected) process.disconnect(); }
