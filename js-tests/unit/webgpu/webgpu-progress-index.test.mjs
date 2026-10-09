import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { ActiveGpuAdmissions } from "../../../dist/backends/webgpu/webgpu-active-admissions.js";
import { PendingGpuCompletions } from "../../../dist/backends/webgpu/webgpu-pending-completions.js";
import { GpuProgressNotifications, isGpuProgressPath, markGpuProgress } from "../../../dist/backends/webgpu/webgpu-progress-notification.js";
import { SharedGpuCompletion, publishSharedGpuFailure, publishSharedGpuDrain, publishSharedGpuSuccess } from "../../../dist/backends/webgpu/webgpu-shared-completion.js";

function owners(selective) {
  const paths = new Map();
  const pending = selective ? new PendingGpuCompletions((packet) => {
    paths.set(packet.completion, packet.progress);
    markGpuProgress(packet.progress);
    Atomics.or(new Int32Array(packet.completion, 0, 4), 3, 1);
  }) : new Set();
  const control = new Int32Array(new SharedArrayBuffer(16));
  const events = [];
  function add(label) {
    const completion = new SharedGpuCompletion(control, 0, () => undefined, () => {
      pending.delete(completion); events.push(label);
    }, () => selective && pending.failed(completion));
    pending.add(completion);
    return completion;
  }
  function fail(completion) {
    publishSharedGpuFailure(completion.buffer, control, Error("held"));
    assert.throws(() => completion.read(), { code: "BACKEND_STATUS_ERROR" });
  }
  function drain(completion) { publishSharedGpuDrain(completion.buffer, control, paths.get(completion.buffer)); }
  function advance() {
    if (selective) pending.advance(false);
    else for (const completion of pending) completion.refresh();
  }
  return { pending, paths, control, events, add, fail, drain, advance };
}

for (const pending of [8, 32, 128]) {
  for (const depth of [1, 4, 16]) {
    test(`nested progress preserves unresolved work: pending=${pending}, depth=${depth}`, () => {
      const results = [];
      for (const selective of [false, true]) {
        const f = owners(selective);
        const triggers = Array.from({ length: depth }, (_, i) => f.add(`trigger${i}`));
        const unresolved = Array.from({ length: pending }, (_, i) => f.add(`unresolved${i}`));
        const anchor = f.add("anchor");
        [...triggers, anchor].forEach(f.fail);
        f.advance();
        let visits = 0;
        for (const completion of unresolved) {
          const refresh = completion.refresh.bind(completion);
          completion.refresh = () => { visits += 1; refresh(); };
        }
        triggers.forEach((completion, i) => completion.onDrained(() => {
          if (i + 1 < depth) { f.drain(triggers[i + 1]); f.advance(); }
          else {
            f.advance();
            unresolved.forEach((entry) => publishSharedGpuSuccess(entry.buffer, f.control, new Uint8Array()));
          }
        }));
        f.drain(triggers[0]); f.advance();
        assert.equal(visits, 2 * pending, "nested inspection cannot consume the outer checkpoint's obligations");
        f.drain(anchor); f.advance();
        results.push(f.events);
      }
      assert.deepEqual(results[1], results[0]);
    });
  }
}

for (const changed of [1, 4, 32]) {
  test(`coalesced and reversed hints preserve admission order: changed=${changed}`, () => {
    const f = owners(true), entries = Array.from({ length: 32 }, (_, i) => f.add(i));
    entries.forEach(f.fail); f.advance();
    let visits = 0;
    entries.forEach((entry) => {
      const refresh = entry.refresh.bind(entry);
      entry.refresh = () => { visits += 1; refresh(); };
    });
    const selected = entries.slice(0, changed);
    for (const entry of selected.toReversed()) {
      f.drain(entry);
      markGpuProgress(f.paths.get(entry.buffer));
      markGpuProgress(f.paths.get(entry.buffer));
    }
    f.advance();
    assert.equal(visits, changed, "many hints for one record coalesce into one inspection");
    assert.deepEqual(f.events, selected.map((_, i) => i));
    entries.slice(changed).forEach(f.drain); f.advance();
    assert.deepEqual(f.events, Array.from({ length: 32 }, (_, i) => i));
  });
}

test("callback publications, admissions and nested checkpoints match the full-scan reference", () => {
  const results = [];
  for (const selective of [false, true]) {
    const f = owners(selective), a = f.add("a"), b = f.add("b"), c = f.add("c");
    [a, b, c].forEach(f.fail); f.advance();
    a.onDrained(() => {
      f.drain(c); f.drain(b);
      const d = f.add("d"); f.fail(d); f.drain(d);
      f.advance();
    });
    f.drain(a); f.advance(); results.push(f.events);
  }
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[1], ["a", "b", "c", "d"]);
});

for (const finishBeforeNested of [false, true]) {
  test(`publication obligation survives callbacks before final mark: ${finishBeforeNested}`, () => {
    const f = owners(true), a = f.add("a"), b = f.add("b");
    [a, b].forEach(f.fail); f.advance();
    const header = new Int32Array(b.buffer, 0, 4);
    Atomics.or(header, 3, 2); markGpuProgress(f.paths.get(b.buffer)); f.advance();
    // Simulate producer paused between BUSY clear and postmark. The prior
    // checkpoint inspected old D0 while BUSY; the callback now finishes D1.
    a.onDrained(() => {
      if (finishBeforeNested) { Atomics.store(header, 1, 1); Atomics.and(header, 3, ~2); }
      f.advance();
      if (!finishBeforeNested) { Atomics.store(header, 1, 1); Atomics.and(header, 3, ~2); }
    });
    f.drain(a); f.advance(); f.advance();
    assert.deepEqual(f.events, ["a", "b"]);
  });
}

test("retired notifications cannot address later entries, including bit31 and high identities", () => {
  const directory = new GpuProgressNotifications();
  const old = {}, oldPath = directory.add(old, 31);
  markGpuProgress(oldPath); directory.delete(old);
  const current = {}, path = directory.add(current, Number.MAX_SAFE_INTEGER - 1), seen = [];
  markGpuProgress(oldPath); directory.collect((entry) => seen.push(entry));
  assert.deepEqual(seen, []);
  markGpuProgress(path); directory.collect((entry) => seen.push(entry));
  assert.deepEqual(seen, [current]);
  directory.delete(current); assert.equal(directory.size, 0);
  assert.equal(isGpuProgressPath(path), true);
  for (const invalid of [[], path.slice(1), path.map((w, i) => i === 0 ? { ...w, mask: 3 } : w),
    path.map((w, i) => i === 0 ? { ...w, buffer: new ArrayBuffer(4) } : w),
    path.map((w, i) => i === 0 ? { ...w, buffer: new SharedArrayBuffer(8) } : w)]) {
    assert.equal(isGpuProgressPath(invalid), false);
  }
});

test("balanced admission mutations agree with an independent sorted active reference", () => {
  const index = new ActiveGpuAdmissions(), live = new Map();
  let seed = 234;
  function random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; }
  for (let step = 0; step < 2000; step += 1) {
    const id = random() % 256, action = random() % 3;
    if (action === 0 && !live.has(id)) { index.add(id, id); live.set(id, true); }
    else if (action === 1) { index.delete(id); live.delete(id); }
    else { const active = (random() & 1) !== 0; index.setActive(id, active); if (live.has(id)) live.set(id, active); }
    for (const cursor of [-1, random() % 256, 256]) {
      const expected = [...live].filter(([key, active]) => active && key > cursor).map(([key]) => key).sort((a, b) => a - b)[0];
      assert.equal(index.nextAfter(cursor), expected);
    }
  }
  for (const id of live.keys()) index.delete(id);
  assert.equal(index.nextAfter(-1), undefined);
});

test("all current index/request collections empty after finite drain", () => {
  const NativeMap = Map, NativeSet = Set, collections = [];
  let constructingOwner = true;
  globalThis.Map = class extends NativeMap { constructor(...args) { super(...args); collections.push(this); } };
  globalThis.Set = class extends NativeSet { constructor(...args) { super(...args); if (constructingOwner) collections.push(this); } };
  try {
    const pending = new PendingGpuCompletions((packet) => {
      markGpuProgress(packet.progress); Atomics.or(new Int32Array(packet.completion, 0, 4), 3, 1);
    });
    constructingOwner = false; // Later collection scratch sets are temporary, not owned history.
    const control = new Int32Array(new SharedArrayBuffer(16));
    const entries = Array.from({ length: 128 }, () => {
      const completion = new SharedGpuCompletion(control, 0, () => undefined, () => pending.delete(completion), () => pending.failed(completion));
      pending.add(completion); publishSharedGpuFailure(completion.buffer, control, Error("held"));
      assert.throws(() => completion.read()); return completion;
    });
    pending.advance(false);
    entries.forEach((entry) => publishSharedGpuDrain(entry.buffer, control));
    pending.advance(true);
    assert(collections.length > 0, "instrumentation observes real production collections");
    assert(collections.every((collection) => collection.size === 0));
  } finally { globalThis.Map = NativeMap; globalThis.Set = NativeSet; }
});

test("safe identity exhaustion preserves direct inspection without an admission error", async () => {
  // Seed only the scalar boundary in an isolated emitted module, retaining the
  // actual production algorithms. No production test hook or admission limit.
  const url = new URL("../../../dist/backends/webgpu/webgpu-pending-completions.js", import.meta.url);
  let source = await readFile(url, "utf8");
  assert.equal(source.split("#next = 0;").length, 2);
  source = source.replace("#next = 0;", "#next = Number.MAX_SAFE_INTEGER - 1;");
  source = source.replace(/from "([^\"]+)"/g, (_, path) => `from ${JSON.stringify(new URL(path, url).href)}`);
  const { PendingGpuCompletions: BoundaryOwner } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const pending = new BoundaryOwner(() => assert.fail("exhausted IDs use direct inspection"));
  const events = [];
  for (let i = 0; i < 3; i += 1) {
    const completion = { buffer: new SharedArrayBuffer(16), isDrained: () => false,
      refresh() { events.push(i); } };
    pending.add(completion);
  }
  pending.advance(false); assert.deepEqual(events, [0, 1, 2]);
});

test("a changed hint after inspection remains eligible even at numeric change-history exhaustion", async () => {
  const url = new URL("../../../dist/backends/webgpu/webgpu-pending-completions.js", import.meta.url);
  let source = await readFile(url, "utf8");
  // Exercise a numeric history boundary only while such a counter exists. The
  // observable contract below also applies to an implementation with no counter.
  source = source.replace("version: 0, seen: 0", "version: Number.MAX_SAFE_INTEGER, seen: Number.MAX_SAFE_INTEGER");
  source = source.replace(/from "([^\"]+)"/g, (_, path) => `from ${JSON.stringify(new URL(path, url).href)}`);
  const { PendingGpuCompletions: BoundaryOwner } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  let path, retired = 0, publishAfterRefresh = false;
  const control = new Int32Array(new SharedArrayBuffer(16));
  const pending = new BoundaryOwner((packet) => {
    path = packet.progress; markGpuProgress(path); Atomics.or(new Int32Array(packet.completion, 0, 4), 3, 1);
  });
  const completion = new SharedGpuCompletion(control, 0, () => undefined, () => { pending.delete(completion); retired += 1; }, () => pending.failed(completion));
  pending.add(completion); publishSharedGpuFailure(completion.buffer, control, Error("held"));
  assert.throws(() => completion.read()); pending.advance(false);
  const refresh = completion.refresh.bind(completion);
  completion.refresh = () => {
    refresh();
    if (publishAfterRefresh) { publishAfterRefresh = false; publishSharedGpuDrain(completion.buffer, control, path); }
  };
  markGpuProgress(path); publishAfterRefresh = true; pending.advance(false);
  pending.advance(false);
  assert.equal(retired, 1, "a new post-inspection hint cannot disappear at outer cleanup");
});

test("ordinary success allocates no notification words or marking atomics", () => {
  const NativeBuffer = SharedArrayBuffer, originalOr = Atomics.or;
  let words = 0, marks = 0;
  globalThis.SharedArrayBuffer = class extends NativeBuffer {
    constructor(bytes) { super(bytes); if (bytes === 4) words += 1; }
  };
  Atomics.or = (...args) => { marks += 1; return originalOr(...args); };
  try {
    const f = owners(true);
    for (let i = 0; i < 32; i += 1) {
      const completion = f.add(i);
      publishSharedGpuSuccess(completion.buffer, f.control, new Uint8Array()); f.advance();
      assert.equal(completion.read(), undefined);
    }
    assert.equal(words, 0); assert.equal(marks, 0);
    assert.deepEqual(f.events, Array.from({ length: 32 }, (_, i) => i));
  } finally { globalThis.SharedArrayBuffer = NativeBuffer; Atomics.or = originalOr; }
});

test("failure already drained before observation retires without enrollment", () => {
  const f = owners(true), completion = f.add("drained");
  publishSharedGpuFailure(completion.buffer, f.control, Error("failed"));
  publishSharedGpuDrain(completion.buffer, f.control);
  assert.throws(() => completion.read());
  assert.deepEqual(f.events, ["drained"]); assert.equal(f.paths.size, 0);
  f.advance(); assert.deepEqual(f.events, ["drained"]);
});

test("subscription failure after reentrant retirement cannot retain a completed owner", () => {
  const NativeSet = Set, owned = [];
  globalThis.Set = class extends NativeSet { constructor(...args) { super(...args); owned.push(this); } };
  let completion, pending;
  try {
    pending = new PendingGpuCompletions(() => { pending.delete(completion); throw Error("late transport error"); });
  } finally { globalThis.Set = NativeSet; }
  completion = { buffer: new SharedArrayBuffer(16), isDrained: () => false, refresh() {} };
  pending.add(completion); pending.failed(completion); pending.advance(false);
  assert(owned.every((set) => set.size === 0), "fallback owns only still-live obligations");
});

test("sparse cloned notification paths are rejected before atomic publication", () => {
  assert.equal(isGpuProgressPath(new Array(11)), false);
  const directory = new GpuProgressNotifications(), value = {}, path = [...directory.add(value, 0)];
  delete path[3]; assert.equal(isGpuProgressPath(path), false);
  directory.delete(value);
});
