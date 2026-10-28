import { acquisitionSha256 } from "../../scripts/provenance-acquisition-record.mjs";
import { labPaths, labDaemonConfiguration } from "../../scripts/provenance-acquisition-lab-profile.mjs";
import { placementModel, placementProfile } from "./provenance-acquisition-placement.mjs";
import { deferred } from "./provenance-acquisition-host.mjs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { labContainerdPaths } from "../../scripts/provenance-acquisition-lab-daemon.mjs";

const id = (dev, ino) => ({ dev: String(dev), ino: String(ino) });

/** Synthetic admitted inputs only; these paths identify no actual host or deployment. */
export function labProfile() {
  const names = ["node", "python", "env", "systemdRun", "systemctl", "busctl", "journalctl", "dockerd", "containerd", "shim", "runc"];
  return { context: { operationId: "1".repeat(32), t0MonotonicNs: "100", deadlineNs: "3000000000", sourceRevision: "a".repeat(40) },
    roots: Object.fromEntries([["cgroup", "/owned", id(1, 1)], ["proc", "/proc", id(2, 80)],
      ["scratch", "/scratch", id(4, 1)], ["evidence", "/evidence", id(4, 2)], ["tools", "/tools", id(4, 3)],
      ["pythonEnvironment", "/prepared/.venv", id(4, 4)]].map(([name, path, identity]) => [name, { path, identity }])),
    slice: { name: "system.slice", identity: id(1, 40) },
    tools: Object.fromEntries(names.map((name, i) => {
      const path = name === "python" ? "/prepared/.venv/bin/python" : "/tools/" + (name === "shim" ? "containerd-shim-runc-v2" : name);
      return [name, { path, realPath: path, identity: id(5, i + 1), bytes: 10, sha256: "b".repeat(64) }];
    })), expected: { node: "22.12.0", python: "3.11.5", dockerd: "29.9.1", containerd: "2.4.2", runc: "1.5.2", systemd: "255" },
    namespaces: { pid: id(3, 10), cgroup: id(3, 11), time: id(3, 12) },
    limits: { prepareMs: 500, retireMs: 200, stopMs: 20, pollMs: 1, memoryBytes: "1048576", swapBytes: "0",
      tasks: 100, cpuPercent: 100, storageBytes: "1048576", observationBytes: 16384 } };
}

export function managerProperties(p, retired = false) {
  const v = (type, data) => ({ type, data });
  const f = labPaths(p); const l = p.limits;
  return { unit: { Id: v("s", f.unit), InvocationID: v("ay", Array(16).fill(1)), Job: v("(uo)", [0, "/"]),
    ActiveState: v("s", retired ? "failed" : "active"), SubState: v("s", retired ? "failed" : "running"), CollectMode: v("s", "inactive") },
  service: { Type: v("s", "exec"), ControlGroup: v("s", f.group), MainPID: v("u", retired ? 0 : 1001),
    ExecMainCode: v("i", retired ? 2 : 0), ExecMainStatus: v("i", retired ? 9 : 0), Result: v("s", retired ? "signal" : "success"),
    Restart: v("s", "no"), Delegate: v("b", true), DelegateSubgroup: v("s", "keeper"), KillMode: v("s", "control-group"),
    KillSignal: v("i", 15), FinalKillSignal: v("i", 9), SendSIGKILL: v("b", true),
    RuntimeMaxUSec: v("t", Number(BigInt(p.context.deadlineNs) / 1000n)), RuntimeRandomizedExtraUSec: v("t", 0),
    TimeoutStartUSec: v("t", l.prepareMs * 1000), TimeoutStopUSec: v("t", l.stopMs * 1000),
    MemoryMax: v("t", Number(l.memoryBytes)), MemorySwapMax: v("t", Number(l.swapBytes)),
    TasksMax: v("t", l.tasks), CPUQuotaPerSecUSec: v("t", l.cpuPercent * 10000) } };
}
export const propertyBytes = value => Buffer.from(JSON.stringify({ type: "a{sv}", data: [value] }));

/** Existing finite proc/cgroup port extended only with the lab's mkdir and control effects. */
export function labKernelModel(p = labProfile(), options = {}) {
  let m; const f = labPaths(p);
  m = placementModel(placementProfile(), { ...options, async beforeWrite(node, ...args) {
    if (options.beforeWrite) { const result = await options.beforeWrite(node, ...args); if (result) return result; }
    if (node.name === "cgroup.procs") {
      node.text = "777\n"; m.processes[777].children.get("cgroup").text = `0::${f.infra}\n`;
    }
  } });
  let next = 2000n;
  function group(name, ino = next++) {
    const g = m.directory(name, ino);
    for (const [key, text] of [["cgroup.type", "domain\n"], ["cgroup.events", "populated 0\nfrozen 1\n"],
      ["cgroup.procs", ""], ["cgroup.freeze", ""], ["cgroup.kill", ""]]) g.children.set(key, m.file(key, text));
    return g;
  }
  const slice = group("system.slice", 40n); const unit = group(f.unit); const keeper = group("keeper");
  m.owned.children.set("system.slice", slice); slice.children.set(f.unit, unit); unit.children.set("keeper", keeper);
  m.port.mkdir = async path => {
    m.calls.push({ kind: "mkdir", path });
    const match = /^\/proc\/self\/fd\/(\d+)\/([^/]+)$/.exec(path);
    const parent = m.handles.get(Number(match?.[1]))?.node;
    if (!parent || parent.children.has(match[2])) throw new Error("finite collision");
    parent.children.set(match[2], group(match[2]));
  };
  return { ...m, slice, unit, keeper };
}

/** Whole exterior IO fixture; emitted bytes stay independent of the production manager parser. */
export function labNativePorts(p = labProfile(), mutate = () => {}) {
  const calls = []; const records = new Map(); const retirementRecords = new Map(); const childRecords = new Map();
  const originals = new Map(); const fileIdentities = new Map(); const waiterDone = deferred();
  let nextFileIdentity = 51;
  const f = labPaths(p); let retired = false; let invocation = null;
  const processes = Object.fromEntries([["keeper", 1001], ["worker", 1002], ["dockerd", 1003], ["containerd", 1004]].map(([name, pid]) => [name,
    { pid: String(pid), starttime: "500", procIdentity: id(2, pid), membership: name === "keeper" ? f.keeper : f.infra,
      namespacePids: [String(pid)], namespaces: p.namespaces }]));
  const groups = { unit: id(1, 2001), keeper: id(1, 2002) };
  const record = async (label, bytes, owner = records) => {
    calls.push(["write", label]); if (originals.has(label)) throw new Error("finite collision");
    bytes = Buffer.from(bytes); originals.set(label, bytes);
    const r = { label, bytes: bytes.length, sha256: acquisitionSha256(bytes) }; owner.set(label, r); return r;
  };
  const files = { roots: async () => {}, scratch: async () => { calls.push(["scratch"]); },
    verifyTool: async name => { calls.push(["tool", name]); }, write: record,
    json: (label, value) => record(label, Buffer.from(JSON.stringify(value))),
    read: async label => originals.has(label) ? Buffer.from(originals.get(label)) : null,
    readJson: async label => originals.has(label) ? JSON.parse(originals.get(label)) : null,
    verifyPrefix: async (label, file, channel) => {
      calls.push(["verify-prefix", label]); const bytes = originals.get(label);
      if (!bytes || !file || !channel || fileIdentities.get(label) !== file.identity || bytes.length !== file.capacity
        || acquisitionSha256(bytes.subarray(0, channel.confirmedBytes)) !== channel.sha256) throw Error("finite missing or changed prefix");
    },
    snapshot: () => ({ records: Object.fromEntries(records), handles: { retained: 0 } }) };
  const retirementFiles = { ...files, write: (label, bytes) => record(label, bytes, retirementRecords),
    json: (label, value) => record(label, Buffer.from(JSON.stringify(value)), retirementRecords),
    snapshot: () => ({ records: Object.fromEntries(retirementRecords), handles: { retained: 0 } }) };
  const empty = () => ({ handles: { retained: 0 } });
  const kernel = { open: async () => ({ data: { ...processes.worker, membership: "/outside" }, originals: {} }),
    unit: async () => {}, group: async () => {}, identities: async () => groups,
    process: async role => ({ data: processes[role], originals: {} }), close: async () => {}, snapshot: empty,
    effect: async target => {
      calls.push(["effect", target]);
      if (target === "unit.kill") { retired = true; waiterDone.resolve(); }
    }, observe: async target => ({ value: { populated: target !== "work", frozen: target === "keeper" },
      bytes: Buffer.from(target === "keeper" ? "populated 1\nfrozen 1\n" : "populated 0\nfrozen 0\n") }) };
  const exit = code => ({ closed: true, exited: true, firstFailure: null, cleanupError: null, exitCode: code, signal: null });
  const command = async (name, args, options) => {
    calls.push(["command", name, [...args], options.env]); options.check();
    let stdout = Buffer.alloc(0); let result;
    if (name === "systemdRun") {
      const hash = acquisitionSha256(Buffer.from(JSON.stringify(p)));
      const childJson = (label, value) => record(label, Buffer.from(JSON.stringify(value)), childRecords);
      const capture = (label, first) => {
        const channels = {}; const files = {};
        for (const role of ["stdout", "stderr"]) {
          const data = Buffer.from(role === "stdout" ? first : ""); const raw = Buffer.alloc(p.limits.observationBytes); data.copy(raw);
          const identity = `1:${nextFileIdentity++}`; const key = `${label}.${role}`;
          originals.set(key, raw); fileIdentities.set(key, identity);
          channels[role] = { confirmedBytes: data.length, submittedBytes: data.length, sha256: acquisitionSha256(data) };
          files[role] = { identity, capacity: raw.length };
        }
        return { capture: { files, channels }, closed: false };
      };
      await childJson("keeper.json", { kind: "lab_keeper_v1", operationId: p.context.operationId, profileSha256: hash,
        process: processes.keeper, groups });
      await childJson("keeper.launch.json", { profileSha256: hash, command: capture("worker-launch", "") });
      const worker = await childJson("worker.source.json", { finite: true });
      await childJson("ready.json", { kind: "lab_ready_v1", operationId: p.context.operationId, profileSha256: hash,
        entry: "verified", processes, evidence: { preservationComplete: true, records: [worker], commands: { daemon: capture("daemon", "abc") } } });
      result = waiterDone.promise.then(() => exit(137));
    } else {
      if (name === "busctl") {
        const props = managerProperties(p, retired); if (invocation) props.unit.InvocationID.data = invocation;
        if (args.includes("GetUnit")) stdout = Buffer.from(JSON.stringify({ type: "o", data: ["/org/freedesktop/systemd1/unit/finite"] }));
        else stdout = propertyBytes(args.at(-1).endsWith(".Unit") ? props.unit : props.service);
      }
      result = Promise.resolve(exit(0));
    }
    const value = { result, stop() { calls.push(["stop", name]); },
      collect: async role => Buffer.from(role === "stdout" ? stdout : ""), snapshot: () => exit(retired ? 137 : 0) };
    mutate({ name, args, options, value, records, originals, processes, groups,
      changeInvocation: next => { invocation = next; } }); return value;
  };
  return { kernel, files, retirementFiles, command, calls, records, originals, processes, groups, childRecords, fileIdentities };
}

/** Worker recipe model. No host reads, Docker process, server, image or socket is created. */
export function labWorkerPorts(p = labProfile(), options = {}) {
  const ports = labNativePorts(p); const calls = ports.calls; const paths = labContainerdPaths(p); const f = labPaths(p);
  const daemon = deferred(); const ready = deferred(); const raw = new Map(); let entered = false;
  const generated = { version: 2, root: paths.root, state: paths.state, imports: [], grpc: { address: paths.grpc },
    debug: { address: paths.debug }, metrics: {}, proxy_plugins: {}, ttrpc: {} };
  const effective = { ...structuredClone(generated), version: 4, ttrpc: { address: paths.ttrpc } };
  raw.set(paths.config, Buffer.from("version = 2\n")); raw.set(paths.pid, Buffer.from("1004\n"));
  raw.set(f.configuration, Buffer.from(JSON.stringify(labDaemonConfiguration(p))));
  raw.set(`${p.roots.proc.path}/1004/cmdline`, Buffer.from(`${p.tools.containerd.path}\0--config\0${paths.config}\0`));
  ports.processes.dockerd.ppid = "1002"; ports.processes.containerd.ppid = "1003";
  ports.kernel.enterWorker = async () => { calls.push(["entry"]); if (options.entryFailure) throw Error("finite entry failure"); entered = true; };
  ports.kernel.snapshot = () => ({ entry: entered ? "verified" : "not_requested", handles: { retained: 0, unknown: 0 } });
  const writeJson = ports.files.json;
  ports.files.json = async (label, value) => { const result = await writeJson(label, value); if (label === "ready.json") ready.resolve(); return result; };
  const partialWrite = ports.retirementFiles.write; const partialJson = ports.retirementFiles.json;
  ports.retirementFiles.write = (label, bytes) => {
    if (options.partialWriteFailure === "body" && label === "docker.info.partial.body") throw Error("finite preservation failure");
    return partialWrite(label, bytes);
  };
  ports.retirementFiles.json = (label, value) => {
    if (options.partialWriteFailure === "metadata" && label === "docker.info.partial.response.json") throw Error("finite preservation failure");
    return partialJson(label, value);
  };
  const version = { Version: "29.9.1", ApiVersion: "1.56", MinAPIVersion: "1.44", Os: "linux", Arch: "amd64" };
  const info = { Driver: "vfs", CgroupDriver: "cgroupfs", CgroupVersion: "2", DockerRootDir: f.data,
    Containers: 0, Images: 0, LiveRestoreEnabled: false };
  ports.pid = 1002;
  ports.filesystem = {
    async lstat(path) {
      calls.push(["lstat", path]);
      if (path === "/run/containerd/containerd.sock" && !options.stock) throw Object.assign(Error("finite absent"), { code: "ENOENT" });
      return { isSocket: () => true, isSymbolicLink: () => false, mode: 0o660n, dev: 1n, ino: 2n };
    },
    async realpath(path) { calls.push(["realpath", path]); return p.tools.containerd.realPath; },
    async open(path) {
      calls.push(["raw", path]); const bytes = raw.get(path); if (!bytes) throw Error("finite missing input");
      return { async stat() { return { dev: 1n, ino: 2n, nlink: 1n, size: BigInt(bytes.length),
        mtimeNs: 1n, ctimeNs: 1n, isFile: () => true }; },
      async read(buffer, offset, length, position) { const count = Math.min(length, Math.max(0, bytes.length - position));
        bytes.copy(buffer, offset, position, position + count); return { bytesRead: count }; },
      async close() { calls.push(["raw-close", path]); } };
    },
  };
  ports.command = async (name, args, settings) => {
    calls.push(["command", name, args, settings.env]);
    if (!entered) throw Error("finite tool before entry");
    settings.check(); let stdout = "";
    const versions = { node: "v22.12.0\n", python: "Python 3.11.5\n", dockerd: "Docker version 29.9.1, build finite\n",
      containerd: "containerd github.com/containerd/containerd/v2 v2.4.2 finite\n", runc: "runc version 1.5.2\n", systemctl: "systemd 255 (finite)\n" };
    if (args.includes("--version")) stdout = versions[name];
    else if (name === "python") stdout = JSON.stringify(settings.label.includes("generated") ? generated : effective);
    const running = name === "dockerd" && !args.includes("--validate") && !args.includes("--version");
    const state = { closed: !running, exited: !running, exitCode: 0, signal: null, pid: running ? 1003 : 999,
      firstFailure: null, cleanupError: null };
    const result = running ? daemon.promise.then(() => ({ ...state, closed: true, exited: true })) : Promise.resolve(state);
    return { result, snapshot: () => ({ ...state }), collect: async role => Buffer.from(role === "stdout" ? stdout : ""),
      stop() { daemon.resolve(); } };
  };
  ports.request = settings => {
    calls.push(["request", settings]); const req = new EventEmitter(); let response;
    req.end = () => queueMicrotask(() => {
      response = new PassThrough(); response.statusCode = 200; response.complete = true;
      response.httpVersion = "1.1"; response.rawHeaders = ["Content-Type", "application/json"];
      response.once("close", () => req.emit("close"));
      req.emit("response", response);
      if (options.httpFailure && settings.path.endsWith("info")) {
        response.complete = false; response.write('{"Driver":"');
        setImmediate(() => response.destroy(new Error("finite private reset")));
      } else response.end(JSON.stringify(settings.path.endsWith("version") ? version : info));
    });
    req.destroy = () => { response?.destroy(); req.emit("close"); }; return req;
  };
  return { ...ports, raw, ready: ready.promise, endDaemon: () => daemon.resolve(), generated, effective, info };
}
