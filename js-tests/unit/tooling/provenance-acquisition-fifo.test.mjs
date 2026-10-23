import assert from "node:assert/strict";
import { constants } from "node:fs";
import { mkdtemp, realpath, open, rm, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import { test } from "node:test";
import { createAcquisitionFifos } from "../../../scripts/provenance-acquisition-fifo.mjs";
import { FIFO_LIMITS as limits } from "../../../scripts/provenance-acquisition-fifo-profile.mjs";
import { FIFO_OPEN_FLAGS, openFifoEndpoint, verifyFifoStat, fifoNativePorts } from "../../../scripts/provenance-acquisition-fifo-io.mjs";
import { acquisitionFileIdentity } from "../../../scripts/provenance-acquisition-file-io.mjs";
import { openAcquisitionPayload } from "../../../scripts/provenance-acquisition-payload.mjs";

const roles = ["stdout", "stderr", "control"];
function deferred() {
  let resolve; let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function profile() {
  return { ipc: { root: { path: "/tmp/fifo-fixture", identity: { dev: "1", ino: "1" } },
    ...Object.fromEntries(roles.map((role, i) => [role, { name: role, identity: { dev: "1", ino: String(i + 2) } }])) },
  timing: { t0MonotonicNs: "100", workUntilNs: "1000000000", closeUntilNs: "2000000000", pollMs: 1 } };
}
async function until(predicate, turns = 100) {
  for (let i = 0; i < turns; i++) { if (predicate()) return; await turn(); }
  assert.fail("finite local observation did not arrive");
}
/** Finite metadata/clock/transfer doubles, never an actual FIFO or timing qualification. */
function fixture(t, options = {}) {
  const input = profile(); let now = 101n; let roots = 0;
  const opened = []; const timers = new Set(); const reads = []; const held = [];
  const output = Object.fromEntries(roles.map(role => [role, []]));
  const streams = Object.fromEntries(roles.map(role => [role, [...(options.streams?.[role] ?? [])]]));
  const ports = {
    clock: () => options.clock ? options.clock(now) : now,
    root: async expected => { roots++; await options.root?.(expected, roots); },
    open: async (path, kind) => {
      const role = basename(path); const index = opened.length;
      const h = { role, kind, path, closes: 0, async stat() {
        const result = await options.stat?.(h);
        if (result !== undefined) return result;
        const expected = input.ipc[role].identity;
        return { dev: BigInt(expected.dev), ino: BigInt(expected.ino), isFIFO: () => true };
      } };
      opened.push(h);
      await options.open?.(h, index);
      return h;
    },
    async read(h, buffer, length) {
      reads.push({ role: h.role, buffer, length });
      if (options.read) return options.read(h, buffer, length, reads);
      const item = streams[h.role][0];
      if (item instanceof Error) { streams[h.role].shift(); throw item; }
      if (!item) return { bytesRead: 0 };
      const n = Math.min(item.length, length); item.copy(buffer, 0, 0, n);
      if (n === item.length) streams[h.role].shift(); else streams[h.role][0] = item.subarray(n);
      return { bytesRead: n };
    },
    async close(h) { h.closes++; assert.equal(h.closes, 1); await options.close?.(h); },
    schedule(callback, ms) {
      const timer = { callback, due: now + BigInt(ms) * 1000000n, immediate: null };
      timers.add(timer);
      if (!ms) timer.immediate = setImmediate(() => { if (timers.delete(timer)) callback(); });
      options.schedule?.(timer, ms);
      return timer;
    },
    cancel(timer) { timers.delete(timer); if (timer.immediate) clearImmediate(timer.immediate); options.cancel?.(timer); },
  };
  const owner = createAcquisitionFifos(input, ports);
  const sinks = Object.fromEntries(roles.map(role => [role, async bytes => {
    output[role].push(Buffer.from(bytes)); await options.sink?.(role, bytes);
  }]));
  t.after(async () => {
    for (const d of held) d.resolve();
    owner.stop(); await turn();
    now = 2000000100n;
    for (const timer of [...timers]) { if (timers.delete(timer)) timer.callback(); }
    await owner.close();
    for (const timer of timers) if (timer.immediate) clearImmediate(timer.immediate);
  });
  return { owner, input, ports, opened, reads, output, sinks, timers, streams,
    get roots() { return roots; },
    hold() { const d = deferred(); held.push(d); return d; },
    time(value) { now = value; },
    advance(value) { now = value; for (const timer of [...timers]) if (timer.due <= now && timers.delete(timer)) timer.callback(); },
  };
}

test("closed FIFO profile rejects malformed data without invoking getters or native operations", () => {
  const bad = [];
  const add = change => { const p = profile(); change(p); bad.push(p); };
  add(p => { p.extra = true; });
  add(p => { p.ipc.stdout.name = "../stdout"; });
  add(p => { p.ipc.stdout.name = p.ipc.stderr.name; });
  add(p => { p.ipc.stdout.identity = p.ipc.root.identity; });
  add(p => { p.ipc.stderr.identity.ino = "02"; });
  add(p => { p.ipc.stderr.identity.ino = "0"; });
  add(p => { p.ipc.root.path = "/tmp/../tmp/x"; });
  add(p => { p.ipc.root.path = "/" + "a/".repeat(64) + "a"; });
  add(p => { p.ipc.root.path = "/" + "a".repeat(4090); p.ipc.stdout.name = "123456"; });
  add(p => { p.timing.pollMs = 0; }); add(p => { p.timing.pollMs = 5001; });
  add(p => { p.timing.workUntilNs = "0"; });
  add(p => { p.timing.closeUntilNs = "2147483647000001"; });
  add(p => { p.timing.closeUntilNs = "1"; });
  add(p => { p.timing.t0MonotonicNs = "18446744073709551616"; });
  add(p => { Object.defineProperty(p.ipc.stdout, "name", { get() { assert.fail("profile getter"); } }); });
  for (const p of bad) assert.throws(() => createAcquisitionFifos(p), { code: "FIFO_INPUT" });
  assert.throws(() => createAcquisitionFifos(profile(), { extra() {} }), { code: "FIFO_INPUT" });
  assert.throws(() => createAcquisitionFifos(profile(), Object.defineProperty({}, "clock", {
    enumerable: true, get() { assert.fail("port getter"); },
  })), { code: "FIFO_INPUT" });
  assert.throws(() => createAcquisitionFifos(profile(), Object.defineProperty({}, "clock", {
    value() { assert.fail("non-enumerable override must not be silently discarded"); },
  })), { code: "FIFO_INPUT" });
});

test("owner is returned before I/O, copies input, opens readers before sentinels and rechecks root", async t => {
  const f = fixture(t); const p = f.owner;
  assert.equal(f.opened.length, 0); assert.equal(f.timers.size, 0);
  f.input.timing.workUntilNs = "1"; f.input.ipc.root.path = "/changed";
  const opening = p.open(); assert.equal(p.open(), opening);
  const ready = await opening;
  assert.equal(ready.prepared, true); assert.equal(ready.finished, false); assert.equal(f.roots, 2);
  assert.deepEqual(f.opened.map(h => [h.kind, h.role]), ["reader", "sentinel"].flatMap(k => roles.map(r => [k, r])));
  assert(f.opened.every(h => h.path.startsWith("/tmp/fifo-fixture/")));
  assert.equal(ready.channels.stdout.reader.verified, true); assert(Object.isFrozen(ready.channels.stdout.reader));
  const closing = p.close(); assert.equal(p.close(), closing);
  const end = await closing;
  assert.equal(end.firstError, "FIFO_STOPPED"); assert.equal(end.ioClosed, "closed");
  assert(f.opened.every(h => h.closes === 1)); assert.equal(ready.ioClosed, "open");
});

test("opening is observable and stopping disposes a late handle without starting subsequent opens", async t => {
  let hold; const f = fixture(t, { open: () => hold.promise }); hold = f.hold();
  const p = f.owner; const opening = p.open();
  await until(() => f.opened.length === 1);
  const before = p.snapshot(); assert.equal(before.opening, true); assert.equal(before.pendingEffects, 1);
  p.stop(); const closing = p.close();
  assert.equal(f.opened[0].closes, 0);
  hold.resolve(); const end = await closing; await opening;
  assert.equal(f.opened.length, 1); assert.equal(f.opened[0].closes, 1);
  assert.equal(end.firstError, "FIFO_STOPPED"); assert.equal(end.pendingEffects, 0);
  assert.equal(before.channels.stdout.reader.state, "opening");
});

test("native FIFO flags have no creation or fallback; ordinary files and symlinks are rejected", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tabgrad-fifo-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [kind, access] of [["reader", constants.O_RDONLY], ["sentinel", constants.O_WRONLY]]) {
    assert.equal(FIFO_OPEN_FLAGS[kind], access | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    assert.equal(FIFO_OPEN_FLAGS[kind] & (constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND), 0);
  }
  await assert.rejects(openFifoEndpoint(join(root, "missing"), "reader"), { code: "ENOENT" });
  const file = await open(join(root, "stdout"), "wx+");
  const identity = acquisitionFileIdentity(await file.stat({ bigint: true })); await file.close();
  const h = await openFifoEndpoint(join(root, "stdout"), "reader");
  const stat = await h.stat({ bigint: true });
  assert.throws(() => verifyFifoStat(stat, identity), { code: "FIFO_IDENTITY" }); await h.close();
  await symlink(join(root, "stdout"), join(root, "alias"));
  await assert.rejects(openFifoEndpoint(join(root, "alias"), "reader"));
  const p = profile(); p.ipc.root = { path: root, identity: acquisitionFileIdentity(await lstat(root, { bigint: true })) };
  p.ipc.stdout.identity = identity;
  const owner = createAcquisitionFifos(p, { clock: () => 101n });
  const failed = await owner.open(); assert.equal(failed.firstError, "FIFO_IDENTITY");
  assert.equal(failed.channels.stdout.reader.state, "closed"); await owner.close();
  await assert.rejects(fifoNativePorts.root({ path: root, identity: { dev: "0", ino: "1" } }), { code: "FIFO_ROOT" });
  await assert.rejects(fifoNativePorts.root({ path: join(root, "alias"), identity }));
});

test("binary channels progress independently; borrowed scratch is stable until its sink settles", async t => {
  let hold; let borrowed;
  const f = fixture(t, { streams: { stdout: [Buffer.from([0, 128, 255]), Buffer.from([7])],
    stderr: [Buffer.from([8])], control: [Buffer.from([9])] }, sink(role, bytes) {
    if (role === "stdout" && !borrowed) { borrowed = bytes; return hold.promise; }
  } }); hold = f.hold(); const p = f.owner; await p.open();
  const draining = p.drain(f.sinks); assert.equal(p.drain({}), draining);
  await until(() => f.output.stderr.length === 1 && f.output.control.length === 1 && borrowed);
  assert.equal(f.reads.filter(r => r.role === "stdout").length, 1);
  assert.deepEqual(borrowed, Buffer.from([0, 128, 255]));
  const heldState = p.snapshot(); assert.equal(heldState.channels.stdout.sinkPending, true);
  assert.equal(Object.hasOwn(heldState.channels.stdout, "confirmedBytes"), false);
  hold.resolve(); await until(() => f.output.stdout.length === 2);
  const release = p.releaseSentinels(); assert.equal(p.releaseSentinels(), release); await release;
  const end = await draining;
  assert.equal(end.state, "complete"); assert.equal(end.ioClosed, "closed");
  assert.equal(end.channels.stdout.readBytes, 4); assert.equal(end.channels.stdout.submittedBytes, 4);
  for (const role of roles) {
    const reads = f.reads.filter(r => r.role === role);
    assert(reads.every(r => r.buffer === reads[0].buffer));
    assert.equal(end.channels[role].eof, true);
  }
  assert.notEqual(f.reads.find(r => r.role === "stdout").buffer, f.reads.find(r => r.role === "stderr").buffer);
  assert.equal(end.payloadOrigin, "unqualified"); assert.equal(end.externalClosure, "unqualified");
  assert.equal(end.clockAdmission, "unqualified"); assert.equal(end.releaseAdmission, "unqualified");
  assert.equal(heldState.channels.stdout.sinkPending, true);
});

test("early zero/EAGAIN poll without spinning or declaring EOF, and release never waits for a read", async t => {
  let n = 0;
  const f = fixture(t, { read() { n++; if (n <= 3) throw Object.assign(Error("idle"), { code: "EAGAIN" }); return { bytesRead: 0 }; } });
  const p = f.owner; await p.open(); const draining = p.drain(f.sinks);
  await until(() => roles.every(r => p.snapshot().channels[r].pollPending));
  const calls = f.reads.length; await turn(); assert.equal(f.reads.length, calls);
  assert(roles.every(r => !p.snapshot().channels[r].eof));
  f.advance(1000101n); await until(() => f.reads.length === 6);
  assert(roles.every(r => !p.snapshot().channels[r].eof));
  await p.releaseSentinels(); const end = await draining;
  assert.equal(end.state, "complete"); assert(f.opened.every(h => h.closes === 1));
});

test("exact capacities and one-byte excess are distinguished independently for all roles", async t => {
  for (const role of roles) for (const extra of [0, 1]) {
    const capacity = { stdout: 1048576, stderr: 262144, control: 890 }[role];
    assert.equal(limits[role].capacity, capacity);
    const f = fixture(t, { streams: { [role]: [Buffer.alloc(capacity + extra, 0xa7)] } });
    const p = f.owner; await p.open(); const draining = p.drain(f.sinks);
    await until(() => p.snapshot().channels[role].submittedBytes === capacity);
    if (!extra) await p.releaseSentinels();
    const end = await draining;
    assert.equal(end.state, extra ? "limit" : "complete");
    assert.equal(end.channels[role].readBytes, capacity + extra);
    assert.equal(end.channels[role].submittedBytes, capacity);
    assert.deepEqual(Buffer.concat(f.output[role]), Buffer.alloc(capacity, 0xa7));
    const reads = f.reads.filter(r => r.role === role);
    const quantum = role === "control" ? 178 : 16384;
    assert.equal(reads[0].length, quantum); assert.equal(reads.at(-1).length, 1);
    assert.equal(end.channels[role].overflow, Boolean(extra));
  }
});

test("excess closes sentinels before a retained prefix sink settles", async t => {
  let hold;
  const f = fixture(t, { streams: { control: [Buffer.alloc(889), Buffer.alloc(2)] }, sink(role) {
    if (role === "control" && f.output.control.length === 6) return hold.promise;
  } }); hold = f.hold(); const p = f.owner; await p.open();
  const draining = p.drain(f.sinks);
  await until(() => f.output.control.length === 6 && f.opened.filter(h => h.kind === "sentinel").every(h => h.closes === 1));
  assert.equal(p.snapshot().state, "limit"); assert.equal(p.snapshot().channels.control.sinkPending, true);
  assert.equal(f.output.control.at(-1).length, 1);
  hold.resolve(); const end = await draining;
  assert.equal(end.state, "limit"); assert.equal(end.channels.control.readBytes, 891);
});

test("short reads keep binary order and yield between chunks without accumulating a history", async t => {
  for (const spec of [{ size: 1, chunk: 1, repeats: 1, role: "stdout" },
    { size: 8192, chunk: 8192, repeats: 1, role: "stdout" },
    { size: 8192, chunk: 7, repeats: 1, role: "stdout" },
    { size: 1, chunk: 1, repeats: 32, role: "stdout" },
    { size: 1, chunk: 1, repeats: 1, role: "stderr" }]) {
    const data = Buffer.alloc(spec.size * spec.repeats, 0x81);
    const f = fixture(t, { streams: { [spec.role]: Array.from({ length: Math.ceil(data.length / spec.chunk) },
      (_, i) => data.subarray(i * spec.chunk, (i + 1) * spec.chunk)) } });
    const p = f.owner; await p.open(); const draining = p.drain(f.sinks);
    // Finite structural counts, not a wall-clock performance measurement.
    await until(() => p.snapshot().channels[spec.role].submittedBytes === data.length, Math.ceil(data.length / spec.chunk) + 10);
    await p.releaseSentinels(); const end = await draining;
    assert.equal(end.state, "complete"); assert.deepEqual(Buffer.concat(f.output[spec.role]), data);
    assert.equal(f.output[spec.role].length, Math.ceil(data.length / spec.chunk));
    assert.equal(new Set(f.reads.filter(r => r.role === spec.role).map(r => r.buffer)).size, 1);
  }
});

test("open/stat/root failures retain the first cause and close every acquired handle once", async t => {
  for (const at of [0, 1, 2, 3, 4, 5]) for (const phase of ["open", "stat"]) {
    const f = fixture(t, { [phase](h, i) {
      const index = i ?? f.opened.indexOf(h);
      if (index === at) throw Error("finite native failure");
    } });
    const end = await f.owner.open();
    assert.equal(end.firstError, phase === "open" ? "FIFO_OPEN" : "FIFO_IDENTITY");
    assert.equal(f.opened.length, at + 1);
    assert(f.opened.every((h, i) => h.closes === (phase === "open" && i === at ? 0 : 1)));
  }
  for (const at of [1, 2]) {
    const f = fixture(t, { root(expected, n) { if (n === at) throw Error("changed root"); } });
    const end = await f.owner.open(); assert.equal(end.firstError, "FIFO_ROOT");
    assert.equal(f.opened.length, at === 1 ? 0 : 6); assert(f.opened.every(h => h.closes === 1));
  }
});

test("read extents, throws and sink failures revoke all roles without claiming confirmed persistence", async t => {
  for (const result of [-1, 1.5, 16385, undefined, "throw", "sink"]) {
    const f = fixture(t, { read(h, b) {
      if (h.role !== "stdout") return { bytesRead: 0 };
      if (result === "throw") throw Error("read failure after unknown effect");
      b[0] = 0xa7; return { bytesRead: result === "sink" ? 1 : result };
    }, sink() { throw Error("sink failure after possible effect"); } });
    const p = f.owner; await p.open(); const end = await p.drain(f.sinks);
    assert.equal(end.firstError, result === "throw" ? "FIFO_READ" : result === "sink" ? "FIFO_SINK" : "FIFO_READ_EXTENT");
    assert.equal(end.channels.stdout.readUncertain, result !== "sink");
    assert.equal(end.channels.stdout.submittedBytes, result === "sink" ? 1 : 0);
    assert.equal(end.channels.stdout.sinkFailed, result === "sink");
    assert.equal(end.ioClosed, "closed");
  }
});

test("stop during a native read records late bytes without delivering them; close has its own absolute cutoff", async t => {
  let hold; const f = fixture(t, { async read(h, b) {
    if (h.role === "stdout") { await hold.promise; b[0] = 5; return { bytesRead: 1 }; }
    return { bytesRead: 0 };
  } }); hold = f.hold(); const p = f.owner; await p.open(); const draining = p.drain(f.sinks);
  await until(() => p.snapshot().channels.stdout.readPending); p.stop(); const closing = p.close();
  await until(() => f.opened.every(h => h.closes === 1) && p.snapshot().pendingEffects === 1);
  const before = p.snapshot(); assert.equal(before.channels.stdout.readPending, true);
  f.advance(2000000100n); const expired = await closing; assert.equal(await draining, expired);
  assert.equal(expired.cleanupWaitExpired, true); assert.equal(expired.pendingEffects, 1);
  hold.resolve(); await until(() => p.snapshot().pendingEffects === 0);
  const late = p.snapshot(); assert.equal(late.channels.stdout.readBytes, 1); assert.equal(late.channels.stdout.submittedBytes, 0);
  assert.equal(late.firstError, "FIFO_STOPPED"); assert.equal(late.state, "incomplete");
  assert.equal(expired.channels.stdout.readBytes, 0); assert.equal(before.finished, false);
  assert.equal(f.output.stdout.length, 0);
});

test("late opening and late close remain visible after the local wait has expired", async t => {
  for (const phase of ["open", "close", "stat", "sink"]) {
    let hold; const f = fixture(t, { streams: { stdout: [Buffer.from([1])] },
      [phase]: async () => hold.promise }); hold = f.hold(); const p = f.owner; const opening = p.open();
    if (["open", "stat"].includes(phase)) await until(() => f.opened.length === 1);
    else await opening;
    if (phase === "sink") { void p.drain(f.sinks); await until(() => p.snapshot().channels.stdout.sinkPending); }
    p.stop(); const closing = p.close();
    f.advance(2000000100n); const expired = await closing; await opening;
    assert.equal(expired.cleanupWaitExpired, true); assert(expired.pendingEffects > 0);
    hold.resolve(); await until(() => p.snapshot().pendingEffects === 0);
    assert.equal(p.snapshot().firstError, "FIFO_STOPPED"); assert(f.opened.every(h => h.closes === 1));
    assert(expired.pendingEffects > 0);
  }
});

test("deadlines use original elapsed time and preserve known read/native failure before clock rejection", async t => {
  for (const time of [1000000100n, 2000000100n]) {
    const f = fixture(t); f.time(time); const end = await f.owner.open();
    assert.equal(end.firstError, "FIFO_DEADLINE"); assert.equal(f.opened.length, 0);
  }
  for (const clock of [() => 1, () => -1n, () => { throw Error("clock"); }]) {
    const f = fixture(t, { clock }); const end = await f.owner.open(); assert.equal(end.firstError, "FIFO_CLOCK");
  }
  for (const outcome of ["data", "throw"]) {
    const f = fixture(t, { async read(h, b) {
      if (h.role !== "stdout") throw Object.assign(Error("idle"), { code: "EWOULDBLOCK" });
      await turn();
      f.time(100n);
      if (outcome === "throw") throw Error("native read");
      b[0] = 9; return { bytesRead: 1 };
    } });
    const p = f.owner; await p.open(); const end = await p.drain(f.sinks);
    assert.equal(end.firstError, outcome === "throw" ? "FIFO_READ" : "FIFO_CLOCK");
    assert.equal(end.channels.stdout.readBytes, outcome === "data" ? 1 : 0);
    assert.equal(end.channels.stdout.submittedBytes, 0);
    assert.equal(end.cleanupError, "FIFO_CLOCK");
  }
});

test("failed close is separate, idempotent and never silently retried", async t => {
  const f = fixture(t, { close() { throw Error("unknown close result"); } }); const p = f.owner;
  assert.throws(() => p.drain(f.sinks), { code: "FIFO_STATE" });
  assert.throws(() => p.releaseSentinels(), { code: "FIFO_STATE" });
  await p.open(); p.stop(); const end = await p.close();
  assert.equal(end.firstError, "FIFO_STOPPED"); assert.equal(end.cleanupError, "FIFO_CLOSE");
  assert.equal(end.ioClosed, "unknown"); assert(f.opened.every(h => h.closes === 1));
  const unopened = fixture(t); unopened.owner.stop();
  assert.equal((await unopened.owner.open()).ioClosed, "not_opened"); assert.equal(unopened.opened.length, 0);
});

test("wrong endpoint identity/type and root replacement revoke the prepared set", async t => {
  for (const stat of [
    { dev: 1n, ino: 2n, isFIFO: () => false },
    { dev: 1n, ino: 99n, isFIFO: () => true },
    { dev: 2n, ino: 2n, isFIFO: () => true },
    { dev: "1", ino: 2n, isFIFO: () => true },
  ]) {
    const f = fixture(t, { stat: () => stat }); const end = await f.owner.open();
    assert.equal(end.firstError, "FIFO_IDENTITY"); assert.equal(end.prepared, false);
    assert.equal(f.opened.length, 1); assert.equal(f.opened[0].closes, 1);
  }
});

test("work expiry revokes before cleanup horizon and early callbacks do not renew either deadline", async t => {
  let hold; const f = fixture(t, { read: () => hold.promise }); hold = f.hold();
  const p = f.owner; await p.open(); const draining = p.drain(f.sinks);
  await until(() => p.snapshot().pendingEffects === 3);
  const work = [...f.timers].find(timer => timer.due === 1000000101n);
  assert(work); f.timers.delete(work); f.time(500000100n); work.callback();
  assert.equal(p.snapshot().firstError, null);
  assert.equal([...f.timers].filter(timer => timer.due === 2000000101n).length, 1);
  f.advance(1000000101n);
  await until(() => f.opened.every(h => h.closes === 1) && p.snapshot().pendingEffects === 3);
  assert.equal(p.snapshot().firstError, "FIFO_DEADLINE"); assert.equal(p.snapshot().finished, false);
  f.advance(2000000101n); const end = await draining;
  assert.equal(end.cleanupWaitExpired, true); assert.equal(end.pendingEffects, 3);
  hold.resolve({ bytesRead: 0 }); await until(() => p.snapshot().pendingEffects === 0);
  assert.equal(p.snapshot().state, "incomplete");
});

test("a failed clock ends the local wait conservatively while retaining pending native ownership", async t => {
  let hold; let badClock = false;
  const f = fixture(t, { open: () => hold.promise, clock: now => badClock ? undefined : now }); hold = f.hold();
  const p = f.owner; const opening = p.open(); await until(() => f.opened.length === 1);
  badClock = true; f.advance(1000000101n); f.advance(2000000101n);
  await until(() => p.snapshot().finished);
  const failed = await opening;
  assert.equal(failed.firstError, "FIFO_CLOCK"); assert.equal(failed.pendingEffects, 1);
  assert.equal(failed.channels.stdout.reader.state, "opening"); assert.equal(failed.state, "incomplete");
  hold.resolve(); await until(() => p.snapshot().pendingEffects === 0);
  assert.equal(f.opened[0].closes, 1); assert.equal(p.snapshot().state, "incomplete");
});

test("timer failures revoke opening/polling and remain explicit during final cancellation", async t => {
  for (const phase of ["arm", "poll", "cancel"]) {
    let calls = 0;
    const f = fixture(t, { schedule(timer, ms) {
      calls++;
      if ((phase === "arm" && calls === 1) || (phase === "poll" && ms === 1)) throw Error("schedule failure");
    }, cancel() { if (phase === "cancel") throw Error("cancel failure"); } });
    const p = f.owner; const ready = await p.open();
    let end;
    if (phase === "arm") end = ready;
    else if (phase === "poll") end = await p.drain(f.sinks);
    else { p.stop(); end = await p.close(); }
    assert.equal(end.firstError, phase === "cancel" ? "FIFO_STOPPED" : "FIFO_TIMER");
    assert.equal(end.cleanupError, "FIFO_TIMER"); assert.equal(end.state, "incomplete");
    assert(f.opened.every(h => h.closes === 1));
  }
});

test("stop from a prefix sink preserves the known limit; release closure can stay unknown", async t => {
  const f = fixture(t, { streams: { control: [Buffer.alloc(889), Buffer.alloc(2)] },
    sink(role) { if (role === "control" && f.output.control.length === 6) f.owner.stop(); },
    close(h) { if (h.kind === "sentinel" && h.role === "control") throw Error("close failure"); } });
  const p = f.owner; await p.open(); const end = await p.drain(f.sinks);
  assert.equal(end.firstError, "FIFO_LIMIT"); assert.equal(end.cleanupError, "FIFO_CLOSE");
  assert.equal(end.channels.control.readBytes, 891); assert.equal(end.channels.control.submittedBytes, 890);
  assert.equal(end.channels.control.eof, false); assert.equal(end.ioClosed, "unknown");
});

test("observed overflow precedes the post-read clock failure without admitting its remaining prefix", async t => {
  const f = fixture(t, { streams: { control: [Buffer.alloc(889), Buffer.alloc(2)] }, clock(now) {
    return f.owner.snapshot().channels.control.overflow ? 100n : now;
  } });
  const p = f.owner; await p.open(); const end = await p.drain(f.sinks);
  assert.equal(end.firstError, "FIFO_LIMIT"); assert.equal(end.cleanupError, "FIFO_CLOCK");
  assert.equal(end.channels.control.overflow, true); assert.equal(end.channels.control.readBytes, 891);
  assert.equal(end.channels.control.submittedBytes, 889); assert.equal(f.output.control.length, 5);
  assert.equal(end.state, "limit");
});

test("two observed overflows admit only the first read's allowed prefix", async t => {
  const probes = {}; const transferred = { stdout: 0, stderr: 0 };
  const f = fixture(t, { read(h, buffer, length) {
    if (h.role === "control") return { bytesRead: 0 };
    const remaining = limits[h.role].capacity - 1 - transferred[h.role];
    if (remaining) {
      const n = Math.min(remaining, length); buffer.fill(0xa7, 0, n); transferred[h.role] += n;
      return { bytesRead: n };
    }
    assert.equal(length, 2); const wait = f.hold(); probes[h.role] = { wait, buffer };
    return wait.promise;
  } });
  const p = f.owner; await p.open(); const draining = p.drain(f.sinks);
  await until(() => probes.stdout && probes.stderr);
  for (const role of ["stdout", "stderr"]) {
    probes[role].buffer.fill(0xa7, 0, 2); probes[role].wait.resolve({ bytesRead: 2 });
  }
  const end = await draining;
  assert.equal(end.firstError, "FIFO_LIMIT"); assert.equal(end.channels.stdout.submittedBytes, limits.stdout.capacity);
  assert.equal(end.channels.stderr.submittedBytes, limits.stderr.capacity - 1);
  assert.equal(end.channels.stdout.readBytes, limits.stdout.capacity + 1);
  assert.equal(end.channels.stderr.readBytes, limits.stderr.capacity + 1);
});

test("a zero result cannot establish EOF while its sentinel close is retained", async t => {
  let hold; const f = fixture(t, { close(h) { if (h.kind === "sentinel") return hold.promise; } }); hold = f.hold();
  const p = f.owner; await p.open(); const draining = p.drain(f.sinks);
  await until(() => roles.every(r => p.snapshot().channels[r].pollPending));
  const releasing = p.releaseSentinels();
  f.advance(1000101n); await until(() => f.reads.length === 6);
  assert(roles.every(r => !p.snapshot().channels[r].eof));
  hold.resolve(); await releasing;
  const end = await draining; assert.equal(end.state, "complete");
});

test("raw writer composition keeps persistence and finishing with the borrowed sink owner", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tabgrad-fifo-payload-")));
  const input = { root, destinations: {}, t0MonotonicNs: "100", deadlineNs: "2000000000" };
  for (const role of ["stdout", "stderr"]) {
    const h = await open(join(root, role), "wx+"); await h.truncate(limits[role].capacity);
    input.destinations[role] = { name: role, identity: acquisitionFileIdentity(await h.stat({ bigint: true })) }; await h.close();
  }
  const payload = await openAcquisitionPayload(input, { clock: () => 101n });
  t.after(async () => { await payload.close(); await rm(root, { recursive: true, force: true }); });
  const stdout = Buffer.from([1, 0, 0, 0, 255, 255, 255, 255, 128]); const stderr = Buffer.from([255, 0, 10]);
  const f = fixture(t, { streams: { stdout: [stdout], stderr: [stderr] } });
  await f.owner.open();
  const draining = f.owner.drain({ stdout: b => payload.write("stdout", b), stderr: b => payload.write("stderr", b), control: () => {} });
  await until(() => payload.snapshot().channels.stdout.confirmedBytes === stdout.length
    && payload.snapshot().channels.stderr.confirmedBytes === stderr.length);
  await f.owner.releaseSentinels(); assert.equal((await draining).state, "complete");
  assert.equal(payload.snapshot().state, "pending"); // FIFO owner never finishes or closes a sink.
  payload.finish("stdout"); const end = payload.finish("stderr"); assert.equal(end.state, "complete");
  assert.equal(end.channels.stdout.confirmedBytes, stdout.length); assert.equal(end.channels.stderr.confirmedBytes, stderr.length);
});
