import { constants } from "node:fs";
import { mkdtemp, realpath, mkdir, lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquisitionSha256 } from "../../scripts/provenance-acquisition-record.mjs";
import { LAB_LAUNCH_FILES } from "../../scripts/provenance-acquisition-lab-diagnostic-profile.mjs";
import { labPaths } from "../../scripts/provenance-acquisition-lab-profile.mjs";
import { labProfile } from "./provenance-acquisition-lab.mjs";
import { diagnosticPlan } from "./provenance-acquisition-lab-diagnostic.mjs";

/** Only the ordinary evidence anchor is real. All descriptor/FIFO/write effects are finite nodes. */
export async function caseFilesModel(options = {}) {
  const directory = await realpath(await mkdtemp("/tmp/tg-case-")); const lab = labProfile(); const plan = diagnosticPlan();
  const evidence = join(directory, "evidence"); await mkdir(evidence, { mode: 0o700 });
  const stat = await lstat(evidence, { bigint: true });
  lab.roots.evidence = { path: evidence, identity: { dev: stat.dev.toString(), ino: stat.ino.toString() } };
  lab.roots.scratch.path = join(directory, "scratch");
  const calls = []; const handles = new Map(); let ino = 1000n; let fd = 10;
  const node = (kind, mode = 0o700n) => ({ kind, mode: (kind === "dir" ? 0o040000n : 0o100000n) | mode,
    uid: 0n, gid: 0n, dev: stat.dev, ino: ino++, bytes: Buffer.alloc(0), children: new Map() });
  const root = node("dir");
  function route(path, create = false) {
    let current = root;
    const magic = /^\/proc\/self\/fd\/(\d+)(?:\/(.*))?$/.exec(path);
    let parts;
    if (magic) { current = handles.get(Number(magic[1]))?.node; parts = (magic[2] ?? "").split("/").filter(Boolean); }
    else parts = path.split("/").filter(Boolean);
    if (!current) throw Error("finite missing descriptor");
    for (const part of parts) {
      if (!current.children.has(part) && create) current.children.set(part, node("dir"));
      current = current.children.get(part); if (!current) throw Object.assign(Error("finite absent"), { code: "ENOENT" });
    }
    return current;
  }
  route(labPaths(lab).scratch, true); const e = route(evidence, true); e.ino = stat.ino;
  for (const name of LAB_LAUNCH_FILES) {
    const path = fileURLToPath(new URL(`../../scripts/${name}`, import.meta.url)); const bytes = await readFile(path);
    plan.launcherFiles[name] = { bytes: bytes.length, sha256: acquisitionSha256(bytes) };
    const parts = path.split("/"); parts.pop(); const parent = route(parts.join("/"), true); const file = node("file", 0o644n);
    file.bytes = bytes; parent.children.set(name, file);
  }
  const port = { constants,
    async mkdir(path, { mode }) {
      calls.push(["mkdir", path]); const at = path.lastIndexOf("/"); const parent = route(path.slice(0, at)); const name = path.slice(at + 1);
      if (parent.children.has(name)) throw Error("finite collision"); parent.children.set(name, node("dir", BigInt(mode)));
    },
    async open(path, flags, mode = 0o600) {
      calls.push(["open", path, flags]); await options.beforeOpen?.(path, flags);
      let value;
      if (flags & constants.O_CREAT) {
        const at = path.lastIndexOf("/"); const parent = route(path.slice(0, at)); const name = path.slice(at + 1);
        if (parent.children.has(name)) throw Error("finite collision"); value = node("file", BigInt(mode)); parent.children.set(name, value);
      } else value = route(path);
      const descriptor = fd++;
      const h = { fd: descriptor, node: value, closed: false,
        async stat() { return { dev: value.dev, ino: value.ino, mode: value.mode, uid: value.uid, gid: value.gid,
          nlink: 1n, size: BigInt(value.bytes.length), mtimeNs: 1n, ctimeNs: 1n,
          isDirectory: () => value.kind === "dir", isFile: () => value.kind === "file" }; },
        async chown(uid, gid) { value.uid = BigInt(uid); value.gid = BigInt(gid); },
        async chmod(mode) { value.mode = value.mode & ~0o777n | BigInt(mode); },
        async truncate(length) { value.bytes = Buffer.alloc(length); calls.push(["truncate", length]); },
        async read(b, offset, length, position) { const count = Math.min(length, Math.max(0, value.bytes.length - position));
          value.bytes.copy(b, offset, position, position + count); return { bytesRead: count }; },
        async write(b, offset, length, position) { const count = Math.min(length, options.shortWrite ?? length);
          b.copy(value.bytes, position, offset, offset + count); return { bytesWritten: count }; },
        async sync() {},
        async close() { calls.push(["close", descriptor]); await options.beforeClose?.(h); h.closed = true; h.fd = -1; } };
      handles.set(descriptor, h); return h;
    } };
  const records = new Map();
  const files = { async json(label, value) {
    if (records.has(label)) throw Error("finite duplicate record"); const bytes = Buffer.from(JSON.stringify(value)); records.set(label, bytes);
    return { label, bytes: bytes.length, sha256: acquisitionSha256(bytes) };
  } };
  const command = async (name, args, settings) => {
    calls.push(["command", name, args]); const input = JSON.parse(settings.stdin); const parent = route(input.root.path);
    const created = ["stdout", "stderr", "control"].map(name => { const fifo = node("fifo", 0o660n); parent.children.set(name, fifo);
      return { name, ready: true, identity: { dev: fifo.dev.toString(), ino: fifo.ino.toString() } }; });
    return { result: { exitCode: 0 }, stdout: Buffer.from(JSON.stringify({ complete: true, error: null, closeUnknown: [], created })), stderr: Buffer.alloc(0) };
  };
  return { lab, plan, calls, handles, port, files, records, command, route,
    close: () => rm(directory, { recursive: true, force: true }) };
}
