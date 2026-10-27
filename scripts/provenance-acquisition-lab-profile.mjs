import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { constants as bufferConstants } from "node:buffer";
import { acquisitionFields as fields, isAcquisitionHash, isAcquisitionToken, isAcquisitionUint,
  requireAcquisition } from "./provenance-acquisition-record.mjs";
import { freezeHostData } from "./provenance-acquisition-host-profile.mjs";

export const LAB_PROFILE_BYTES = 32 * 1024;
export const LAB_TOOLS = Object.freeze(["node", "python", "env", "systemdRun", "systemctl", "busctl", "dockerd", "containerd", "shim", "runc"]);
export const LAB_ROOTS = Object.freeze(["cgroup", "proc", "scratch", "evidence", "tools", "pythonEnvironment"]);
export const LAB_GROUPS = Object.freeze(["infra", "case", "supervisor", "watchdog", "guard"]);
export const LAB_ERRORS = Object.freeze(["LAB_INPUT", "LAB_PLATFORM", "LAB_PROFILE", "LAB_IDENTITY", "LAB_TOOL",
  "LAB_MANAGER", "LAB_PROTOCOL", "LAB_WORKER", "LAB_READ", "LAB_WRITE", "LAB_LIMIT", "LAB_CLOCK", "LAB_DEADLINE",
  "LAB_STOPPED", "LAB_BUSY", "LAB_CLEANUP", "LAB_PRESERVATION"]);

const check = value => requireAcquisition(value, "LAB_INPUT");
const safe = value => Number.isSafeInteger(value) && value > 0;
const safeUint = value => isAcquisitionUint(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
const identity = value => fields(value, ["dev", "ino"]) && isAcquisitionUint(value.dev)
  && isAcquisitionUint(value.ino) && value.ino !== "0";
const path = value => typeof value === "string" && value.isWellFormed() && isAbsolute(value) && resolve(value) === value
  && value !== "/" && !/[\x00-\x1f\x7f\\]/.test(value) && Buffer.byteLength(value) <= 4096;
const anchor = value => fields(value, ["path", "identity"]) && path(value.path) && identity(value.identity);
const version = value => typeof value === "string" && /^v?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(value)
  && value.length <= 128;

/** Closed preparation inputs. Valid data never admits tools, a host or privilege. */
export function copyLabProfile(input) {
  check(fields(input, ["context", "roots", "slice", "tools", "expected", "limits", "namespaces"])
    && fields(input.context, ["operationId", "t0MonotonicNs", "deadlineNs", "sourceRevision"])
    && isAcquisitionToken(input.context.operationId) && isAcquisitionUint(input.context.t0MonotonicNs)
    && isAcquisitionUint(input.context.deadlineNs) && input.context.deadlineNs !== "0"
    && BigInt(input.context.deadlineNs) % 1000000n === 0n
    && BigInt(input.context.deadlineNs) / 1000000n <= 2147483647n
    && typeof input.context.sourceRevision === "string" && /^[0-9a-f]{40}$/.test(input.context.sourceRevision)
    && fields(input.roots, LAB_ROOTS) && Object.values(input.roots).every(anchor)
    && fields(input.slice, ["name", "identity"]) && input.slice.name === "system.slice" && identity(input.slice.identity)
    && fields(input.tools, LAB_TOOLS)
    && fields(input.expected, ["node", "python", "dockerd", "containerd", "runc", "systemd"])
    && [input.expected.node, input.expected.python, input.expected.dockerd, input.expected.containerd, input.expected.runc].every(version)
    && /^3\.11\.[0-9]+$/.test(input.expected.python)
    && input.expected.dockerd === "29.9.1" && input.expected.systemd === "255"
    && fields(input.namespaces, ["pid", "cgroup", "time"]) && Object.values(input.namespaces).every(identity)
    && fields(input.limits, ["prepareMs", "retireMs", "stopMs", "pollMs", "memoryBytes", "swapBytes", "tasks",
      "cpuPercent", "storageBytes", "observationBytes"]));
  const l = input.limits;
  check([l.prepareMs, l.retireMs, l.stopMs, l.pollMs, l.tasks, l.cpuPercent, l.observationBytes].every(safe)
    && l.pollMs <= Math.min(l.prepareMs, l.retireMs) && l.stopMs <= l.retireMs
    && BigInt(l.prepareMs) + BigInt(l.retireMs) < BigInt(input.context.deadlineNs) / 1000000n
    && l.cpuPercent <= Math.floor(Number.MAX_SAFE_INTEGER / 10000)
    && [l.memoryBytes, l.swapBytes, l.storageBytes].every(safeUint)
    && l.memoryBytes !== "0" && l.storageBytes !== "0" && l.observationBytes < bufferConstants.MAX_LENGTH);
  const ids = new Set();
  for (const root of Object.values(input.roots)) {
    const key = `${root.identity.dev}:${root.identity.ino}`; check(!ids.has(key)); ids.add(key);
  }
  const storage = [input.roots.scratch.path, input.roots.evidence.path, input.roots.tools.path];
  check(storage.every((a, i) => storage.every((b, j) => i === j || a !== b && !a.startsWith(b + "/"))));
  const toolIds = new Set();
  for (const name of LAB_TOOLS) {
    const t = input.tools[name];
    check(fields(t, ["path", "realPath", "identity", "bytes", "sha256"]) && path(t.path) && path(t.realPath) && identity(t.identity)
      && safe(t.bytes) && isAcquisitionHash(t.sha256));
    const key = `${t.identity.dev}:${t.identity.ino}`; check(!toolIds.has(key)); toolIds.add(key);
    if (["dockerd", "containerd", "shim", "runc"].includes(name)) {
      check(t.path === join(input.roots.tools.path, name === "shim" ? "containerd-shim-runc-v2" : name));
    }
  }
  check(input.tools.python.path === join(input.roots.pythonEnvironment.path, "bin", "python"));
  check(new Set(LAB_TOOLS.map(name => input.tools[name].path)).size === LAB_TOOLS.length);
  const p = freezeHostData(JSON.parse(JSON.stringify(input)));
  check(Buffer.byteLength(JSON.stringify(p)) <= LAB_PROFILE_BYTES);
  // Linux sockaddr_un.sun_path has 108 bytes, including its terminating NUL.
  check(Buffer.byteLength(labPaths(p).socket) < 108);
  return p;
}

/** Deterministic paths only; no discovery, filesystem creation or permission. */
export function labPaths(p) {
  const token = p.context.operationId;
  const unit = `tabgrad-lab-${token}.service`;
  const scratch = join(p.roots.scratch.path, token);
  const prefix = join(p.roots.evidence.path, token);
  const group = `/${p.slice.name}/${unit}`;
  return freezeHostData({ unit, scratch, prefix, group, keeper: `${group}/keeper`, work: `${group}/work`,
    infra: `${group}/work/infra`, data: join(scratch, "data"), exec: join(scratch, "exec"),
    socket: join(scratch, "docker.sock"), pid: join(scratch, "dockerd.pid"),
    profile: `${prefix}.profile.json`, configuration: `${prefix}.daemon.json`, ready: `${prefix}.ready.json`,
    workerResult: `${prefix}.worker.json`, retirement: `${prefix}.retirement.json`,
    keeperEntry: fileURLToPath(new URL("./provenance-acquisition-lab-entry.mjs", import.meta.url)) });
}

/** This narrow recipe owns no TCP listener, application network or stock daemon. */
export function labDaemonConfiguration(p) {
  const f = labPaths(p);
  return freezeHostData({ "data-root": f.data, "exec-root": f.exec, pidfile: f.pid, hosts: [`unix://${f.socket}`],
    bridge: "none", iptables: false, ip6tables: false, "ip-forward": false, "ip-masq": false,
    "userland-proxy": false, "storage-driver": "vfs", features: { "containerd-snapshotter": false },
    "exec-opts": ["native.cgroupdriver=cgroupfs"] });
}

export function labManagerArguments(p, profileSha256) {
  requireAcquisition(isAcquisitionHash(profileSha256), "LAB_PROFILE");
  const f = labPaths(p); const l = p.limits;
  const properties = { Slice: p.slice.name, Type: "exec", Delegate: "yes", DelegateSubgroup: "keeper", Restart: "no",
    KillMode: "control-group", KillSignal: "SIGTERM", SendSIGKILL: "yes", FinalKillSignal: "SIGKILL",
    RuntimeMaxSec: `${BigInt(p.context.deadlineNs) / 1000000n}ms`, RuntimeRandomizedExtraSec: "0",
    TimeoutStartSec: `${l.prepareMs}ms`, TimeoutStopSec: `${l.stopMs}ms`, MemoryMax: l.memoryBytes,
    MemorySwapMax: l.swapBytes, TasksMax: String(l.tasks), CPUQuota: `${l.cpuPercent}%`, CollectMode: "inactive",
    WorkingDirectory: f.scratch };
  return Object.freeze(["--system", "--wait", "--quiet", `--unit=${f.unit}`,
    ...Object.entries(properties).map(([key, value]) => `--property=${key}=${value}`),
    p.tools.env.path, "-i", "--", ...Object.entries(labChildEnvironment(p)).map(([key, value]) => `${key}=${value}`),
    p.tools.node.path, f.keeperEntry, "keeper", f.profile, profileSha256]);
}

export function labChildEnvironment(p) {
  return Object.freeze({ PATH: p.roots.tools.path, LANG: "C", LC_ALL: "C" });
}
