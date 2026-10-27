import { hostModel } from "./provenance-acquisition-host.mjs";

const id = "c".repeat(64);
const ident = (dev, ino) => ({ dev: String(dev), ino: String(ino) });

export function placementProfile(context = { operationId: "1".repeat(32), t0MonotonicNs: "100",
  deadlineNs: "3000000000", root: "/evidence" }, containerId = id, launcherProfileSha256 = "b".repeat(64)) {
  return { context: { ...context }, containerId, preparedContainerSha256: "a".repeat(64), launcherProfileSha256,
    hierarchy: { root: { path: "/owned", identity: ident(1, 1) }, case: [{ name: "case", identity: ident(1, 2) }] },
    proc: { path: "/proc", identity: ident(2, 80) },
    namespaces: { pid: ident(3, 10), cgroup: ident(3, 11), time: ident(3, 12) },
    limits: { procsBytes: 1024, procBytes: 4096, maxProcesses: 8 } };
}

export function processStat(pid, ppid, starttime = "500", state = "S", comm = "node") {
  return `${pid} (${comm}) ${[state, ppid, ...Array(17).fill("0"), starttime, "0", "0"].join(" ")}\n`;
}

function addPlacementProcess(model, pid, inner, ppid, own = false, starttime = "500") {
  const { m, proc, profile, namespaces, processes } = model;
  const dir = m.directory(String(pid), BigInt(pid) + 100n, 2n); dir.filesystem = 0x9fa0n;
  const data = { stat: processStat(String(pid), String(ppid), starttime),
    status: `Name:\tnode\nPid:\t${pid}\nTgid:\t${pid}\nNSpid:\t${pid}${own ? "" : `\t${inner}`}\nNStgid:\t${pid}${own ? "" : `\t${inner}`}\n`,
    cgroup: own ? "0::/outside\n" : `0::/${profile.hierarchy.case.map(p => p.name).join("/")}/${profile.containerId}\n` };
  for (const [name, text] of Object.entries(data)) {
    const f = m.file(name, text); f.dev = 2n; f.filesystem = 0x9fa0n; dir.children.set(name, f);
  }
  for (const name of ["pid", "cgroup", "time"]) {
    let node = namespaces[name];
    if (own) { node = m.file(name); node.dev = 3n; node.ino = BigInt(profile.namespaces[name].ino); node.filesystem = 0x6e736673n; }
    dir.children.set(`ns/${name}`, node);
  }
  proc.children.set(String(pid), dir); processes[pid] = dir;
  return dir;
}

function activatePlacementModel(model) {
  model.m.nodes.case.children.set(model.profile.containerId, model.leaf);
  addPlacementProcess(model, 1001, 1, 2);
}

function startPlacementProgram(model) {
  addPlacementProcess(model, 1002, 100, 2); addPlacementProcess(model, 1003, 101, 1002);
  model.procs.text = "1003\n1001\n1002\n";
}

/** Kernel-shaped finite port only; never opens cgroups, procfs or a daemon. */
export function placementModel(profile = placementProfile(), options = {}) {
  profile = structuredClone(profile);
  const m = hostModel(options);
  const proc = m.directory("proc", 80n, 2n); proc.filesystem = 0x9fa0n; m.root.children.set("proc", proc);
  const leaf = m.directory(profile.containerId, 90n);
  leaf.children.set("cgroup.type", m.file("cgroup.type", "domain\n"));
  const procs = m.file("cgroup.procs", "1001\n"); leaf.children.set("cgroup.procs", procs);
  const namespaces = {};
  for (const [name, ino] of [["pid", 20], ["cgroup", 21], ["time", 12]]) {
    const n = m.file(name); n.dev = 3n; n.ino = BigInt(ino); n.filesystem = 0x6e736673n; namespaces[name] = n;
  }
  const processes = {};
  const model = { m, proc, profile, namespaces, processes, leaf, procs };
  addPlacementProcess(model, 777, 777, 2, true);
  const open = m.port.open.bind(m.port);
  m.port.open = async (path, flags) => {
    try { return await open(path, flags); }
    catch (error) {
      if (path.endsWith(`/${profile.containerId}`) && !m.nodes.case.children.has(profile.containerId)) {
        throw Object.assign(new Error("finite absent child"), { code: "ENOENT" });
      }
      throw error;
    }
  };
  m.port.statfs = async path => {
    m.calls.push({ kind: "statfs", path });
    const match = /^\/proc\/self\/fd\/(\d+)$/.exec(path);
    if (!match) throw Error("finite invalid descriptor");
    const h = m.handles.get(Number(match[1]));
    return { type: h.node.filesystem ?? 0x63677270n };
  };
  return { ...m, profile, proc, leaf, procs, processes, namespaces,
    activate: () => activatePlacementModel(model), program: () => startPlacementProgram(model),
    addProcess: (...args) => addPlacementProcess(model, ...args) };
}

export function launchObservations(profile, child = true) {
  const common = { operationId: profile.context.operationId, profileSha256: profile.launcherProfileSha256,
    atNs: "1", launcherPid: "100", exitCode: null, signal: null, fds: "oo", cause: null, cleanupError: null };
  return { R: { ...common, kind: "R", childPid: null, attempted: false },
    S: child ? { ...common, kind: "S", childPid: "101", attempted: true } : null, X: null, F: null, E: null };
}

export function placementGate(profile, options = {}) {
  let now = BigInt(profile.context.t0MonotonicNs) + 1n;
  const revocations = []; const reads = [];
  return { gate: { context: { ...profile.context },
    observe() { reads.push("observe"); options.observe?.(); return now; },
    check() { reads.push("check"); options.check?.(); return now; },
    revoke(code) { revocations.push(code); options.revoke?.(code); } },
  revocations, reads, time(value) { now = value; } };
}
