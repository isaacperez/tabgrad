import { acquisitionSha256, requireAcquisition } from "./provenance-acquisition-record.mjs";
import { freezeHostData } from "./provenance-acquisition-host-profile.mjs";
import { parsePlacementStat, parsePlacementStatus } from "./provenance-acquisition-placement-profile.mjs";
import { nativeFdPath, openNativeDirectory, openNativeFile, readNativeBytes, readNativeNamespaces, PROC_MAGIC }
  from "./provenance-acquisition-native-path.mjs";

/** Shared native observation; callers own namespace/membership policy and successful handle lifetime. */
export async function readAcquisitionProcess(proc, pid, port, limits, checkpoint, releaseFailed) {
  const handles = [];
  try {
    const dir = await openNativeDirectory(`${nativeFdPath(proc)}/${pid}`, null, port, handles, PROC_MAGIC, checkpoint);
    const stat = await openNativeFile(dir, "stat", port, handles, PROC_MAGIC, checkpoint);
    const status = await openNativeFile(dir, "status", port, handles, PROC_MAGIC, checkpoint);
    const cgroup = await openNativeFile(dir, "cgroup", port, handles, PROC_MAGIC, checkpoint);
    const beforeBytes = await readNativeBytes(stat, limits.procBytes, checkpoint);
    const before = parsePlacementStat(beforeBytes);
    const statusBytes = await readNativeBytes(status, limits.procBytes, checkpoint);
    const decoded = parsePlacementStatus(statusBytes);
    const cgroupBytes = await readNativeBytes(cgroup, limits.procBytes, checkpoint);
    const namespaces = await readNativeNamespaces(dir, port, handles, checkpoint);
    const afterBytes = await readNativeBytes(stat, limits.procBytes, checkpoint);
    const after = parsePlacementStat(afterBytes);
    requireAcquisition(before.pid === pid && decoded.pid === pid && before.pid === after.pid
      && before.ppid === after.ppid && before.starttime === after.starttime
      && !["Z", "X", "x"].includes(after.state), "HOST_IDENTITY");
    const membership = cgroupBytes.toString("latin1");
    requireAcquisition(cgroupBytes.every(b => b === 10 || b >= 32 && b <= 126) && /^0::\/[^\n]*\n$/.test(membership), "HOST_IDENTITY");
    const originals = { statBefore: beforeBytes, status: statusBytes, cgroup: cgroupBytes, statAfter: afterBytes };
    checkpoint(); const identity = await dir.stat({ bigint: true }); checkpoint();
    return { handles, dir, originals, data: freezeHostData({ ...after, ...decoded, namespaces,
      procIdentity: { dev: identity.dev.toString(), ino: identity.ino.toString() }, membership: membership.slice(3, -1),
      sources: Object.fromEntries(Object.entries(originals).map(([k, v]) => [k, { bytes: v.length, sha256: acquisitionSha256(v) }])) }) };
  } catch (error) { await releaseFailed(handles); throw error; }
}
