import { acquisitionSha256, requireAcquisition } from "./provenance-acquisition-record.mjs";
import { freezeHostData } from "./provenance-acquisition-host-profile.mjs";
import { parsePlacementStat } from "./provenance-acquisition-placement-profile.mjs";
import { nativeFdPath, nativeIdentity, openNativeFile, readNativeBytes, PROC_MAGIC, NSFS_MAGIC }
  from "./provenance-acquisition-native-path.mjs";

// Linux show_offset: two lines, each %-10s + space + signed64 seconds + space + 9 nanoseconds + LF.
export const TIMENS_OFFSET_BYTES = 84;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const check = value => requireAcquisition(value, "PLACEMENT_IDENTITY");

/** Exact signed offsets; boottime is retained separately and never substituted for monotonic. */
export function parseTimeNamespaceOffsets(bytes) {
  requireAcquisition(Buffer.isBuffer(bytes) && bytes.length <= TIMENS_OFFSET_BYTES, "PLACEMENT_LIMIT");
  const text = bytes.toString("latin1");
  const match = /^monotonic +(-?(?:0|[1-9][0-9]{0,18})) +(0|[1-9][0-9]{0,8})\nboottime +(-?(?:0|[1-9][0-9]{0,18})) +(0|[1-9][0-9]{0,8})\n$/.exec(text);
  requireAcquisition(match && ![match[1], match[3]].includes("-0"), "PLACEMENT_READ");
  const result = {};
  for (const [name, index] of [["monotonicNs", 1], ["boottimeNs", 3]]) {
    const seconds = BigInt(match[index]); const nanos = BigInt(match[index + 1]);
    requireAcquisition(seconds >= -(1n << 63n) && seconds < 1n << 63n && nanos < 1000000000n, "PLACEMENT_READ");
    result[name] = (seconds * 1000000000n + nanos).toString();
  }
  return Object.freeze(result);
}

async function timePair(subject, port, checkpoint, result) {
  for (const name of ["time", "time_for_children"]) {
    checkpoint(); const h = await port.open(`${nativeFdPath(subject.dir)}/ns/${name}`, port.constants.O_RDONLY);
    subject.handles.push(h); checkpoint();
    const stat = await h.stat({ bigint: true }); checkpoint(); nativeIdentity(stat, null, false);
    const fs = await port.statfs(nativeFdPath(h), { bigint: true }); checkpoint(); check(fs.type === NSFS_MAGIC);
    result[name] = { dev: stat.dev.toString(), ino: stat.ino.toString() };
  }
}

async function offsetBytes(subject, handle, checkpoint, trace) {
  const bytes = Buffer.alloc(TIMENS_OFFSET_BYTES + 1); let count = 0; let eof = false;
  subject.originals.timensOffsets = bytes.subarray(0, 0);
  while (count < bytes.length) {
    checkpoint(); const r = await handle.read(bytes, count, bytes.length - count, count);
    requireAcquisition(Number.isInteger(r.bytesRead) && r.bytesRead >= 0 && r.bytesRead <= bytes.length - count, "PLACEMENT_READ");
    count += r.bytesRead; eof = r.bytesRead === 0;
    subject.originals.timensOffsets = bytes.subarray(0, count);
    trace.offsetRead = { confirmedBytes: count, eof }; checkpoint(); if (eof) break;
  }
  return subject.originals.timensOffsets;
}

/** Caller retains the process/handles and partial originals, including on a failed observation. */
export async function observeMonotonicDomain(subject, port, procBytes, checkpoint, trace) {
  const stat = await openNativeFile(subject.dir, "stat", port, subject.handles, PROC_MAGIC, checkpoint);
  const beforeBytes = await readNativeBytes(stat, procBytes, checkpoint);
  subject.originals.clockStatBefore = beforeBytes; const before = parsePlacementStat(beforeBytes);
  trace.before = {}; await timePair(subject, port, checkpoint, trace.before);
  check(same(trace.before.time, subject.data.namespaces.time) && same(trace.before.time, trace.before.time_for_children));
  const offsets = await openNativeFile(subject.dir, "timens_offsets", port, subject.handles, PROC_MAGIC, checkpoint);
  const bytes = await offsetBytes(subject, offsets, checkpoint, trace);
  trace.offsets = parseTimeNamespaceOffsets(bytes);
  trace.after = {}; await timePair(subject, port, checkpoint, trace.after);
  const afterBytes = await readNativeBytes(stat, procBytes, checkpoint);
  subject.originals.clockStatAfter = afterBytes; const after = parsePlacementStat(afterBytes);
  check([before, after].every(s => s.pid === subject.data.pid && s.ppid === subject.data.ppid
    && s.starttime === subject.data.starttime && !["Z", "X", "x"].includes(s.state))
    && same(trace.after.time, trace.before.time) && same(trace.after.time_for_children, trace.before.time));
  return freezeHostData({ ...trace, source: { bytes: bytes.length, sha256: acquisitionSha256(bytes) },
    continuity: "trusted_no_namespace_changes", nativeQualification: "unqualified" });
}
