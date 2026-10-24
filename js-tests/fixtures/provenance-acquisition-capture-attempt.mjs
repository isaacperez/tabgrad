import assert from "node:assert/strict";
import { constants } from "node:fs";
import { mkdtemp, realpath, open, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { acquisitionFileIdentity } from "../../scripts/provenance-acquisition-file-io.mjs";
import { acquisitionSha256, ACQUISITION_LIMITS } from "../../scripts/provenance-acquisition-record.mjs";
import { createAcquisitionCaptureAttempt } from "../../scripts/provenance-acquisition-capture-attempt.mjs";
import { fakeExecDaemon, execProfile, inspectBody, jsonReply, upgradeReply } from "./provenance-acquisition-exec.mjs";

export function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
export async function until(predicate) {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await pause(1); }
  assert.fail("finite local observation did not arrive");
}

/** Real regular files/Unix peer; FIFO type, placement and transfers are finite doubles. */
export async function captureFixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tg-capture-")));
  let now = 101n; let input; let argv; let owner;
  const daemon = await fakeExecDaemon(t, root, request => {
    if (options.reply?.(request, { input, argv }) === true) return true;
    if (request.route.endsWith("/start")) { upgradeReply(request.socket, options.daemonBytes ?? Buffer.alloc(0)); return true; }
    if (request.index !== 0) {
      jsonReply(request.socket, inspectBody(request.index === 1, { ProcessConfig: { tty: false,
        entrypoint: argv[0], arguments: argv.slice(1), privileged: false, user: "1000:1000" } })); return true;
    }
    return false;
  });
  const exec = await execProfile(root, daemon.socket, "100", "3000000000"); exec.timing.pollMs = 1;
  async function reserve(name, capacity) {
    const h = await open(join(root, name), "wx+", 0o600); await h.truncate(capacity);
    const identity = acquisitionFileIdentity(await h.stat({ bigint: true })); await h.close(); return { name, identity };
  }
  const programCapture = { root, destinations: { stdout: await reserve("program.out", 1048576), stderr: await reserve("program.err", 262144) } };
  const controlCapture = { root, destination: await reserve("launch.control", 890) };
  const recordCapture = { root, destinations: {} };
  for (const [role, capacity] of Object.entries(ACQUISITION_LIMITS)) recordCapture.destinations[role] = await reserve(`record.${role}`, capacity);
  const launch = { schemaVersion: 1, operationId: exec.operationId,
    launcher: { runtimePath: "/bin/node", runtimeSha256: "a".repeat(64), entryPath: "/work/launcher.mjs",
      entrySha256: "b".repeat(64), uid: "1000", gid: "1000", groups: ["1000"] },
    program: { binarySha256: "c".repeat(64), argv: ["/bin/client", "--finite"], env: ["A=1"], workingDir: "/work" },
    programRecipeSha256: null,
    ipc: { root: { path: "/ipc", identity: { dev: "99", ino: "1" } },
      stdout: { name: "out", identity: { dev: "99", ino: "2" } }, stderr: { name: "err", identity: { dev: "99", ino: "3" } },
      control: { name: "control", identity: { dev: "99", ino: "4" } } },
    timing: { t0MonotonicNs: "100", workUntilNs: "1000000000", closeUntilNs: "2000000000" } };
  launch.programRecipeSha256 = acquisitionSha256(JSON.stringify({ program: launch.program,
    credentials: { uid: "1000", gid: "1000", groups: ["1000"] } }));
  // Independent canonical JSON and literal wire grammar, not production encoders as oracles.
  const bytes = Buffer.from(JSON.stringify(launch)); const profilePath = join(root, "launcher.profile");
  await writeFile(profilePath, bytes);
  const launcherProfile = { hostPath: profilePath, containerPath: "/work/launcher.profile",
    identity: acquisitionFileIdentity(await stat(profilePath, { bigint: true })), sha256: acquisitionSha256(bytes), bytes: bytes.length };
  argv = ["/bin/node", "/work/launcher.mjs", launcherProfile.containerPath, launcherProfile.sha256,
    String(bytes.length), launcherProfile.identity.dev, launcherProfile.identity.ino];
  exec.command.argv = [...argv]; exec.command.env = [];
  input = { exec, launcherProfile, ipcHostRoot: { path: "/host-ipc", identity: { ...launch.ipc.root.identity } }, programCapture, controlCapture, recordCapture };
  const line = (kind, child, attempt, exit, fds) => Buffer.from(`TGL1|${exec.operationId}|${launcherProfile.sha256}|${kind}|1|100|${child}|${attempt}|${exit}|-|${fds}|-|-\n`);
  const control = Buffer.concat([line("R", "-", 0, "-", "oo"), line("S", "101", 1, "-", "oo"),
    line("X", "101", 1, 0, "cc"), line("E", "101", 1, 0, "cc")]);
  const streams = { stdout: [...(options.stdout ?? [])], stderr: [...(options.stderr ?? [])], control: [...(options.control ?? [control])] };
  const roles = { out: "stdout", err: "stderr", control: "control" }; const fifoHandles = []; const reads = [];
  const expectedIpc = structuredClone(input.ipcHostRoot);
  const fileHandles = []; const paths = new WeakMap(); const holds = [];
  const acknowledgements = []; const revocations = []; let checks = 0;
  const gate = {
    context: { operationId: exec.operationId, t0MonotonicNs: "100", deadlineNs: "3000000000", root },
    check() { checks++; options.check?.(); return now; },
    async appendIntent(event) { acknowledgements.push(event); await options.ack?.(event); },
    revoke(code) { revocations.push(code); options.revoke?.(code); },
  };
  const ports = { gate, clock: () => options.clock ? options.clock(now) : now,
    files: {
      async open(path, flags) {
        assert.equal(flags & (constants.O_CREAT | constants.O_APPEND | constants.O_TRUNC), 0);
        if (basename(path).startsWith("record.") || path === profilePath) assert.equal(flags & constants.O_RDWR, 0);
        const h = await open(path, flags); paths.set(h, basename(path)); fileHandles.push({ h, name: basename(path), closes: 0 });
        await options.fileOpen?.(h, basename(path)); return h;
      },
      write(h, b, o, n, p) { return options.write ? options.write(h, b, o, n, p, paths.get(h)) : h.write(b, o, n, p); },
      async close(h) {
        const slot = fileHandles.find(s => s.h === h); assert.equal(++slot.closes, 1);
        await options.fileClose?.(h, slot.name); await h.close();
      },
    },
    fifo: {
      async root(value) { assert.deepEqual(value, expectedIpc); },
      async open(path, kind) {
        const role = roles[basename(path)]; const h = { role, kind, closes: 0,
          async stat() { const id = launch.ipc[role].identity; return { dev: BigInt(id.dev), ino: BigInt(id.ino), isFIFO: () => true }; } };
        fifoHandles.push(h); await options.fifoOpen?.(h); return h;
      },
      async read(h, buffer, length) {
        reads.push({ role: h.role, buffer, length });
        if (options.read) { const result = await options.read(h, buffer, length); if (result !== undefined) return result; }
        const chunk = streams[h.role][0]; if (!chunk) return { bytesRead: 0 };
        const n = Math.min(chunk.length, length); chunk.copy(buffer, 0, 0, n);
        if (n === chunk.length) streams[h.role].shift(); else streams[h.role][0] = chunk.subarray(n);
        return { bytesRead: n };
      },
      async close(h) { assert.equal(++h.closes, 1); await options.fifoClose?.(h); },
    },
  };
  t.after(async () => {
    for (const hold of holds) hold.resolve();
    if (owner) { owner.stop(); now = 3000000100n; await pause(5); await owner.join(); }
    // Test containment only: a deliberately failed close port must not leak the
    // fixture's real descriptor. This does not repair the owner's unknown result.
    await Promise.allSettled(fileHandles.map(s => s.h.close()));
    await rm(root, { recursive: true, force: true });
  });
  return { input, ports, streams, control, launch, daemon, fileHandles, fifoHandles, reads, acknowledgements, revocations,
    get checks() { return checks; }, get owner() { return owner; },
    time(value) { now = value; }, hold() { const d = deferred(); holds.push(d); return d; },
    create() { owner = createAcquisitionCaptureAttempt(input, ports); return owner; },
    async original(name, n) { return (await readFile(join(root, name))).subarray(0, n); },
  };
}
