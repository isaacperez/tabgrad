import { placementModel, placementProfile } from "./provenance-acquisition-placement.mjs";

export function offsetText(monotonicSeconds = "0", monotonicNanos = "0", bootSeconds = "0", bootNanos = "0") {
  return `monotonic  ${monotonicSeconds.padStart(10)} ${monotonicNanos.padStart(9)}\nboottime   ${bootSeconds.padStart(10)} ${bootNanos.padStart(9)}\n`;
}

/** Entirely finite proc/nsfs tree; no native namespace is read or created. */
export function monotonicModel(options = {}) {
  const p = placementProfile(); p.clockPolicy = "monotonic_offsets";
  const m = placementModel(p, options); m.namespaces.time.ino = 30n;
  function extend(pid) {
    const dir = m.processes[pid]; dir.children.set("ns/time_for_children", dir.children.get("ns/time"));
    const offsets = m.file("timens_offsets", offsetText()); offsets.dev = 2n; offsets.filesystem = 0x9fa0n;
    dir.children.set("timens_offsets", offsets);
  }
  extend(777);
  return { ...m, profile: p,
    activate() { m.activate(); extend(1001); },
    program() { m.program(); extend(1002); extend(1003); } };
}
