import { createServer } from "node:net";
import { once } from "node:events";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { acquisitionFileIdentity } from "../../scripts/provenance-acquisition-file-io.mjs";
import { ACQUISITION_CAPTURE_LIMITS } from "../../scripts/provenance-acquisition-capture.mjs";

export const containerId = "c".repeat(64);
export const execId = "e".repeat(64);
export const observedUtc = "2026-01-02T03:04:05.006Z";
export const output = Buffer.from([0, 255, 1]);
export const errors = Buffer.from([128, 7]);
export function wireFrame(type, payload) {
  const header = Buffer.from([type, 0, 0, 0, 0, 0, 0, 0]); header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}
export const wireOutput = Buffer.concat([wireFrame(1, output), wireFrame(2, errors)]);

export function inspectBody(before, overrides = {}) {
  return { CanRemove: false, DetachKeys: "", ID: execId, Running: false, ExitCode: before ? null : 0,
    ProcessConfig: { tty: false, entrypoint: "/usr/bin/fixture", arguments: ["--finite"], privileged: false, user: "1000:1000" },
    OpenStdin: false, OpenStderr: true, OpenStdout: true, ContainerID: containerId, Pid: before ? 0 : 421, ...overrides };
}

export function jsonReply(socket, value, status = 200) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value) + "\n");
  socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 ${status} fixture\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`), body]));
}

export function upgradeReply(socket, payload = wireOutput, split = 5, contentType = "application/vnd.docker.multiplexed-stream") {
  socket.write(Buffer.concat([Buffer.from(`HTTP/1.1 101 UPGRADED\r\nContent-Type: ${contentType}\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n`), payload.subarray(0, split)]));
  setImmediate(() => { if (!socket.destroyed) socket.end(payload.subarray(split)); });
}

/** Finite raw Unix peer, not Docker. Literal HTTP tests the actual Node parser/upgrade boundary. */
export async function fakeExecDaemon(t, root, reply) {
  const path = join(root, "daemon.sock"); const sockets = new Set(); const requests = []; const failures = [];
  const server = createServer(socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => {});
    let buffered = Buffer.alloc(0);
    const data = bytes => {
      buffered = Buffer.concat([buffered, bytes]);
      const boundary = buffered.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const headers = buffered.subarray(0, boundary).toString("ascii");
      const length = Number(/content-length: (\d+)/i.exec(headers)?.[1] ?? 0);
      if (buffered.length < boundary + 4 + length) return;
      socket.removeListener("data", data);
      const [method, route] = headers.split("\r\n")[0].split(" ");
      const request = { method, route, headers, body: buffered.subarray(boundary + 4), socket, index: requests.length };
      requests.push(request);
      try {
        if (reply?.(request) === true) return;
        if (request.index === 0) jsonReply(socket, { Id: execId }, 201);
        else if (route.endsWith("/start")) upgradeReply(socket);
        else jsonReply(socket, inspectBody(request.index === 1));
      } catch (error) { failures.push(error); socket.destroy(); }
    };
    socket.on("data", data);
  });
  server.listen(path); await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    if (failures.length) throw failures[0];
  });
  return { socket: { path, identity: acquisitionFileIdentity(await lstat(path, { bigint: true })) }, requests };
}

export async function execProfile(root, socket, origin = "100", deadline = "5000000000") {
  const destinations = {};
  for (const [role, capacity] of Object.entries(ACQUISITION_CAPTURE_LIMITS)) {
    const name = `${role}.payload`; const handle = await open(join(root, name), "wx+", 0o600);
    await handle.truncate(capacity);
    destinations[role] = { name, identity: acquisitionFileIdentity(await handle.stat({ bigint: true })) };
    await handle.close();
  }
  return { operationId: "1".repeat(32), socket, containerId,
    command: { argv: ["/usr/bin/fixture", "--finite"], env: ["FIXTURE=finite"], user: "1000:1000", workingDir: "/work" },
    capture: { root, destinations }, timing: { t0MonotonicNs: origin, deadlineNs: deadline,
      processBudgetNs: deadline, pollMs: 5, closeWaitMs: 100 }, limits: { headerBytes: 1024, controlBytes: 2048 } };
}
