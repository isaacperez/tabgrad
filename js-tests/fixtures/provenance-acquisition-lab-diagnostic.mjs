import { LAB_LAUNCH_FILES } from "../../scripts/provenance-acquisition-lab-diagnostic-profile.mjs";
import { acquisitionSha256 } from "../../scripts/provenance-acquisition-record.mjs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/** Synthetic expected metadata only; no image, archive or credential is operationally admitted. */
export function diagnosticPlan() {
  return { schemaVersion: 1, sourceRevision: "a".repeat(40),
    operations: { A: "2".repeat(32), B: "3".repeat(32), C: "4".repeat(32) },
    image: { archive: { path: "/prepared/image.tar", identity: { dev: "7", ino: "1" }, bytes: 1024, sha256: "b".repeat(64) },
      id: "sha256:" + "c".repeat(64), nodePath: "/runtime/node", nodeSha256: "d".repeat(64), configSha256: "e".repeat(64) },
    launcherFiles: Object.fromEntries(LAB_LAUNCH_FILES.map(name => [name, { bytes: 10, sha256: "f".repeat(64) }])),
    credentials: { uid: "12345", gid: "12345", groups: ["12345", "12346"] },
    timing: { deadlineNs: "180000000", workUntilNs: "80000000", observeUntilNs: "120000000", processBudgetNs: "60000000",
      holdMs: 10, descendantMs: 200, pollMs: 1, closeWaitMs: 30,
      process: { heartbeatMs: 1, peerTimeoutMs: 10, termAfterMs: 1, killAfterMs: 10, closeWaitMs: 30 } },
    evidenceRefs: { authorizationRef: "5".repeat(32), inputEvidenceSha256: "1".repeat(64),
      toolEvidenceSha256: "2".repeat(64), clockEvidenceSha256: "3".repeat(64) },
    limits: { responseBytes: 1048576, headerBytes: 16384, controlBytes: 16384, procsBytes: 16384, maxProcesses: 100 } };
}

/** Finite Docker-shaped requests and archive metadata, never a real socket, archive or daemon. */
export function diagnosticDockerModel(options = {}) {
  const plan = diagnosticPlan(); const archive = Buffer.from("opaque finite archive input");
  plan.image.archive.bytes = archive.length; plan.image.archive.sha256 = acquisitionSha256(archive);
  const image = { Id: plan.image.id, Os: "linux", Architecture: "amd64", Config: { Env: [], Volumes: null, ExposedPorts: null } };
  plan.image.configSha256 = acquisitionSha256(JSON.stringify(image.Config));
  const originals = new Map(); const requests = []; const containers = new Map(); let archiveClosed = false; let reads = 0;
  const files = { async write(label, bytes, limit) {
    if (options.failWrite?.(label)) throw Error("finite preservation failure");
    if (originals.has(label) || bytes.length > limit) throw Error("finite evidence limit/collision");
    originals.set(label, Buffer.from(bytes)); return { label, bytes: bytes.length, sha256: acquisitionSha256(bytes) };
  }, json(label, value, limit) { return files.write(label, Buffer.from(JSON.stringify(value)), limit); } };
  const socket = { path: "/prepared/docker.sock", identity: { dev: "9", ino: "1" } };
  const filesystem = { constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000, O_NONBLOCK: 0x800 },
    async lstat() { return { dev: 9n, ino: 1n, isSocket: () => true, isSymbolicLink: () => false }; },
    async open() { return { async stat() { return { dev: 7n, ino: 1n, nlink: 1n, size: BigInt(archive.length), mode: 0o100600n,
      mtimeNs: 1n, ctimeNs: 1n, isFile: () => true }; },
    async read(b, offset, length, position) { reads++; const count = Math.min(length, Math.max(0, archive.length - position));
      archive.copy(b, offset, position, position + count); return { bytesRead: count }; },
    async close() { archiveClosed = true; } }; } };
  const request = settings => {
    const req = new EventEmitter(); let response;
    req.destroy = () => { response?.destroy(); req.emit("close"); };
    req.end = body => {
      const record = { ...settings, body: Buffer.from(body), request: req }; requests.push(record);
      queueMicrotask(async () => {
        await options.beforeResponse?.(record);
        let status = 200; let value;
        if (settings.path.includes("images/load")) value = { stream: "Loaded image\n" };
        else if (settings.path.includes("images/json")) value = [{ Id: plan.image.id }];
        else if (settings.path.includes("images/")) value = structuredClone(image);
        else if (settings.path.includes("containers/create")) {
          status = 201; const operationId = new URL("http://docker" + settings.path).searchParams.get("name").slice("tabgrad-case-".length);
          const id = String(containers.size + 1).repeat(64); containers.set(id, { operationId, body: JSON.parse(body) });
          value = { Id: id, Warnings: [] };
        } else {
          const id = settings.path.split("/").at(-2); const { operationId, body: c } = containers.get(id);
          value = { Id: id, Name: `/tabgrad-case-${operationId}`, Image: c.Image, Config: { ...c }, HostConfig: c.HostConfig,
            Path: c.Entrypoint[0], Args: c.Entrypoint.slice(1), State: { Status: "created", Running: false,
              Paused: false, Restarting: false, Dead: false, Pid: 0, Error: "" },
            Mounts: c.HostConfig.Mounts.map(m => ({ Type: "bind", Source: m.Source, Destination: m.Target, RW: !m.ReadOnly, Propagation: "rprivate" })) };
          // Match the selected Go wire types: empty bind booleans are omitted.
          for (const mount of value.HostConfig.Mounts) {
            if (mount.ReadOnly === false) delete mount.ReadOnly;
            delete mount.BindOptions.CreateMountpoint;
          }
        }
        const result = { status, value }; options.response?.(settings, result);
        response = new PassThrough(); response.statusCode = result.status; response.httpVersion = "1.1";
        response.rawHeaders = ["Content-Type", "application/json"]; response.complete = true;
        options.stream?.(settings, response);
        response.once("close", () => req.emit("close")); req.emit("response", response);
        response.end(JSON.stringify(result.value) + (settings.path.includes("images/load") ? "\n" : ""));
      });
    }; return req;
  };
  return { plan, image, archive, requests, containers, originals, files, socket, filesystem, request,
    observed: () => ({ archiveClosed, reads }) };
}
