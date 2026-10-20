import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, open, readFile, lstat, link, symlink, rm, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import { test } from "node:test";
import { openAcquisitionCapture, ACQUISITION_CAPTURE_LIMITS as limits } from "../../../scripts/provenance-acquisition-capture.mjs";
import { acquisitionFileIdentity } from "../../../scripts/provenance-acquisition-record-io.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function frame(type, payload) {
  const header = Buffer.from([type, 0, 0, 0, 0, 0, 0, 0]);
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tabgrad-capture-")));
  const destinations = {};
  const handles = [];
  let capture;
  let now = 101n;
  let writes = 0;
  const input = { root, destinations, t0MonotonicNs: "100", deadlineNs: "1000" };
  t.after(async () => {
    options.cleanup?.();
    if (capture) await capture.close();
    await Promise.allSettled(handles.map(h => h.close()));
    await rm(root, { recursive: true, force: true });
  });
  for (const role of ["stdout", "stderr"]) {
    const h = await open(join(root, role), "wx+", 0o600);
    await h.truncate(limits[role]);
    destinations[role] = { name: role, identity: { ...acquisitionFileIdentity(await h.stat({ bigint: true })) } };
    await h.close();
  }
  const transfer = {
    async write(handle, bytes, offset, length, position) {
      writes += 1; if (!handles.includes(handle)) handles.push(handle);
      if (options.write) return options.write(handle, bytes, offset, length, position);
      return handle.write(bytes, offset, length, position);
    },
    async close(handle) {
      if (!handles.includes(handle)) handles.push(handle);
      if (options.close) return options.close(handle);
      return handle.close();
    },
  };
  return { input, root, handles, transfer,
    setTime(value) { now = value; },
    get writes() { return writes; },
    async create() { capture = await openAcquisitionCapture(input, { clock: options.clock ?? (() => now), transfer }); return capture; },
    async prefix(role, length) { return (await readFile(join(root, role))).subarray(0, length); },
  };
}

test("literal interleaved binary vector preserves exact payloads, counts and hashes without framing", async t => {
  const f = await fixture(t);
  const c = await f.create();
  // Independent literal wire: stdout ff00, stderr 80, stdout 41.
  const wire = Buffer.from([1, 0, 0, 0, 0, 0, 0, 2, 255, 0, 2, 0, 0, 0, 0, 0, 0, 1, 128, 1, 0, 0, 0, 0, 0, 0, 1, 65]);
  f.input.destinations.stdout.identity.ino = "999";
  f.input.deadlineNs = "1";
  assert.equal((await c.write(wire)).busy, false);
  wire.fill(42);
  const r = c.finish();
  assert.equal(r.state, "complete");
  for (const [role, expected] of [["stdout", Buffer.from([255, 0, 65])], ["stderr", Buffer.from([128])]]) {
    assert.equal(r.channels[role].receivedBytes, expected.length);
    assert.equal(r.channels[role].confirmedBytes, expected.length);
    assert.equal(r.channels[role].sha256, hash(expected));
    assert.deepEqual(await f.prefix(role, expected.length), expected);
  }
  assert.equal(r.externalClosure, "unqualified");
  assert.equal(r.ioClosed, "open");
  const closing = c.close();
  assert.equal(c.close(), closing);
  assert.equal((await closing).ioClosed, "closed");
  await assert.rejects(c.write(Buffer.alloc(0)), { code: "CAPTURE_STOPPED" });
});

test("header/payload splitting at every boundary and multiple frames have independent byte oracles", async t => {
  const wire = Buffer.concat([frame(1, Buffer.from([0, 1, 255])), frame(2, Buffer.from([128, 7]))]);
  for (let split = 0; split <= wire.length; split += 1) {
    const f = await fixture(t); const c = await f.create();
    await c.write(wire.subarray(0, split)); await c.write(wire.subarray(split));
    assert.equal(c.finish().state, "complete");
    assert.deepEqual(await f.prefix("stdout", 3), Buffer.from([0, 1, 255]));
    assert.deepEqual(await f.prefix("stderr", 2), Buffer.from([128, 7]));
    await c.close();
  }
});

test("empty stream/frames are valid data, but empty-frame input yields to cancellation", { timeout: 10000 }, async t => {
  const f = await fixture(t); const c = await f.create();
  const work = c.write(Buffer.alloc(8000).fill(0).map((value, index) => index % 8 === 0 ? 1 : value));
  setImmediate(() => c.stop());
  await assert.rejects(work, { code: "CAPTURE_STOPPED" });
  assert.equal(c.snapshot().channels.stdout.receivedBytes, 0);
  assert.equal(c.snapshot().state, "incomplete");
  const empty = await fixture(t); const e = await empty.create();
  await e.write(Buffer.alloc(0)); await e.write(frame(2, Buffer.alloc(0)));
  assert.equal(e.finish().state, "complete");
  assert.equal(e.snapshot().channels.stderr.sha256, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("frame count, payload length and input partition independently preserve linear confirmed transfers", async t => {
  const cases = [{ count: 1, size: 1, chunk: 4096 }, { count: 512, size: 1, chunk: 4096 },
    { count: 1, size: 8192, chunk: 4096 }, { count: 1, size: 8192, chunk: 7 }];
  for (const spec of cases) {
    let transferred = 0;
    const f = await fixture(t, { async write(h, b, o, n, p) { transferred += n; return h.write(b, o, n, p); } });
    const c = await f.create();
    const payload = Buffer.alloc(spec.size, 0xa7);
    const wire = Buffer.concat(Array.from({ length: spec.count }, () => frame(1, payload)));
    for (let i = 0; i < wire.length; i += spec.chunk) await c.write(wire.subarray(i, i + spec.chunk));
    const r = c.finish();
    assert.equal(transferred, spec.count * spec.size);
    assert.equal(r.channels.stdout.confirmedBytes, transferred);
    assert.equal(r.channels.stdout.sha256, hash(Buffer.alloc(transferred, 0xa7)));
    assert(f.writes <= spec.count + Math.ceil(wire.length / spec.chunk));
    await c.close();
  }
});

test("each channel admits its exact limit and rejects one extra or uint32max before writing it", async t => {
  for (const role of ["stdout", "stderr"]) {
    const type = role === "stdout" ? 1 : 2;
    const f = await fixture(t); const c = await f.create();
    await c.write(frame(type, Buffer.alloc(limits[role], 0x5c)));
    const before = f.writes;
    await assert.rejects(c.write(frame(type, Buffer.from([1]))), { code: "CAPTURE_LIMIT" });
    assert.equal(f.writes, before);
    assert.equal(c.snapshot().channels[role].confirmedBytes, limits[role]);
    const exact = await fixture(t); const e = await exact.create();
    await e.write(frame(type, Buffer.alloc(limits[role])));
    assert.equal(e.finish().state, "complete");
  }
  const f = await fixture(t); const c = await f.create();
  await assert.rejects(c.write(Buffer.from([1, 0, 0, 0, 255, 255, 255, 255])), { code: "CAPTURE_LIMIT" });
  assert.equal(f.writes, 0);
});

test("unsupported streams/reserved bytes, partial headers/payload and nonbinary data never become complete", async t => {
  for (const bad of [Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]), Buffer.from([3, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.from([255, 0, 0, 0, 0, 0, 0, 0]), ...[1, 2, 3].map(i => { const b = frame(1, Buffer.alloc(0)); b[i] = 1; return b; })]) {
    const f = await fixture(t); const c = await f.create();
    await assert.rejects(c.write(bad), { code: "CAPTURE_PROTOCOL" });
    assert.equal(f.writes, 0);
  }
  const wire = frame(1, Buffer.from([3, 4, 5]));
  for (let count = 1; count < wire.length; count += 1) {
    const f = await fixture(t); const c = await f.create();
    await c.write(wire.subarray(0, count));
    assert.throws(() => c.finish(), { code: "CAPTURE_TRUNCATED" });
    assert.equal(c.snapshot().channels.stdout.confirmedBytes, Math.max(count - 8, 0));
    await assert.rejects(c.write(wire), { code: "CAPTURE_TRUNCATED" });
  }
  const f = await fixture(t); const c = await f.create();
  await assert.rejects(c.write("not binary"), { code: "CAPTURE_INPUT" });
});

test("known short writes advance only by confirmed extents without replaying prefix or framing", async t => {
  const positions = [];
  const f = await fixture(t, { write(h, b, o, n, p) { positions.push(p); return h.write(b, o, Math.min(2, n), p); } });
  const c = await f.create(); await c.write(frame(1, Buffer.from([1, 2, 3, 4, 5])));
  assert.deepEqual(positions, [0, 2, 4]);
  assert.equal(c.finish().channels.stdout.sha256, hash(Buffer.from([1, 2, 3, 4, 5])));
});

test("zero, invalid and throw-after-effect writes stop permanently with truthful extent and close uncertainty", async t => {
  for (const outcome of [0, -1, 1.5, 99, null, "throw"]) {
    let calls = 0;
    const f = await fixture(t, { async write(h, b, o, n, p) {
      calls += 1;
      if (calls === 1) return h.write(b, o, 1, p);
      if (outcome === "throw") { await h.write(b, o, 1, p); throw Error("synthetic effect then failure"); }
      return { bytesWritten: outcome };
    }, async close(h) { await h.close(); throw Error("synthetic close failure"); } });
    const c = await f.create();
    await assert.rejects(c.write(frame(1, Buffer.from([9, 8, 7]))));
    const first = c.snapshot().firstError;
    await assert.rejects(c.write(frame(2, Buffer.from([6]))), { code: first });
    assert.equal(calls, 2);
    const r = await c.close();
    assert.equal(r.firstError, first);
    assert.equal(r.ioClosed, "unknown");
    assert.equal(r.channels.stdout.confirmedBytes, 1);
    assert.equal(r.channels.stdout.receivedBytes, 3);
    assert.equal(r.channels.stdout.sha256, hash(Buffer.from([9])));
    assert.equal(r.channels.stdout.uncertain, outcome !== 0);
    assert.equal(r.channels.stdout.closeError, "CLOSE_FAILED");
    assert.equal((await f.prefix("stdout", 2))[1], outcome === "throw" ? 8 : 0);
  }
});

test("one pending write enforces backpressure and close joins its late effect without restoring success", async t => {
  const pending = deferred(); const entered = deferred();
  const f = await fixture(t, { cleanup: () => pending.resolve(), async write(h, b, o, n, p) {
    entered.resolve(); await pending.promise; return h.write(b, o, n, p);
  } });
  const c = await f.create();
  const work = c.write(frame(1, Buffer.from([11, 12])));
  await entered.promise;
  assert.equal(c.snapshot().ioPending, 1);
  assert.equal(c.snapshot().channels.stdout.receivedBytes, 2);
  assert.equal(c.snapshot().channels.stdout.confirmedBytes, 0);
  await assert.rejects(c.write(frame(2, Buffer.from([7]))), { code: "CAPTURE_BUSY" });
  assert.throws(() => c.finish(), { code: "CAPTURE_BUSY" });
  const rejected = assert.rejects(work, { code: "CAPTURE_STOPPED" });
  const closing = c.close(); let closed = false; closing.then(() => { closed = true; });
  await turn(); assert.equal(closed, false);
  pending.resolve(); await rejected;
  const r = await closing;
  assert.equal(r.state, "incomplete"); assert.equal(r.ioClosed, "closed");
  assert.equal(r.channels.stdout.confirmedBytes, 2);
  assert.equal(r.channels.stdout.sha256, hash(Buffer.from([11, 12])));
  assert.equal(r.channels.stderr.receivedBytes, 0);
});

test("original deadline, regressive/failed clock and late transfer cannot admit completion", async t => {
  for (const value of [99n, 1100n, "invalid"]) {
    const f = await fixture(t); const c = await f.create(); f.setTime(value);
    await assert.rejects(c.write(frame(1, Buffer.from([1]))), { code: value === 1100n ? "CAPTURE_DEADLINE" : "CAPTURE_CLOCK" });
    assert.equal(f.writes, 0);
  }
  let now = 101n;
  const f = await fixture(t, { clock: () => now, async write(h, b, o, n, p) {
    const result = await h.write(b, o, n, p); now = 1100n; return result;
  } });
  const c = await f.create();
  await assert.rejects(c.write(frame(1, Buffer.from([17]))), { code: "CAPTURE_DEADLINE" });
  assert.equal(c.snapshot().channels.stdout.confirmedBytes, 1);
  assert.throws(() => c.finish(), { code: "CAPTURE_DEADLINE" });
  const fail = await fixture(t, { clock: () => { throw Error("synthetic clock failure"); } });
  await assert.rejects(fail.create(), { code: "CAPTURE_CLOCK" });
  const empty = await fixture(t); const e = await empty.create(); empty.setTime(1100n);
  assert.throws(() => e.finish(), { code: "CAPTURE_DEADLINE" });
});

test("empty-frame lifetime uses the original clock instead of only the payload allowance", async t => {
  let tick = 100n;
  const f = await fixture(t, { clock: () => tick++ }); f.input.deadlineNs = "20";
  const c = await f.create();
  await assert.rejects(c.write(Buffer.concat(Array.from({ length: 100 }, () => frame(1, Buffer.alloc(0))))), { code: "CAPTURE_DEADLINE" });
  assert.equal(f.writes, 0); assert.equal(c.snapshot().channels.stdout.receivedBytes, 0);
});

test("bad identity, alias/link/capacity and replaced paths reject or retain their original handles", async t => {
  for (const change of [async f => { f.input.destinations.stderr.identity.ino = "9999"; },
    async f => { await rm(join(f.root, "stderr")); await link(join(f.root, "stdout"), join(f.root, "stderr")); },
    async f => { await rm(join(f.root, "stderr")); await symlink("stdout", join(f.root, "stderr")); },
    async f => { const h = await open(join(f.root, "stderr"), "r+"); await h.truncate(1); await h.close(); }]) {
    const f = await fixture(t); await change(f);
    await assert.rejects(f.create(), error => { assert.equal(error.cleanup.openedHandles, error.cleanup.closedHandles); return true; });
    assert.equal(f.writes, 0);
  }
  const f = await fixture(t); const c = await f.create();
  await rename(join(f.root, "stdout"), join(f.root, "original"));
  await writeFile(join(f.root, "stdout"), Buffer.from([88]));
  await c.write(frame(1, Buffer.from([25]))); c.finish(); await c.close();
  assert.equal((await readFile(join(f.root, "original")))[0], 25);
  assert.deepEqual(await readFile(join(f.root, "stdout")), Buffer.from([88]));
});

test("closed inputs reject accessors without invoking them and every successful close is attempted once", async t => {
  let reads = 0; let closes = 0;
  const f = await fixture(t, { async close(h) { closes += 1; return h.close(); } });
  const invalid = { ...f.input };
  Object.defineProperty(invalid, "root", { enumerable: true, get() { reads += 1; return f.root; } });
  await assert.rejects(openAcquisitionCapture(invalid), { code: "CAPTURE_INPUT" });
  assert.equal(reads, 0);
  const c = await f.create(); c.finish();
  const first = c.close(); assert.equal(c.close(), first); await first;
  assert.equal(closes, 2);
  assert.equal((await lstat(join(f.root, "stdout"))).size, limits.stdout);
});

test("failed close after complete framing remains separate and attempts both channel closes", async t => {
  let closes = 0;
  const f = await fixture(t, { async close(h) { const ordinal = ++closes; await h.close(); if (ordinal === 1) throw Error("synthetic close failure"); } });
  const c = await f.create(); await c.write(frame(2, Buffer.from([255])));
  assert.equal(c.finish().state, "complete");
  const r = await c.close();
  assert.equal(closes, 2); assert.equal(r.state, "incomplete"); assert.equal(r.firstError, "CLOSE_FAILED");
  assert.equal(r.ioClosed, "unknown"); assert.equal(r.channels.stderr.confirmedBytes, 1);
  assert.equal(r.channels.stderr.sha256, hash(Buffer.from([255])));
});
