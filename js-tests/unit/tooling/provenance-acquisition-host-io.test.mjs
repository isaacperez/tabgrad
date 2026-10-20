import assert from "node:assert/strict";
import { test } from "node:test";
import { openAcquisitionHost, parseHostEvents } from "../../../scripts/provenance-acquisition-host-io.mjs";
import { copyHostProfile } from "../../../scripts/provenance-acquisition-host-profile.mjs";
import { hostModel, hostProfile, deferred } from "../../fixtures/provenance-acquisition-host.mjs";

const writes = m => m.calls.filter(c => c.kind === "write");
const rejection = (work, code) => assert.rejects(work, error => error.code === code && error.message === code);

test("native adapter uses retained descriptor paths, fixed flags/files and exact own membership", async () => {
  const m = hostModel({ shortRead: 1 });
  const io = await openAcquisitionHost(hostProfile(), "supervisor", m.port);
  assert.deepEqual(await io.observe(), { populated: true, frozen: false });
  assert.deepEqual(writes(m), []);
  await Promise.all([io.freeze(), io.kill()]);
  assert.deepEqual(writes(m).map(c => [c.name, c.text, c.position]), [["cgroup.freeze", "1", 0], ["cgroup.kill", "1", 0]]);
  assert.equal(io.snapshot().freeze.state, "acknowledged");
  for (const call of m.calls.filter(c => c.kind === "open")) {
    assert.equal((call.mode & m.port.constants.O_NOFOLLOW) !== 0, true);
    if (call.path !== "/") assert.match(call.path, /^\/proc\/self\/fd\/[0-9]+\/[A-Za-z0-9_.@-]+$/);
  }
  const close = io.close();
  assert.equal(io.close(), close);
  assert.equal((await close).ioClosed, "closed");
  assert.equal([...m.handles.values()].every(h => h.closed), true);
  assert.equal(m.calls.filter(c => c.kind === "close").length, m.handles.size);
  assert.throws(() => io.observe(), { code: "HOST_STOPPED" });
});

test("each actor and external guard opens a separate direct route to the same target", async () => {
  const m = hostModel();
  const all = await Promise.all(["supervisor", "watchdog", "guard"].map(r => openAcquisitionHost(hostProfile(), r, m.port)));
  await Promise.all(all.map(io => io.kill()));
  const fd = writes(m).map(c => c.fd);
  assert.equal(new Set(fd).size, 3);
  assert.equal(fd.every(d => m.handles.get(d).node === m.nodes.case.children.get("cgroup.kill")), true);
  await Promise.all(all.map(io => io.close()));
});

test("bad platform/profile/accessors and ancestor aliases fail before any native opening", async () => {
  const configurations = [];
  const path = hostProfile(); path.root.path = "/owned/../other"; configurations.push(path);
  const role = hostProfile(); role.groups.watchdog = role.groups.case; configurations.push(role);
  const alias = hostProfile(); alias.groups.watchdog[0].identity = alias.groups.case[0].identity; configurations.push(alias);
  const ancestor = hostProfile(); ancestor.groups.watchdog = [...ancestor.groups.case, { name: "nested", identity: { dev: "1", ino: "9" } }]; configurations.push(ancestor);
  const future = hostProfile(); future.stopAtNs = future.observeUntilNs; configurations.push(future);
  let reads = 0;
  const accessor = hostProfile(); Object.defineProperty(accessor.groups.case, "0", { enumerable: true, get() { reads++; throw Error("getter"); } }); configurations.push(accessor);
  const exotic = hostProfile(); Object.setPrototypeOf(exotic.groups.case, { toJSON() { reads++; } }); configurations.push(exotic);
  const extra = hostProfile(); extra.groups.case.extra = true; configurations.push(extra);
  for (const p of configurations) {
    const m = hostModel();
    await rejection(openAcquisitionHost(p, "supervisor", m.port), "HOST_INPUT");
    assert.deepEqual(m.calls, []);
  }
  assert.equal(reads, 0);
  const m = hostModel(); m.port.platform = "darwin";
  await rejection(openAcquisitionHost(hostProfile(), "supervisor", m.port), "HOST_PLATFORM");
  assert.deepEqual(m.calls, []);
});

test("filesystem, effective identity, removed nodes, domain and own membership are independently checked", async () => {
  const cases = [
    [m => { m.port.statfs = async () => ({ type: 1n }); }, "HOST_FILESYSTEM"],
    [m => { m.nodes.case.ino = 99n; }, "HOST_IDENTITY"],
    [m => { m.nodes.case.nlink = 0n; }, "HOST_IDENTITY"],
    [m => { m.nodes.case.kind = "symlink"; }, "HOST_OPEN"],
    [m => { m.nodes.watchdog.children.get("cgroup.type").text = "threaded\n"; }, "HOST_TYPE"],
    [m => { m.nodes.supervisor.children.get("cgroup.procs").text = "888\n"; }, "HOST_MEMBER"],
    [m => { m.nodes.case.children.get("cgroup.freeze").dev = 2n; }, "HOST_IDENTITY"],
    [m => { m.nodes.case.children.delete("cgroup.kill"); }, "HOST_OPEN"],
  ];
  for (const [change, code] of cases) {
    const m = hostModel(); change(m);
    await rejection(openAcquisitionHost(hostProfile(), "supervisor", m.port), code);
    assert.deepEqual(writes(m), []);
    assert.equal([...m.handles.values()].every(h => h.closed), true);
  }
});

test("control file handles do not retarget a replacement path and writes are never retried", async () => {
  const m = hostModel();
  const oldKill = m.nodes.case.children.get("cgroup.kill");
  const io = await openAcquisitionHost(hostProfile(), "supervisor", m.port);
  m.owned.children.set("case", m.directory("replacement", 99n));
  const a = io.kill(); const b = io.kill();
  assert.equal(a, b); await a;
  assert.equal(m.handles.get(writes(m)[0].fd).node, oldKill);
  assert.equal(writes(m).length, 1);
  await io.close();
});

test("short/ambiguous writes remain unknown; failed freeze does not consume the kill route", async () => {
  for (const count of [0, 2, "1", null]) {
    const m = hostModel({ beforeWrite(node) {
      if (node.name === "cgroup.freeze") {
        if (count === null) throw Error("synthetic private diagnostic");
        return { bytesWritten: count };
      }
    } });
    const io = await openAcquisitionHost(hostProfile(), "watchdog", m.port);
    const a = io.freeze();
    await rejection(a, "HOST_WRITE");
    assert.equal(io.freeze(), a);
    await rejection(io.freeze(), "HOST_WRITE");
    await io.kill();
    assert.equal(io.snapshot().freeze.state, "unknown");
    assert.equal(io.snapshot().kill.state, "acknowledged");
    assert.equal(writes(m).length, 2);
    await io.close();
  }
});

test("close joins admitted read/writes, rejects new work and records failed closure separately", async () => {
  const held = deferred();
  const m = hostModel({ beforeWrite: () => held.promise });
  const io = await openAcquisitionHost(hostProfile(), "guard", m.port);
  const effect = io.kill();
  const close = io.close();
  assert.equal(io.snapshot().ioClosed, "pending");
  assert.equal(m.calls.some(c => c.kind === "close"), false);
  assert.throws(() => io.freeze(), { code: "HOST_STOPPED" });
  held.resolve({ bytesWritten: 1 }); await effect; await close;
  assert.equal(io.snapshot().ioClosed, "closed");
  const fail = hostModel({ beforeClose: () => { throw Error("native close detail"); } });
  const second = await openAcquisitionHost(hostProfile(), "guard", fail.port);
  assert.equal((await second.close()).ioClosed, "unknown");
  assert.equal(fail.calls.filter(c => c.kind === "close").length, fail.handles.size);
});

test("opening preserves its primary failure when closing a partially opened set fails", async () => {
  const m = hostModel({ filesystem: 1n, beforeClose: () => { throw Error("close"); } });
  await assert.rejects(openAcquisitionHost(hostProfile(), "watchdog", m.port), e => e.code === "HOST_FILESYSTEM" && e.closeError === "HOST_CLOSE");
  assert.deepEqual(writes(m), []);
});

test("closed event profile detects duplication, truncation, extensions, encoding and byte overflow", async () => {
  assert.deepEqual(parseHostEvents("frozen 1\npopulated 0\n"), { frozen: true, populated: false });
  for (const text of ["", "populated 0\n", "populated 0\nfrozen 1", "populated 0\npopulated 1\n", "populated 0\nfrozen 2\n",
    "populated 0\nfrozen 1\nnew 0\n", "populated 0\nfrozen 1\r\n", " ".repeat(129)]) {
    assert.throws(() => parseHostEvents(text), { code: "HOST_READ" });
  }
  for (const text of ["x".repeat(129), "populated 0\nfrozen 1\n\u0000"]) {
    const m = hostModel(); m.nodes.case.children.get("cgroup.events").text = text;
    const io = await openAcquisitionHost(hostProfile(), "guard", m.port);
    await rejection(io.observe(), "HOST_READ");
    assert.equal(m.calls.filter(c => c.kind === "read" && c.name === "cgroup.events").every(c => c.length <= 129), true);
    await io.close();
  }
  assert.equal(copyHostProfile(hostProfile()).pollMs, 5);
});
