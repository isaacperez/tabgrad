import assert from "node:assert/strict";
import { test } from "node:test";
import { acquisitionSha256 } from "../../../scripts/provenance-acquisition-record.mjs";
import { captureFixture, until } from "../../fixtures/provenance-acquisition-capture-attempt.mjs";
import { wireFrame } from "../../fixtures/provenance-acquisition-exec.mjs";

test("preparation is inert to the gate; empty local capture binds recipes and leaves the caller's controls alive", async t => {
  const f = await captureFixture(t); const owner = f.create();
  assert.equal(f.fileHandles.length, 0); assert.equal(f.fifoHandles.length, 0); assert.equal(f.checks, 0);
  const opening = owner.open(); assert.equal(owner.open(), opening);
  const ready = await opening;
  assert.equal(ready.prepared, true); assert.equal(f.checks, 0); assert.equal(f.daemon.requests.length, 0);
  assert.equal(f.fileHandles.length, 10); assert.equal(f.fileHandles.filter(h => h.closes === 1).length, 5);
  const running = owner.run(); assert.equal(owner.run(), running);
  const end = await running;
  assert.equal(end.localComplete, true, JSON.stringify(end)); assert.equal(end.firstFailure, null);
  assert.equal(end.finished, true); assert.equal(end.control.finished, true); assert.equal(end.exec.protocolComplete, true);
  assert.equal(f.daemon.requests.length, 4); assert.equal(f.acknowledgements.length, 1); assert.deepEqual(f.revocations, []);
  assert.equal(end.execBodySha256, acquisitionSha256(f.daemon.requests[0].body));
  assert.equal(end.profileSha256, f.input.launcherProfile.sha256); assert.equal(end.programRecipeSha256, f.launch.programRecipeSha256);
  assert.deepEqual(await f.original("launch.control", f.control.length), f.control);
  assert.equal(end.files.control.channels.control.sha256, acquisitionSha256(f.control));
  assert.equal(end.files.program.channels.stdout.confirmedBytes, 0); assert.equal(end.files.daemon.channels.stdout.confirmedBytes, 0);
  assert(f.fifoHandles.every(h => h.closes === 1)); assert(f.fileHandles.every(h => h.closes === 1));
  assert.equal(ready.finished, false); assert(Object.isFrozen(end.control.observations));
  assert.equal(end.otherInputSeparation, "unqualified"); assert.equal(end.externalClosure, "unqualified");
  assert.equal(end.releaseAdmission, "unqualified");
});

test("binary program originals are separated from control and daemon files", async t => {
  const stdout = Buffer.from([0, 255, 128, 10]); const stderr = Buffer.from([7, 0, 254]);
  const f = await captureFixture(t, { stdout: [stdout.subarray(0, 2), stdout.subarray(2)], stderr: [stderr] });
  const owner = f.create(); await owner.open(); const end = await owner.run();
  assert.equal(end.localComplete, true, JSON.stringify(end));
  for (const [role, bytes, name] of [["stdout", stdout, "program.out"], ["stderr", stderr, "program.err"]]) {
    assert.deepEqual(await f.original(name, bytes.length), bytes);
    assert.equal(end.files.program.channels[role].sha256, acquisitionSha256(bytes));
    assert.equal(end.fifo.channels[role].readBytes, bytes.length);
    assert.equal(end.files.daemon.channels[role].confirmedBytes, 0);
  }
});

test("nine-file aliases, missing record inventory and accessors reject before any I/O", async t => {
  for (const change of [f => { delete f.input.recordCapture; },
    f => { f.input.programCapture.destinations.stdout = f.input.exec.capture.destinations.stdout; },
    f => { f.input.recordCapture.destinations.watchdog = f.input.recordCapture.destinations.supervisor; },
    f => { f.input.recordCapture.destinations.header.identity = f.input.launcherProfile.identity; },
    f => { Object.defineProperty(f.input.recordCapture, "destinations", { enumerable: true, get() { assert.fail("getter invoked"); } }); }]) {
    const f = await captureFixture(t); change(f); assert.throws(() => f.create()); assert.equal(f.fileHandles.length, 0);
  }
});

test("nonempty daemon data revokes independently of its text or reported zero exit", async t => {
  for (const role of [1, 2]) {
    const bytes = Buffer.from([0, 255, 65]); const f = await captureFixture(t, { daemonBytes: wireFrame(role, bytes) });
    const owner = f.create(); await owner.open(); const end = await owner.run();
    assert.equal(end.firstFailure, "CAPTURE_ATTEMPT_DAEMON_OUTPUT"); assert.equal(end.localComplete, false);
    const channel = role === 1 ? "stdout" : "stderr";
    assert.equal(end.files.daemon.channels[channel].receivedBytes, bytes.length);
    const n = owner.snapshot().files.daemon.channels[channel].confirmedBytes;
    assert.deepEqual(await f.original(`${channel}.payload`, n), bytes.subarray(0, n));
    assert.equal(f.revocations.length, 1);
  }
});

test("control bytes persist before parsing; malformed input keeps its original confirmed prefix", async t => {
  const bytes = Buffer.from("invalid-control\n"); const f = await captureFixture(t, { control: [bytes] });
  const owner = f.create(); await owner.open(); const end = await owner.run();
  assert.equal(end.firstFailure, "LAUNCH_CONTROL"); assert.equal(end.localComplete, false);
  assert.deepEqual(await f.original("launch.control", bytes.length), bytes);
  assert.equal(end.files.control.channels.control.confirmedBytes, bytes.length);
});

test("stop during a late profile open owns its eventual handle and never opens another file", async t => {
  let hold; const f = await captureFixture(t, { fileOpen: () => hold.promise }); hold = f.hold();
  const owner = f.create(); const opening = owner.open(); await until(() => f.fileHandles.length === 1);
  const before = owner.snapshot(); owner.stop(); hold.resolve(); const end = await opening;
  assert.equal(end.firstFailure, "CAPTURE_ATTEMPT_STOPPED"); assert.equal(end.localComplete, false);
  assert.equal(f.fileHandles.length, 1); assert.equal(f.fileHandles[0].closes, 1); assert.equal(f.daemon.requests.length, 0);
  assert.equal(before.files.pendingEffects, 1); assert.equal(before.opening, true); assert.equal(end.files.pendingEffects, 0);
});

test("E and Exec settle in either order; sentinels release only after both", async t => {
  for (const later of ["control", "exec"]) {
    let ready = false; let heldRequest;
    const f = await captureFixture(t, {
      read(h) { if (later === "control" && h.role === "control" && !ready) return { bytesRead: 0 }; },
      reply(request) { if (later === "exec" && request.index === 3) { heldRequest = request; return true; } },
    });
    const owner = f.create(); await owner.open(); const running = owner.run();
    await until(() => later === "control" ? owner.snapshot().exec.protocolComplete : owner.snapshot().control.observations.E);
    assert(f.fifoHandles.filter(h => h.kind === "sentinel").every(h => h.closes === 0));
    if (later === "control") ready = true;
    else {
      await until(() => heldRequest);
      const { inspectBody, jsonReply } = await import("../../fixtures/provenance-acquisition-exec.mjs");
      jsonReply(heldRequest.socket, inspectBody(false, { ProcessConfig: { tty: false, privileged: false,
        entrypoint: f.input.exec.command.argv[0], arguments: f.input.exec.command.argv.slice(1), user: "1000:1000" } }));
    }
    const end = await running; assert.equal(end.localComplete, true, JSON.stringify(end));
    assert(f.fifoHandles.every(h => h.closes === 1));
  }
});

test("copied data and selected ports cannot be replaced while preparation is pending", async t => {
  let hold; const f = await captureFixture(t, { fileOpen: (_, name) => name === "launcher.profile" ? hold.promise : undefined });
  hold = f.hold(); const owner = f.create(); const opening = owner.open(); await until(() => f.fileHandles.length === 1);
  f.input.launcherProfile.sha256 = "0".repeat(64); f.input.ipcHostRoot.path = "/changed";
  f.input.recordCapture.destinations.header.name = "changed"; f.input.exec.command.argv[0] = "/changed";
  f.ports.gate.check = () => { assert.fail("replacement gate"); };
  f.ports.files.open = () => { assert.fail("replacement opener"); };
  f.ports.fifo.open = () => { assert.fail("replacement FIFO opener"); };
  hold.resolve(); assert.equal((await opening).prepared, true);
  assert.equal((await owner.run()).localComplete, true);
});

test("identity, length, hash and exact launcher argv are independently checked before Docker", async t => {
  const changes = [f => { f.input.launcherProfile.identity = { ...f.input.launcherProfile.identity, ino: "1" }; }, f => { f.input.launcherProfile.bytes--; },
    f => { f.input.launcherProfile.sha256 = "0".repeat(64); }, f => { f.input.exec.command.argv[1] = "/another.mjs"; },
    f => { f.input.recordCapture.destinations.progress.identity = { ...f.input.recordCapture.destinations.progress.identity, ino: "1" }; },
    f => { f.input.recordCapture.destinations.supervisor = { ...f.input.recordCapture.destinations.supervisor, name: "program.out" }; }];
  for (const change of changes) {
    const f = await captureFixture(t); change(f);
    let owner;
    try { owner = f.create(); } catch (error) { assert.equal(error.code, "CAPTURE_ATTEMPT_INPUT"); continue; }
    const end = await owner.open(); assert.equal(end.prepared, false); assert.equal(end.localComplete, false);
    assert.notEqual(end.firstFailure, null); assert.equal(f.daemon.requests.length, 0);
    assert(f.fileHandles.every(h => h.closes === 1));
  }
});

test("a held control transfer hides neither other output progress nor its own unconfirmed E", async t => {
  let hold; const f = await captureFixture(t, { stdout: [Buffer.from([1, 2])], stderr: [Buffer.from([3])],
    async write(h, b, o, n, p, name) { if (name === "launch.control") await hold.promise; return h.write(b, o, n, p); } });
  hold = f.hold(); const owner = f.create(); await owner.open(); const running = owner.run();
  await until(() => owner.snapshot().files.program.channels.stderr.confirmedBytes === 1
    && owner.snapshot().files.control.channels.control.submittedBytes > 0);
  const before = owner.snapshot(); assert.equal(before.control.totalBytes, 0);
  assert.equal(before.files.control.channels.control.confirmedBytes, 0);
  assert(f.fifoHandles.filter(h => h.kind === "sentinel").every(h => h.closes === 0));
  hold.resolve(); const end = await running;
  assert.equal(end.localComplete, true); assert.equal(before.control.totalBytes, 0);
});

test("control short, zero, thrown and unknown writes keep independent confirmed extents", async t => {
  for (const outcome of ["short", "zero", "throw", "unknown"]) {
    let first = true;
    const f = await captureFixture(t, { write(h, b, o, n, p, name) {
      if (name !== "launch.control") return h.write(b, o, n, p);
      if (outcome === "short") return h.write(b, o, Math.min(n, 3), p);
      if (first) { first = false; return h.write(b, o, Math.min(n, 3), p); }
      if (outcome === "zero") return { bytesWritten: 0 };
      if (outcome === "throw") throw Error("finite failure");
      return { bytesWritten: n + 1 };
    } });
    const owner = f.create(); await owner.open(); const end = await owner.run();
    const c = end.files.control.channels.control;
    if (outcome === "short") { assert.equal(end.localComplete, true); assert.equal(c.confirmedBytes, f.control.length); }
    else {
      assert.equal(end.localComplete, false); assert.equal(c.confirmedBytes, 3);
      assert.equal(c.uncertain, outcome !== "zero"); assert.equal(end.control.totalBytes, 0);
      assert.notEqual(end.firstFailure, null); assert.deepEqual(await f.original("launch.control", 3), f.control.subarray(0, 3));
    }
  }
});

test("an overflow keeps the allowed program prefix even if its final write settles after revocation", async t => {
  let hold;
  const capacity = 1048576;
  const f = await captureFixture(t, { stdout: [Buffer.alloc(capacity - 1, 0xa5), Buffer.from([7, 8])],
    async write(h, b, o, n, p, name) { if (name === "program.out" && p === capacity - 1) await hold.promise; return h.write(b, o, n, p); } });
  hold = f.hold(); const owner = f.create(); await owner.open(); const running = owner.run();
  await until(() => owner.snapshot().firstFailure === "FIFO_LIMIT");
  assert.equal(owner.snapshot().files.program.channels.stdout.submittedBytes, capacity);
  hold.resolve(); const end = await running;
  assert.equal(end.localComplete, false); assert.equal(end.firstFailure, "FIFO_LIMIT");
  assert.equal(end.files.program.channels.stdout.confirmedBytes, capacity);
  assert.equal(end.fifo.channels.stdout.readBytes, capacity + 1);
  const original = await f.original("program.out", capacity); assert.equal(original.at(-1), 7); assert.equal(original[0], 0xa5);
});

test("stop while ACK is borrowed blocks requests; its late completion cannot restore work", async t => {
  let hold; const f = await captureFixture(t, { ack: () => hold.promise }); hold = f.hold();
  const owner = f.create(); await owner.open(); const running = owner.run(); await until(() => f.acknowledgements.length === 1);
  owner.stop(); const before = owner.snapshot(); assert.equal(f.daemon.requests.length, 0);
  hold.resolve(); const end = await running;
  assert.equal(end.firstFailure, "CAPTURE_ATTEMPT_STOPPED"); assert.equal(end.localComplete, false);
  assert.equal(f.daemon.requests.length, 0); assert.equal(f.revocations.length, 1); assert.equal(before.revoked, true);
});

test("held native effects outlive the bounded local wait and remain visible in later snapshots", async t => {
  let hold; const f = await captureFixture(t, { fileOpen: () => hold.promise }); hold = f.hold();
  const owner = f.create(); const opening = owner.open(); await until(() => f.fileHandles.length === 1);
  owner.stop(); f.time(3000000100n); const boundary = await opening;
  assert.equal(boundary.finished, true); assert.equal(boundary.cleanupWaitExpired, true); assert.equal(boundary.files.pendingEffects, 1);
  assert.equal(boundary.localComplete, false); hold.resolve(); await until(() => owner.snapshot().files.pendingEffects === 0);
  assert.equal(f.fileHandles[0].closes, 1); assert.equal(boundary.files.pendingEffects, 1);
  assert.equal(owner.snapshot().firstFailure, "CAPTURE_ATTEMPT_STOPPED"); assert.equal(f.fileHandles.length, 1);
});

test("missing E, an invalid clock and a close failure never become complete captures", async t => {
  {
    const f = await captureFixture(t, { control: [Buffer.from("TGL1|")] }); const owner = f.create(); await owner.open();
    const running = owner.run(); await until(() => owner.snapshot().control.totalBytes === 5); f.time(1000000100n);
    const end = await running; assert.equal(end.firstFailure, "CAPTURE_ATTEMPT_DEADLINE");
    assert.equal(end.localComplete, false); assert.equal(end.control.retainedBytes, 5);
  }
  {
    let broken = false; const f = await captureFixture(t, { clock: now => broken ? undefined : now });
    const owner = f.create(); await owner.open(); broken = true; const end = await owner.run();
    assert.equal(end.firstFailure, "CAPTURE_ATTEMPT_CLOCK"); assert.equal(end.localComplete, false);
    assert.equal(end.revoked, true);
  }
  {
    const f = await captureFixture(t, { fileClose: (_, name) => { if (name === "program.out") throw Error("finite close failure"); } });
    const owner = f.create(); await owner.open(); const end = await owner.run();
    assert.equal(end.localComplete, false); assert.equal(end.cleanupError, "CAPTURE_ATTEMPT_CLEANUP");
    assert.equal(end.files.program.channels.stdout.closeError, "CLOSE_FAILED");
  }
});

test("reentrant run/stop callbacks retain one operation and the first cause", async t => {
  let owner; let same;
  const f = await captureFixture(t, { check() { same = owner.run(); owner.stop(); },
    revoke() { owner.stop(); throw Error("finite revoke failure"); } });
  owner = f.create(); await owner.open(); const running = owner.run(); const end = await running;
  assert.equal(same, running); assert.equal(end.firstFailure, "CAPTURE_ATTEMPT_STOPPED");
  assert.equal(end.cleanupError, "CAPTURE_ATTEMPT_GATE"); assert.equal(f.revocations.length, 1); assert.equal(f.daemon.requests.length, 0);
});
