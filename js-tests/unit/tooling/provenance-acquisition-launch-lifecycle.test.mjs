import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createAcquisitionLauncher } from "../../../scripts/provenance-acquisition-launch.mjs";
import { copyLaunchProfile, encodeLaunchProfile } from "../../../scripts/provenance-acquisition-launch-profile.mjs";
import { createLaunchControlDecoder } from "../../../scripts/provenance-acquisition-launch-protocol.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const childPath = resolve("js-tests/fixtures/provenance-acquisition-launch-child.mjs");
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const fileIdentity = s => ({ dev: String(s.dev), ino: String(s.ino) });

class Harness {
  static async create(mode = "empty") {
    const h = new Harness();
    h.root = await realpath(await mkdtemp(join(tmpdir(), "launch-life-")));
    h.opens = []; h.closes = []; h.spawns = []; h.writes = [];
    h.hooks = {};
    h.handles = [];
    const endpoints = {};
    for (const role of ["stdout", "stderr", "control"]) {
      const path = join(h.root, role);
      await writeFile(path, "");
      endpoints[role] = { name: role, identity: fileIdentity(await stat(path, { bigint: true })) };
    }
    const credentials = { uid: "1000", gid: "1000", groups: ["1000"] };
    const program = { binarySha256: "3".repeat(64), argv: [process.execPath, childPath, mode], env: ["ONLY=explicit"], workingDir: h.root };
    const data = { schemaVersion: 1, operationId: "a".repeat(32),
      launcher: { runtimePath: process.execPath, runtimeSha256: "1".repeat(64), entryPath: resolve("scripts/provenance-acquisition-launch.mjs"),
        entrySha256: "2".repeat(64), ...credentials }, program,
      programRecipeSha256: hash(JSON.stringify({ program, credentials })),
      ipc: { root: { path: h.root, identity: fileIdentity(await stat(h.root, { bigint: true })) }, ...endpoints },
      timing: { t0MonotonicNs: String(process.hrtime.bigint()), workUntilNs: "5000000000", closeUntilNs: "10000000000" } };
    const bytes = encodeLaunchProfile(data);
    h.admitted = copyLaunchProfile(bytes, { sha256: hash(bytes), bytes: bytes.length });
    h.ports = { credentials: () => ({ pid: "123", ...credentials }), openWriter: h.openWriter.bind(h), spawn: h.spawn.bind(h) };
    return h;
  }
  async openWriter(path) {
    const role = path.slice(path.lastIndexOf("/") + 1);
    this.opens.push(role);
    if (this.hooks.beforeOpen) await this.hooks.beforeOpen(role);
    const handle = await open(path, "r+");
    this.handles.push(handle);
    const h = this;
    const wrapper = {
      fd: handle.fd,
      async stat() {
        if (h.hooks.stat) return h.hooks.stat(role, handle);
        const s = await handle.stat({ bigint: true });
        // Explicit synthetic type over an ordinary file: NOT native FIFO qualification.
        return { dev: s.dev, ino: s.ino, isFIFO: () => true };
      },
      async write(buffer, offset, length, position) {
        h.writes.push({ role, bytes: Buffer.from(buffer.subarray(offset, offset + length)) });
        if (h.hooks.write) return h.hooks.write(role, handle, buffer, offset, length, position);
        return handle.write(buffer, offset, length, position);
      },
      async close() {
        h.closes.push(role);
        if (h.hooks.close) await h.hooks.close(role);
        await handle.close();
      },
    };
    if (this.hooks.afterOpen) await this.hooks.afterOpen(role);
    return wrapper;
  }
  spawn(binary, args, options) {
    this.spawns.push({ binary, args, options });
    if (this.hooks.spawn) return this.hooks.spawn(binary, args, options);
    return spawn(binary, args, options);
  }
  launcher(extra = {}) { return createAcquisitionLauncher(this.admitted, { ...this.ports, ...extra }); }
  async control() {
    const d = createLaunchControlDecoder({ operationId: this.admitted.profile.operationId, profileSha256: this.admitted.sha256 });
    d.push(await readFile(join(this.root, "control")));
    return d.finish();
  }
  async dispose() {
    await Promise.allSettled(this.handles.map(handle => handle.close()));
    await rm(this.root, { recursive: true, force: true });
  }
}

test("finite child: empty, one-byte, binary and diagnostic-like payload stay on their own FDs", async () => {
  for (const [mode, out, err] of [["empty", [], []], ["one", [120], [121]],
    ["binary", [0, 255, 10, 124], [128, 0, 13]], ["diagnostic", [...Buffer.from("LAUNCH_FAILED\n")], []]]) {
    const h = await Harness.create(mode);
    try {
      const launcher = h.launcher();
      const promise = launcher.run();
      assert.equal(launcher.run(), promise);
      const result = await promise;
      assert.equal(result.exitStatus, 0);
      assert.equal(h.spawns.length, 1);
      assert.equal(h.spawns[0].options.stdio.length, 3);
      assert.equal(h.spawns[0].options.stdio[0], "ignore");
      assert.deepEqual({ ...h.spawns[0].options.env }, { ONLY: "explicit" });
      assert.equal(h.spawns[0].options.shell, false);
      assert.deepEqual([...await readFile(join(h.root, "stdout"))], out);
      assert.deepEqual([...await readFile(join(h.root, "stderr"))], err);
      assert.deepEqual(h.opens, ["control", "stdout", "stderr"]);
      assert.deepEqual(h.closes.slice().sort(), ["control", "stderr", "stdout"]);
      const control = await h.control();
      assert.ok(control.observations.R && control.observations.S && control.observations.X && control.observations.E);
      assert.equal(control.observations.F, null);
      assert.equal(result.payloadOrigin, "unqualified");
      assert.equal(result.externalClosure, "unqualified");
      assert.equal(result.clockAdmission, "unqualified");
      assert.equal(result.releaseAdmission, "unqualified");
      assert.ok(Object.isFrozen(result));
      assert.equal((await launcher.join()).exitStatus, 0);
    } finally { await h.dispose(); }
  }
});

test("nonzero, signal, synchronous throw and asynchronous spawn error preserve settled results", async () => {
  for (const mode of ["fail", "signal", "throw", "error"]) {
    const h = await Harness.create(mode === "fail" ? mode : "empty");
    try {
      if (mode === "throw") h.hooks.spawn = () => { throw Error("PRIVATE"); };
      if (["signal", "error"].includes(mode)) h.hooks.spawn = () => {
        const child = new EventEmitter(); child.pid = 321;
        queueMicrotask(() => {
          if (mode === "error") child.emit("error", Error("PRIVATE"));
          else child.emit("spawn");
          child.emit("close", null, mode === "signal" ? "SIGTERM" : null);
        });
        return child;
      };
      const result = await h.launcher().run();
      assert.equal(result.cause, ["throw", "error"].includes(mode) ? "spawn" : "child");
      assert.equal(result.exitStatus, 1);
      assert.equal(result.childSettled, true);
      assert.equal(result.exitCode, mode === "fail" ? 7 : null);
      assert.equal(result.signal, mode === "signal" ? 15 : null);
      const control = await h.control();
      assert.ok(control.observations.F && control.observations.X && control.observations.E);
      assert.equal((await readFile(join(h.root, "control"))).includes("PRIVATE"), false);
    } finally { await h.dispose(); }
  }
});

test("stop before run has no actors; each failed open/identity disposes every known handle", async () => {
  const stopped = await Harness.create();
  try {
    const l = stopped.launcher(); l.stop(); l.stop();
    assert.equal((await l.run()).cause, "stopped");
    assert.equal(stopped.opens.length, 0); assert.equal(stopped.spawns.length, 0);
  } finally { await stopped.dispose(); }
  for (const role of ["control", "stdout", "stderr"]) for (const failure of ["open", "identity"]) {
    const h = await Harness.create();
    try {
      if (failure === "open") h.hooks.beforeOpen = r => { if (r === role) throw Error("PRIVATE"); };
      else h.hooks.stat = async (r, handle) => {
        const s = await handle.stat({ bigint: true });
        return { dev: s.dev, ino: r === role ? 1n : s.ino, isFIFO: () => true };
      };
      const result = await h.launcher().run();
      assert.equal(result.cause, failure);
      assert.equal(h.spawns.length, 0);
      assert.equal(h.closes.length, h.handles.length);
      assert.equal(result.pendingEffects, 0);
      if (role !== "control") assert.ok((await h.control()).observations.E);
    } finally { await h.dispose(); }
  }
});

test("R must finish before spawn; stop during a held write prevents any spawn", async () => {
  const h = await Harness.create();
  const held = deferred();
  try {
    let first = true;
    h.hooks.write = async (role, handle, bytes, offset, length, position) => {
      if (first) { first = false; await held.promise; }
      return handle.write(bytes, offset, length, position);
    };
    const l = h.launcher(); const running = l.run();
    while (!h.writes.length) await tick();
    assert.equal(h.spawns.length, 0);
    l.stop(); held.resolve();
    const result = await running;
    assert.equal(result.cause, "stopped"); assert.equal(h.spawns.length, 0);
    const control = await h.control();
    assert.ok(control.observations.R && control.observations.F && control.observations.E);
    assert.equal(control.observations.X, null);
  } finally { held.resolve(); await h.dispose(); }
});

test("short writes advance only confirmed extents; unknown/zero/invalid writes never retry", async () => {
  for (const mode of ["short", "zero", "throw", "invalid"]) {
    const h = await Harness.create();
    try {
      h.hooks.write = async (role, handle, bytes, offset, length, position) => {
        if (mode === "throw") throw Error("PRIVATE");
        if (mode === "zero") return { bytesWritten: 0 };
        if (mode === "invalid") return { bytesWritten: length + 1 };
        return handle.write(bytes, offset, Math.min(7, length), position);
      };
      const result = await h.launcher().run();
      if (mode === "short") { assert.equal(result.exitStatus, 0); await h.control(); }
      else {
        assert.equal(result.cause, "control"); assert.equal(h.spawns.length, 0);
        assert.equal(h.writes.length, 1); assert.equal(result.confirmedControlBytes, 0);
      }
    } finally { await h.dispose(); }
  }
});

test("close observation, not exit, settles child; output close starts before control completes", async () => {
  const h = await Harness.create();
  const child = new EventEmitter(); child.pid = 321;
  try {
    h.hooks.spawn = () => child;
    const l = h.launcher(); const running = l.run();
    while (!h.spawns.length) await tick();
    child.emit("spawn"); child.emit("exit", 0, null);
    await tick();
    assert.equal(l.snapshot().childSettled, false);
    assert.ok(h.closes.includes("stdout") && h.closes.includes("stderr"));
    child.emit("close", 0, null);
    assert.equal((await running).exitStatus, 0);
    await h.control();
  } finally { await h.dispose(); }
});

test("late opening after absolute expiry stays owned, closed and sticky in fresh snapshots", async () => {
  const h = await Harness.create();
  const held = deferred();
  const timers = [];
  let now = BigInt(h.admitted.profile.timing.t0MonotonicNs);
  try {
    h.hooks.afterOpen = role => role === "stdout" ? held.promise : undefined;
    const l = h.launcher({ clock: () => now, schedule: cb => { timers.push(cb); return cb; }, cancel: () => {} });
    const running = l.run();
    while (!h.opens.includes("stdout") || h.handles.length < 2) await tick();
    now += 10000000000n; timers[1]();
    const expired = await running;
    assert.equal(expired.cleanupWaitExpired, true);
    assert.equal(expired.pendingEffects, 1);
    assert.equal(expired.fds, "nn");
    held.resolve();
    while (l.snapshot().pendingEffects || l.snapshot().controlFd !== "c") await tick();
    const late = l.snapshot();
    assert.equal(late.fds, "cn"); assert.equal(late.cause, "deadline");
    assert.equal(late.exitStatus, 1); assert.equal(late.observations.E, null);
    assert.equal(expired.fds, "nn"); assert.equal(h.spawns.length, 0);
  } finally { held.resolve(); await h.dispose(); }
});

test("late failed close preserves first cause and cleanup; E waits for owned operations", async () => {
  const h = await Harness.create("fail");
  const held = deferred();
  try {
    h.hooks.close = async role => { if (role === "stdout") { await held.promise; throw Error("PRIVATE"); } };
    const l = h.launcher(); const running = l.run();
    while (!l.snapshot().childSettled) await tick();
    assert.equal(l.snapshot().observations.E, null);
    held.resolve();
    const result = await running;
    assert.equal(result.cause, "child"); assert.equal(result.cleanupError, "close"); assert.equal(result.fds, "uc");
    assert.ok((await h.control()).observations.E);
  } finally { held.resolve(); await h.dispose(); }
});

test("bad credentials, clock regression and unknown signal fail closed without private diagnostics", async () => {
  for (const mode of ["credentials", "clock", "signal"]) {
    const h = await Harness.create();
    try {
      const extra = {};
      if (mode === "credentials") extra.credentials = () => ({ pid: "123", uid: "0", gid: "1000", groups: ["1000"] });
      if (mode === "clock") {
        let first = true;
        const t0 = BigInt(h.admitted.profile.timing.t0MonotonicNs);
        extra.clock = () => { const value = first ? t0 + 10n : t0 + 9n; first = false; return value; };
      }
      if (mode === "signal") h.hooks.spawn = () => {
        const c = new EventEmitter(); c.pid = 321;
        queueMicrotask(() => { c.emit("spawn"); c.emit("close", null, "PRIVATE_SIGNAL"); }); return c;
      };
      const result = await h.launcher(extra).run();
      assert.equal(result.cause, mode === "credentials" ? "input" : mode === "clock" ? "clock" : "protocol");
      assert.equal(result.exitStatus, 1);
      if (mode !== "signal") assert.equal(h.spawns.length, 0);
      else await h.control();
    } finally { await h.dispose(); }
  }
});

test("clock failure during first control transfer cannot start a concurrent control writer", async () => {
  const h = await Harness.create();
  try {
    const t0 = BigInt(h.admitted.profile.timing.t0MonotonicNs);
    let bad = false;
    let active = 0;
    let peak = 0;
    h.hooks.write = async (role, handle, bytes, offset, length, position) => {
      active++; peak = Math.max(peak, active); bad = true;
      await tick();
      try { return await handle.write(bytes, offset, length, position); }
      finally { active--; }
    };
    const result = await h.launcher({ clock: () => bad ? t0 - 1n : t0 }).run();
    assert.equal(result.cause, "clock"); assert.equal(peak, 1);
    assert.equal(h.spawns.length, 0);
    assert.equal(result.observations.E, null);
  } finally { await h.dispose(); }
});

test("original work and close cutoffs reject at the boundary without renewing origin", async () => {
  for (const offset of [4999999999n, 5000000000n, 5000000001n]) {
    const h = await Harness.create();
    try {
      const t0 = BigInt(h.admitted.profile.timing.t0MonotonicNs);
      const result = await h.launcher({ clock: () => t0 + offset, schedule: () => null, cancel: () => {} }).run();
      assert.equal(result.exitStatus, offset < 5000000000n ? 0 : 1);
      assert.equal(h.spawns.length, offset < 5000000000n ? 1 : 0);
      if (h.spawns.length) await h.control();
    } finally { await h.dispose(); }
  }
  const h = await Harness.create("fail");
  try {
    const t0 = BigInt(h.admitted.profile.timing.t0MonotonicNs);
    let now = t0;
    h.hooks.close = role => { if (role === "control") now = t0 + 10000000000n; };
    const result = await h.launcher({ clock: () => now }).run();
    assert.equal(result.cause, "child");
    assert.equal(result.cleanupError, "deadline");
    assert.equal(result.exitStatus, 1);
  } finally { await h.dispose(); }
});

test("held child is not invented as closed at expiry; late close cannot restore success", async () => {
  const h = await Harness.create();
  const child = new EventEmitter(); child.pid = 321;
  const timers = [];
  let now = BigInt(h.admitted.profile.timing.t0MonotonicNs);
  try {
    h.hooks.spawn = () => child;
    const l = h.launcher({ clock: () => now, schedule: cb => { timers.push(cb); return cb; }, cancel: () => {} });
    const running = l.run();
    while (!h.spawns.length) await tick();
    child.emit("spawn");
    now += 10000000000n; timers[1]();
    const expired = await running;
    assert.equal(expired.childSettled, false);
    assert.equal(expired.observations.X, null);
    child.emit("close", 0, null);
    while (l.snapshot().controlFd !== "c") await tick();
    assert.equal(l.snapshot().childSettled, true);
    assert.equal(l.snapshot().exitCode, 0);
    assert.equal(l.snapshot().exitStatus, 1);
    assert.equal(l.snapshot().observations.E, null);
  } finally { await h.dispose(); }
});

test("control close failure after E remains separate and fails launcher without rewriting E", async () => {
  const h = await Harness.create();
  try {
    h.hooks.close = role => { if (role === "control") throw Error("PRIVATE"); };
    const result = await h.launcher().run();
    assert.equal(result.exitStatus, 1);
    assert.equal(result.cause, "close");
    assert.equal(result.cleanupError, "close");
    assert.equal(result.controlFd, "u");
    const control = await h.control();
    assert.equal(control.observations.E.cause, null);
    assert.equal(control.observations.F, null);
  } finally { await h.dispose(); }
});

test("fixed entry rejects invalid arguments with only a closed diagnostic", () => {
  const entry = resolve("scripts/provenance-acquisition-launch.mjs");
  const result = spawnSync(process.execPath, [entry, "PRIVATE_ARGUMENT"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "LAUNCH_FAILED\n");
});

test("native failures are classified before their failed subsequent clock sample", async () => {
  for (const operation of ["open", "close", "throw", "error", "child", "pid"]) {
    const h = await Harness.create();
    try {
      const t0 = BigInt(h.admitted.profile.timing.t0MonotonicNs);
      let invalid = false;
      if (operation === "open") h.hooks.beforeOpen = () => { invalid = true; throw Error("PRIVATE"); };
      // Control closes after every other transfer/close settles: isolate this await's observation order.
      else if (operation === "close") h.hooks.close = role => { if (role === "control") { invalid = true; throw Error("PRIVATE"); } };
      else if (operation === "throw") h.hooks.spawn = () => { invalid = true; throw Error("PRIVATE"); };
      else h.hooks.spawn = () => {
        const c = new EventEmitter(); c.pid = operation === "pid" ? 0 : 321;
        queueMicrotask(() => {
          if (operation === "pid") invalid = true;
          c.emit("spawn");
          invalid = true;
          if (operation === "error") c.emit("error", Error("PRIVATE"));
          c.emit("close", operation === "error" ? null : operation === "child" ? 7 : 0, null);
        });
        return c;
      };
      const result = await h.launcher({ clock: () => invalid ? t0 - 1n : t0 }).run();
      assert.equal(result.cause, ["throw", "error"].includes(operation) ? "spawn" : operation === "pid" ? "protocol" : operation);
      assert.equal(result.cleanupError, operation === "close" ? "close" : "clock");
      assert.equal(result.exitStatus, 1);
      if (operation !== "close") assert.equal(result.observations.E, null);
      else assert.ok(result.observations.E);
    } finally { await h.dispose(); }
  }
});
