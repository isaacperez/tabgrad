import { mkdtemp, realpath, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { labProfile, labKernelModel } from "./provenance-acquisition-lab.mjs";

export function inputPlan(profile = labProfile()) {
  const p = structuredClone(profile); delete p.context.t0MonotonicNs; delete p.namespaces;
  for (const root of Object.values(p.roots)) delete root.identity;
  for (const tool of Object.values(p.tools)) delete tool.identity;
  p.slice = "system.slice"; return p;
}

/** Presented native metadata is entirely finite. Only protected ordinary output files are real. */
export async function inputModel(options = {}) {
  // Exercise the socket-length constraint even where the platform temp root is long.
  const directory = await realpath(await mkdtemp("/tmp/tg-li-"));
  const profile = labProfile();
  for (const name of ["scratch", "evidence", "tools", "pythonEnvironment"]) {
    profile.roots[name].path = join(directory, name); await mkdir(profile.roots[name].path, { mode: 0o700 });
  }
  for (const [name, tool] of Object.entries(profile.tools)) {
    tool.path = name === "python" ? join(profile.roots.pythonEnvironment.path, "bin/python")
      : join(profile.roots.tools.path, name === "shim" ? "containerd-shim-runc-v2" : name);
    tool.realPath = tool.path;
  }
  const plan = inputPlan(profile); const model = labKernelModel(profile, options); let next = 5000n;
  function route(path) {
    let parent = model.root;
    for (const part of path.split("/").slice(1)) {
      if (!parent.children.has(part)) parent.children.set(part, model.directory(part, next++, 4n));
      parent = parent.children.get(part);
    }
    return parent;
  }
  for (const name of ["scratch", "evidence", "tools", "pythonEnvironment"]) route(profile.roots[name].path);
  for (const tool of Object.values(plan.tools)) {
    const parts = tool.realPath.split("/"); const name = parts.pop(); const parent = route(parts.join("/"));
    const file = model.file(name); file.dev = 5n; file.ino = next++; file.toolBytes = BigInt(tool.bytes);
    parent.children.set(name, file);
  }
  const originalOpen = model.port.open.bind(model.port); let nextToolFd = 10000;
  model.port.open = async (path, flags) => {
    const tool = Object.values(plan.tools).find(t => t.realPath === path);
    let h;
    if (tool) {
      model.calls.push({ kind: "open", path, mode: flags });
      const parts = path.split("/"); const name = parts.pop(); const node = route(parts.join("/")).children.get(name);
      const fd = nextToolFd++;
      h = { fd, node, closed: false, async stat() { return { dev: node.dev, ino: node.ino, nlink: 1n,
        isFile: () => true, isDirectory: () => false }; },
      async read() { throw Error("input observation must not hash tool bytes"); },
      async close() { model.calls.push({ kind: "close", fd }); h.closed = true; h.fd = -1; } };
      model.handles.set(fd, h);
    } else h = await originalOpen(path, flags);
    const originalStat = h.stat.bind(h);
    h.stat = async (...args) => ({ ...await originalStat(...args), mode: h.node.kind === "dir" ? 0o040700n
      : h.node.toolBytes !== undefined ? 0o100700n : 0o100444n, size: h.node.toolBytes ?? BigInt(Buffer.byteLength(h.node.text ?? "")) });
    return h;
  };
  model.port.constants.O_NONBLOCK = 0x800;
  model.port.realpath = async path => { model.calls.push({ kind: "realpath", path }); await options.realpath?.(path); return path; };
  return { ...model, profile, plan, directory, close: () => rm(directory, { recursive: true, force: true }) };
}
