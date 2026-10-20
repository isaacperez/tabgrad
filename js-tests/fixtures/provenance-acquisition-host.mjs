/** Synthetic syscall boundary only: never opens a host cgroup or probes /proc. */
export function hostProfile(t0 = "100") {
  return { operationId: "1".repeat(32), t0MonotonicNs: t0, stopAtNs: "10000000", observeUntilNs: "20000000", pollMs: 5,
    root: { path: "/owned", identity: { dev: "1", ino: "1" } },
    groups: Object.fromEntries(["case", "supervisor", "watchdog", "guard"].map((name, i) => [name,
      [{ name, identity: { dev: "1", ino: String(i + 2) } }]])) };
}

export function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function hostModel(options = {}) {
  const handles = new Map();
  const calls = [];
  const flags = { O_RDONLY: 0, O_WRONLY: 1, O_DIRECTORY: 0x10000, O_NOFOLLOW: 0x20000 };
  let nextFD = 10;
  let nextIno = 100n;
  const file = (name, text = "") => ({ name, kind: "file", dev: 1n, ino: nextIno++, nlink: 1n, text });
  const directory = (name, ino, dev = 1n) => ({ name, kind: "dir", dev, ino, nlink: 1n, children: new Map() });
  const root = directory("/", 1n, 9n);
  const owned = directory("owned", 1n);
  root.children.set("owned", owned);
  const nodes = {};
  for (const [i, role] of ["case", "supervisor", "watchdog", "guard"].entries()) {
    const group = directory(role, BigInt(i + 2));
    owned.children.set(role, group); nodes[role] = group;
    for (const [name, text] of [["cgroup.type", "domain\n"], ["cgroup.events", "populated 1\nfrozen 0\n"],
      ["cgroup.procs", options.enter ? "888\n" : `${options.pid ?? 777}\n`], ["cgroup.freeze", ""], ["cgroup.kill", ""]]) group.children.set(name, file(name, text));
  }
  const port = { platform: "linux", constants: flags, pid: options.pid ?? 777,
    async open(path, mode) {
      calls.push({ kind: "open", path, mode });
      if (options.beforeOpen) await options.beforeOpen(path, mode);
      let node;
      if (path === "/") node = root;
      else {
        const match = /^\/proc\/self\/fd\/(\d+)\/(.+)$/.exec(path);
        if (!match) throw new Error("synthetic missing path");
        const parent = handles.get(Number(match[1]));
        if (!parent || parent.closed) throw new Error("synthetic bad descriptor");
        node = parent.node.children.get(match[2]);
      }
      if (!node || node.kind === "symlink" && (mode & flags.O_NOFOLLOW)
        || mode & flags.O_DIRECTORY && node.kind !== "dir") throw new Error("synthetic native path error");
      const fd = nextFD++;
      const handle = { fd, node, mode, closed: false,
        async stat() {
          if (handle.closed) throw new Error("synthetic closed");
          calls.push({ kind: "stat", fd });
          return { dev: node.dev, ino: node.ino, nlink: node.nlink,
            isDirectory: () => node.kind === "dir", isFile: () => node.kind === "file" };
        },
        async read(bytes, offset, length, position) {
          if ((mode & 3) !== flags.O_RDONLY || node.kind !== "file") throw new Error("synthetic access mode");
          calls.push({ kind: "read", fd, name: node.name, length, position });
          if (options.beforeRead) {
            const result = await options.beforeRead(node, bytes, offset, length, position);
            if (result) return result;
          }
          if (handle.closed) throw new Error("synthetic closed read");
          const input = Buffer.from(node.text);
          const count = Math.min(length, Math.max(0, input.length - position), options.shortRead ?? Infinity);
          input.copy(bytes, offset, position, position + count);
          return { bytesRead: count, buffer: bytes };
        },
        async write(bytes, offset, length, position) {
          if ((mode & 3) !== flags.O_WRONLY || node.kind !== "file") throw new Error("synthetic access mode");
          calls.push({ kind: "write", fd, name: node.name, text: bytes.subarray(offset, offset + length).toString(), position });
          if (options.beforeWrite) {
            const result = await options.beforeWrite(node, bytes, offset, length, position);
            if (result) return result;
          }
          if (handle.closed) throw new Error("synthetic closed write");
          if (options.enter && node.name === "cgroup.procs") {
            if (bytes.subarray(offset, offset + length).toString() !== "0") throw new Error("synthetic foreign PID");
            for (const group of Object.values(nodes)) group.children.get("cgroup.procs").text = "888\n";
            node.text = `${port.pid}\n`;
          }
          return { bytesWritten: length, buffer: bytes };
        },
        async close() {
          calls.push({ kind: "close", fd });
          if (options.beforeClose) await options.beforeClose(node, handle);
          handle.closed = true; handle.fd = -1;
        } };
      handles.set(fd, handle);
      return handle;
    },
    async statfs(path) {
      calls.push({ kind: "statfs", path });
      return { type: options.filesystem ?? 0x63677270n };
    } };
  return { port, calls, handles, nodes, root, owned, file, directory };
}
