import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, open, readFile, rm, link, symlink, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import { test } from "node:test";
import { openAcquisitionPayload, ACQUISITION_PAYLOAD_LIMITS as limits } from "../../../scripts/provenance-acquisition-payload.mjs";
import { acquisitionFileIdentity } from "../../../scripts/provenance-acquisition-file-io.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tabgrad-payload-")));
  const input = { root, destinations: {}, t0MonotonicNs: "100", deadlineNs: "1000" };
  const handles = new Set();
  let owner; let now = 101n; let writes = 0;
  t.after(async () => {
    options.cleanup?.();
    if (owner) await owner.close();
    await Promise.allSettled([...handles].map(h => h.close()));
    await rm(root, { recursive: true, force: true });
  });
  for (const [role, capacity] of [["stdout", 1048576], ["stderr", 262144]]) {
    const handle = await open(join(root, role), "wx+", 0o600);
    await handle.truncate(capacity);
    input.destinations[role] = { name: role, identity: { ...acquisitionFileIdentity(await handle.stat({ bigint: true })) } };
    await handle.close();
  }
  const transfer = {
    write(h, b, o, n, p) {
      handles.add(h); writes += 1;
      return options.write ? options.write(h, b, o, n, p) : h.write(b, o, n, p);
    },
    close(h) { handles.add(h); return options.close ? options.close(h) : h.close(); },
  };
  return { root, input, transfer, setTime(value) { now = value; }, get writes() { return writes; },
    async create() { owner = await openAcquisitionPayload(input, { clock: options.clock ?? (() => now), transfer }); return owner; },
    async prefix(role, length) { return (await readFile(join(root, role))).subarray(0, length); },
  };
}

test("raw binary payload is never interpreted as framing and channel finishes are independent", async t => {
  assert.deepEqual(limits, { stdout: 1048576, stderr: 262144 });
  const f = await fixture(t); const p = await f.create();
  const a = Buffer.from([1, 0, 0, 0, 255, 255, 255, 255, 128]);
  const b = Buffer.from([255, 0, 13, 10]);
  f.input.deadlineNs = "1"; f.input.destinations.stdout.identity.ino = "999";
  await p.write("stdout", a);
  assert.equal(p.finish("stdout").state, "pending");
  await assert.rejects(p.write("stdout", Buffer.alloc(0)), { code: "CAPTURE_STOPPED" });
  await p.write("stderr", b);
  const r = p.finish("stderr");
  assert.equal(r.state, "complete"); assert.deepEqual(r.complete, { stdout: true, stderr: true });
  for (const [role, expected] of [["stdout", a], ["stderr", b]]) {
    assert.equal(r.channels[role].submittedBytes, expected.length);
    assert.equal(r.channels[role].confirmedBytes, expected.length);
    assert.equal(r.channels[role].sha256, hash(expected));
    assert.deepEqual(await f.prefix(role, expected.length), expected);
    assert(Object.isFrozen(r.channels[role]));
  }
  assert(Object.isFrozen(r) && Object.isFrozen(r.complete) && Object.isFrozen(r.busy));
  assert.equal(r.externalClosure, "unqualified");
  const closing = p.close(); assert.equal(p.close(), closing);
  assert.equal((await closing).ioClosed, "closed");
});

test("one borrowed input per channel permits independent progress without queueing", async t => {
  const held = deferred(); const entered = deferred(); let calls = 0;
  const bytes = Buffer.from([128, 0, 255]);
  const f = await fixture(t, { cleanup: () => held.resolve(), async write(h, b, o, n, pos) {
    calls += 1;
    if (calls === 1) { assert.equal(b, bytes); entered.resolve(); await held.promise; }
    return h.write(b, o, n, pos);
  } });
  const p = await f.create(); const a = p.write("stdout", bytes); await entered.promise;
  await assert.rejects(p.write("stdout", Buffer.from([7])), { code: "CAPTURE_BUSY" });
  assert.throws(() => p.finish("stdout"), { code: "CAPTURE_BUSY" });
  assert.equal(p.snapshot().channels.stdout.submittedBytes, 3);
  assert.equal(p.snapshot().channels.stdout.confirmedBytes, 0);
  await p.write("stderr", Buffer.from([6])); p.finish("stderr");
  assert.equal(p.snapshot().ioPending, 1);
  assert.deepEqual(p.snapshot().busy, { stdout: true, stderr: false });
  assert.deepEqual(await f.prefix("stderr", 1), Buffer.from([6]));
  held.resolve(); await a; p.finish("stdout");
  bytes.fill(9); // Only after settlement; the persisted bytes and digest stay original.
  assert.equal(p.snapshot().channels.stdout.sha256, hash(Buffer.from([128, 0, 255])));
});

test("stop and close join two late writes, retain their effects and never restore success", async t => {
  const held = deferred(); const entered = deferred(); let calls = 0; let closes = 0;
  const f = await fixture(t, { cleanup: () => held.resolve(), async write(h, b, o, n, pos) {
    if (++calls === 2) entered.resolve();
    await held.promise; return h.write(b, o, n, pos);
  }, close(h) { closes += 1; return h.close(); } });
  const p = await f.create();
  const a = p.write("stdout", Buffer.from([11])); const b = p.write("stderr", Buffer.from([12]));
  await entered.promise; assert.equal(p.snapshot().ioPending, 2);
  p.stop();
  const rejected = Promise.all([a, b].map(work => assert.rejects(work, { code: "CAPTURE_STOPPED" })));
  const closing = p.close(); assert.equal(p.close(), closing);
  await turn(); assert.equal(closes, 0); assert.equal(p.snapshot().ioClosed, "pending");
  held.resolve(); await rejected; const r = await closing;
  assert.equal(closes, 2); assert.equal(r.firstError, "CAPTURE_STOPPED");
  assert.equal(r.state, "incomplete"); assert.equal(r.ioClosed, "closed");
  for (const [role, value] of [["stdout", 11], ["stderr", 12]]) {
    assert.equal(r.channels[role].confirmedBytes, 1);
    assert.equal(r.channels[role].sha256, hash(Buffer.from([value])));
  }
  await assert.rejects(p.write("stderr", Buffer.alloc(0)), { code: "CAPTURE_STOPPED" });
});

test("known short transfers borrow the same Buffer and advance positions without copying or replay", async t => {
  const bytes = Buffer.from([9, 8, 7, 6, 5]); const ranges = [];
  const f = await fixture(t, { write(h, b, o, n, pos) {
    assert.equal(b, bytes); ranges.push([o, n, pos]); return h.write(b, o, Math.min(n, 2), pos);
  } });
  const p = await f.create(); await p.write("stderr", bytes);
  assert.deepEqual(ranges, [[0, 5, 0], [2, 3, 2], [4, 1, 4]]);
  assert.equal(p.snapshot().channels.stderr.sha256, hash(bytes));
  assert.deepEqual(await f.prefix("stderr", 5), bytes);
});

test("uncertain effects stop both channels and preserve confirmed prefix separately from close failure", async t => {
  for (const outcome of [0, -1, 1.5, 99, null, "throw"]) {
    let calls = 0;
    const f = await fixture(t, { async write(h, b, o, n, pos) {
      if (++calls === 1) return h.write(b, o, 1, pos);
      if (outcome === "throw") { await h.write(b, o, 1, pos); throw Error("finite write failure"); }
      return { bytesWritten: outcome };
    }, async close(h) { await h.close(); throw Error("finite close failure"); } });
    const p = await f.create();
    const code = outcome === 0 ? "WRITE_NO_PROGRESS" : outcome === "throw" ? "WRITE_FAILED" : "WRITE_EXTENT_UNKNOWN";
    await assert.rejects(p.write("stdout", Buffer.from([9, 8, 7])), { code });
    await assert.rejects(p.write("stderr", Buffer.from([6])), { code });
    const r = await p.close(); assert.equal(calls, 2);
    assert.equal(r.firstError, code); assert.equal(r.ioClosed, "unknown");
    assert.equal(r.channels.stdout.submittedBytes, 3); assert.equal(r.channels.stdout.confirmedBytes, 1);
    assert.equal(r.channels.stdout.sha256, hash(Buffer.from([9])));
    assert.equal(r.channels.stdout.uncertain, outcome !== 0);
    assert.equal(r.channels.stdout.closeError, "CLOSE_FAILED");
    assert.equal((await f.prefix("stdout", 2))[1], outcome === "throw" ? 8 : 0);
  }
});

test("exact capacities, empty writes and excess reject without admitting the excess", async t => {
  for (const role of ["stdout", "stderr"]) {
    const f = await fixture(t); const p = await f.create();
    const capacity = role === "stdout" ? 1048576 : 262144;
    await p.write(role, Buffer.alloc(capacity, 0xa7)); await p.write(role, Buffer.alloc(0));
    const calls = f.writes;
    await assert.rejects(p.write(role, Buffer.from([1])), { code: "CAPTURE_LIMIT" });
    assert.equal(f.writes, calls); assert.equal(p.snapshot().state, "limit");
    assert.equal(p.snapshot().channels[role].confirmedBytes, capacity);
    const other = await fixture(t); const q = await other.create();
    await assert.rejects(q.write(role, Buffer.alloc(capacity + 1)), { code: "CAPTURE_LIMIT" });
    assert.equal(other.writes, 0); assert.equal(q.snapshot().channels[role].submittedBytes, 0);
  }
  const f = await fixture(t); const p = await f.create();
  p.finish("stdout"); assert.equal(p.finish("stderr").state, "complete");
  assert.equal(p.snapshot().channels.stdout.sha256, hash(Buffer.alloc(0)));
});

test("payload size, chunk size, role and repetitions vary independently with exact transfer counts", async t => {
  for (const spec of [{ size: 1, chunk: 1, repeats: 1, role: "stdout" },
    { size: 8192, chunk: 8192, repeats: 1, role: "stdout" },
    { size: 8192, chunk: 7, repeats: 1, role: "stdout" },
    { size: 1, chunk: 1, repeats: 32, role: "stdout" },
    { size: 1, chunk: 1, repeats: 1, role: "stderr" }]) {
    let transferred = 0;
    const f = await fixture(t, { write(h, b, o, n, pos) { transferred += n; return h.write(b, o, n, pos); } });
    const p = await f.create(); const bytes = Buffer.alloc(spec.size, 0xa7);
    for (let r = 0; r < spec.repeats; r += 1) {
      for (let i = 0; i < bytes.length; i += spec.chunk) await p.write(spec.role, bytes.subarray(i, i + spec.chunk));
    }
    assert.equal(transferred, spec.size * spec.repeats);
    assert.equal(f.writes, Math.ceil(spec.size / spec.chunk) * spec.repeats);
    assert.equal(p.snapshot().channels[spec.role].sha256, hash(Buffer.alloc(transferred, 0xa7)));
  }
});

test("clock is shared across channels, snapshots are passive, and late extents retain their original cutoff", async t => {
  const f = await fixture(t); const p = await f.create();
  f.setTime(500n); await p.write("stdout", Buffer.from([1]));
  f.setTime(400n); await assert.rejects(p.write("stderr", Buffer.from([2])), { code: "CAPTURE_CLOCK" });
  f.setTime(600n); await assert.rejects(p.write("stderr", Buffer.from([3])), { code: "CAPTURE_CLOCK" });
  assert.equal(f.writes, 1); assert.equal(p.snapshot().lastAtNs, "400");
  for (const value of [1100n, 99n, "bad", "throw"]) {
    let now = 101n;
    const g = await fixture(t, { clock() { if (now === "throw") throw Error("finite clock failure"); return now; },
      async write(h, b, o, n, pos) { const result = await h.write(b, o, n, pos); now = value; return result; },
    });
    const q = await g.create(); const code = value === 1100n ? "CAPTURE_DEADLINE" : "CAPTURE_CLOCK";
    await assert.rejects(q.write("stdout", Buffer.from([17])), { code });
    assert.equal(q.snapshot().channels.stdout.confirmedBytes, 1);
    assert.equal(q.snapshot().channels.stdout.sha256, hash(Buffer.from([17])));
    assert.throws(() => q.finish("stderr"), { code });
  }
});

test("closed input validation rejects accessors, malformed roles and nonbinary payload", async t => {
  let reads = 0;
  const f = await fixture(t); const invalid = { ...f.input };
  Object.defineProperty(invalid, "root", { enumerable: true, get() { reads += 1; return f.root; } });
  await assert.rejects(openAcquisitionPayload(invalid), { code: "CAPTURE_INPUT" }); assert.equal(reads, 0);
  for (const [role, bytes] of [["__proto__", Buffer.alloc(0)], ["stdout", "not binary"]]) {
    const g = await fixture(t); const p = await g.create();
    await assert.rejects(p.write(role, bytes), { code: "CAPTURE_INPUT" }); assert.equal(g.writes, 0);
  }
});

test("identified openings reject bad reservations and clean partial ownership; held paths remain stable", async t => {
  for (const change of [async f => { f.input.destinations.stdout.identity.ino = "999"; },
    async f => { f.input.destinations.stderr.identity.ino = "999"; },
    async f => { await rm(join(f.root, "stderr")); await link(join(f.root, "stdout"), join(f.root, "stderr")); },
    async f => { await rm(join(f.root, "stderr")); await symlink("stdout", join(f.root, "stderr")); },
    async f => { const h = await open(join(f.root, "stderr"), "r+"); await h.truncate(1); await h.close(); }]) {
    const f = await fixture(t); await change(f);
    await assert.rejects(f.create(), error => { assert.equal(error.cleanup.openedHandles, error.cleanup.closedHandles); return true; });
    assert.equal(f.writes, 0);
  }
  const f = await fixture(t); const p = await f.create();
  await rename(join(f.root, "stdout"), join(f.root, "original"));
  await writeFile(join(f.root, "stdout"), Buffer.from([99]));
  await p.write("stdout", Buffer.from([25])); await p.close();
  assert.equal((await readFile(join(f.root, "original")))[0], 25);
  assert.deepEqual(await readFile(join(f.root, "stdout")), Buffer.from([99]));
});

test("complete data with a failed close stays incomplete and both handles close exactly once", async t => {
  let closes = 0;
  const f = await fixture(t, { async close(h) { const i = ++closes; await h.close(); if (i === 1) throw Error("finite close failure"); } });
  const p = await f.create(); p.finish("stdout"); p.finish("stderr");
  const first = p.close(); assert.equal(p.close(), first); const r = await first;
  assert.equal(closes, 2); assert.equal(r.firstError, "CLOSE_FAILED");
  assert.equal(r.state, "incomplete"); assert.equal(r.ioClosed, "unknown");
  assert.equal(r.channels.stdout.closeError, "CLOSE_FAILED");
});
