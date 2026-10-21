import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ownedRoot, identityMatches } from "./provenance-acquisition-file-io.mjs";
import { acquisitionFields, requireAcquisition } from "./provenance-acquisition-record.mjs";
import { copyLaunchProfile, encodeLaunchProfile, readLaunchProfile } from "./provenance-acquisition-launch-profile.mjs";
import { encodeLaunchObservation } from "./provenance-acquisition-launch-protocol.mjs";

const roles = ["control", "stdout", "stderr"];
const unqualified = Object.freeze({ payloadOrigin: "unqualified", externalClosure: "unqualified",
  clockAdmission: "unqualified", releaseAdmission: "unqualified" });
// Linux signal numbers are wire data, not this host's platform-specific constants.
const linuxSignals = Object.freeze({ SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5,
  SIGABRT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12,
  SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGSTKFLT: 16, SIGCHLD: 17, SIGCONT: 18,
  SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24,
  SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGPWR: 30, SIGSYS: 31 });

const nativePorts = Object.freeze({
  clock: () => process.hrtime.bigint(),
  credentials: () => ({ pid: String(process.pid), uid: String(process.getuid()), gid: String(process.getgid()),
    groups: process.getgroups().sort((a, b) => a - b).map(String) }),
  root: async root => {
    const actual = await ownedRoot(root.path);
    requireAcquisition(actual.dev === root.identity.dev && actual.ino === root.identity.ino, "FILE_IDENTITY");
  },
  openWriter: path => open(path, constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW),
  spawn,
  schedule: (callback, ms) => setTimeout(callback, ms),
  cancel: timer => clearTimeout(timer),
});

/** Ports are trusted finite-test dependencies, never a second CLI operating mode. */
export function createAcquisitionLauncher(input, ports = {}) {
  requireAcquisition(acquisitionFields(input, ["profile", "sha256", "bytes"]), "LAUNCH_INPUT");
  const admitted = copyLaunchProfile(encodeLaunchProfile(input.profile), { sha256: input.sha256, bytes: input.bytes });
  requireAcquisition(ports && Object.getPrototypeOf(ports) === Object.prototype, "LAUNCH_INPUT");
  const descriptors = Object.getOwnPropertyDescriptors(ports);
  requireAcquisition(Reflect.ownKeys(ports).every(key => Object.hasOwn(nativePorts, key)
    && Object.hasOwn(descriptors[key], "value") && typeof descriptors[key].value === "function"), "LAUNCH_INPUT");
  return new AcquisitionLauncher(admitted, { ...nativePorts, ...ports });
}

class AcquisitionLauncher {
  constructor(admitted, ports) {
    this.admitted = admitted;
    this.profile = admitted.profile;
    this.ports = ports;
    this.handles = Object.fromEntries(roles.map(role => [role, { handle: null, state: "n", close: null }]));
    this.cause = null;
    this.cleanupError = null;
    this.lastAt = null;
    this.pid = null;
    this.childPid = null;
    this.attempted = false;
    this.childSettled = false;
    this.exitCode = null;
    this.signal = null;
    this.observations = { R: null, S: null, X: null, F: null, E: null };
    this.queue = [];
    this.pumpPromise = null;
    this.controlUsable = false;
    this.confirmedControlBytes = 0;
    this.pending = 0;
    this.finished = false;
    this.cleanupWaitExpired = false;
    this.runPromise = null;
    this.workTimer = null;
    this.closeTimer = null;
    this.resolveRun = null;
    this.resolveChild = null;
  }
  snapshot() {
    return Object.freeze({ operationId: this.profile.operationId, profileSha256: this.admitted.sha256,
      programRecipeSha256: this.profile.programRecipeSha256, cause: this.cause, cleanupError: this.cleanupError,
      atNs: this.lastAt, launcherPid: this.pid, childPid: this.childPid, attempted: this.attempted,
      childSettled: this.childSettled, exitCode: this.exitCode, signal: this.signal,
      fds: this.handles.stdout.state + this.handles.stderr.state, controlFd: this.handles.control.state,
      pendingEffects: this.pending, confirmedControlBytes: this.confirmedControlBytes,
      observations: Object.freeze({ ...this.observations }), finished: this.finished,
      cleanupWaitExpired: this.cleanupWaitExpired, exitStatus: this.success() ? 0 : 1, ...unqualified });
  }
  success() {
    return this.finished && !this.cause && !this.cleanupError && !this.cleanupWaitExpired
      && this.childSettled && this.exitCode === 0 && this.observations.E !== null
      && roles.every(role => this.handles[role].state === "c");
  }
  fail(code, cleanup = null) {
    if (this.cause === null) {
      this.cause = code;
      if (cleanup !== null) this.cleanupError ??= cleanup;
      this.emit("F");
    } else if (cleanup !== null) this.cleanupError ??= cleanup;
  }
  sample() {
    try {
      const now = this.ports.clock();
      const elapsed = now - BigInt(this.profile.timing.t0MonotonicNs);
      requireAcquisition(typeof now === "bigint" && elapsed >= 0n && elapsed <= 0xffffffffffffffffn
        && (this.lastAt === null || elapsed >= BigInt(this.lastAt)), "LAUNCH_CLOCK");
      this.lastAt = elapsed.toString();
      return elapsed;
    } catch { this.fail("clock", "clock"); return null; }
  }
  permitted(work) {
    const at = this.sample();
    if (at === null) return false;
    const cutoff = BigInt(this.profile.timing[work ? "workUntilNs" : "closeUntilNs"]);
    if (at >= cutoff) {
      if (!work) this.cleanupWaitExpired = true;
      this.fail("deadline", work ? null : "deadline");
      return false;
    }
    return !this.cleanupWaitExpired && (!work || this.cause === null);
  }
  stop() {
    if (!this.finished) { this.fail("stopped"); void this.closeOutputs(); }
    return this.snapshot();
  }
  run() {
    if (this.runPromise) return this.runPromise;
    this.runPromise = new Promise(resolve => { this.resolveRun = resolve; });
    void this.execute();
    return this.runPromise;
  }
  join() { return this.runPromise ?? Promise.resolve(this.snapshot()); }
  completeWait() {
    if (!this.finished) {
      this.finished = true;
      this.ports.cancel(this.workTimer);
      this.ports.cancel(this.closeTimer);
      this.resolveRun(this.snapshot());
    }
  }
  expire() {
    if (this.finished) return;
    this.sample();
    this.cleanupWaitExpired = true;
    this.fail("deadline", "deadline");
    this.completeWait();
  }
  armTimers() {
    const at = BigInt(this.lastAt);
    const work = BigInt(this.profile.timing.workUntilNs) - at;
    const close = BigInt(this.profile.timing.closeUntilNs) - at;
    // Node timers clamp overflowing delays. Reject rather than silently shorten/renew a horizon.
    requireAcquisition(work > 0n && close > 0n && close <= 2147483647n * 1000000n, "LAUNCH_CLOCK");
    this.workTimer = this.ports.schedule(() => { this.sample(); this.fail("deadline"); void this.closeOutputs(); }, Number((work + 999999n) / 1000000n));
    this.closeTimer = this.ports.schedule(() => this.expire(), Number((close + 999999n) / 1000000n));
  }
  async effect(operation) {
    this.pending++;
    try { return await operation(); }
    finally { this.pending--; this.sample(); }
  }
  emit(kind) {
    if (!this.controlUsable || this.cleanupWaitExpired || this.observations[kind] || this.observations.E) return;
    const record = Object.freeze({ operationId: this.profile.operationId, profileSha256: this.admitted.sha256,
      kind, atNs: this.lastAt, launcherPid: this.pid, childPid: this.childPid, attempted: this.attempted,
      exitCode: this.exitCode, signal: this.signal, fds: this.handles.stdout.state + this.handles.stderr.state,
      cause: this.cause, cleanupError: this.cleanupError });
    this.observations[kind] = record;
    this.queue.push(record);
    if (!this.pumpPromise) this.pumpPromise = Promise.resolve().then(() => this.pump());
  }
  async pump() {
    // Exactly one writer and one borrowed record buffer. Queue contains at most five fixed observations.
    while (this.queue.length > 0 && this.controlUsable) {
      const record = this.queue.shift();
      let bytes;
      try {
        bytes = encodeLaunchObservation(record);
        let offset = 0;
        while (offset < bytes.length) {
          if (!this.permitted(false)) { this.controlUsable = false; break; }
          const result = await this.effect(() => this.handles.control.handle.write(bytes, offset, bytes.length - offset, null));
          requireAcquisition(Number.isInteger(result.bytesWritten) && result.bytesWritten > 0
            && result.bytesWritten <= bytes.length - offset, "LAUNCH_CONTROL_WRITE");
          this.confirmedControlBytes += result.bytesWritten;
          offset += result.bytesWritten;
          if (!this.permitted(false)) this.controlUsable = false;
        }
      } catch {
        this.controlUsable = false;
        this.fail("control");
      }
    }
    this.queue.length = 0;
  }
  async drainControl() {
    while (this.pumpPromise) {
      const active = this.pumpPromise;
      await active;
      if (this.pumpPromise === active) this.pumpPromise = null;
      if (this.queue.length && this.controlUsable && !this.pumpPromise) this.pumpPromise = Promise.resolve().then(() => this.pump());
    }
  }
  close(role) {
    const slot = this.handles[role];
    if (!slot.handle || slot.close) return slot.close ?? Promise.resolve();
    slot.state = "p";
    slot.close = this.effect(() => slot.handle.close()).then(() => { slot.state = "c"; }, () => {
      slot.state = "u"; this.fail("close", "close");
    });
    return slot.close;
  }
  closeOutputs() { return Promise.all([this.close("stdout"), this.close("stderr")]); }
  async openEndpoint(role) {
    if (!this.permitted(true)) return;
    const slot = this.handles[role];
    try {
      const handle = await this.effect(() => this.ports.openWriter(join(this.profile.ipc.root.path, this.profile.ipc[role].name)));
      slot.handle = handle;
      slot.state = "o";
      if (!this.permitted(true)) return;
      try {
        const stat = await this.effect(() => handle.stat({ bigint: true }));
        requireAcquisition(stat.isFIFO(), "LAUNCH_IDENTITY");
        identityMatches(stat, this.profile.ipc[role].identity);
        requireAcquisition(Number.isInteger(handle.fd) && handle.fd >= 0, "LAUNCH_IDENTITY");
      } catch { this.fail("identity"); return; }
      if (role === "control") { this.controlUsable = true; if (this.cause) this.emit("F"); }
    } catch { this.fail("open"); }
  }
  onSpawn() {
    this.sample();
    if (!this.child || !Number.isInteger(this.child.pid) || this.child.pid <= 0 || this.child.pid > 0xffffffff) {
      this.fail("protocol");
    } else { this.childPid = String(this.child.pid); this.emit("S"); }
    void this.closeOutputs();
  }
  onError() { this.sample(); this.fail("spawn"); void this.closeOutputs(); }
  onClose(code, signal) {
    this.sample();
    const validCode = code === null || (Number.isInteger(code) && code >= 0 && code <= 255);
    const validSignal = signal === null || (typeof signal === "string" && Object.hasOwn(linuxSignals, signal));
    if (!validCode || !validSignal || (code !== null && signal !== null)
      || (code === null && signal === null && !this.cause)) this.fail("protocol");
    else {
      this.exitCode = code;
      this.signal = signal === null ? null : linuxSignals[signal];
      if (code !== 0 && !this.cause) this.fail("child");
    }
    if (!this.observations.S && !this.cause) this.fail("protocol");
    this.childSettled = true;
    this.child.removeListener("spawn", this.spawnListener);
    this.child.removeListener("error", this.errorListener);
    this.child = null;
    this.emit("X");
    void this.closeOutputs();
    this.resolveChild();
  }
  async launch() {
    if (!this.permitted(true) || !this.controlUsable) return;
    const program = this.profile.program;
    const env = Object.create(null);
    for (const item of program.env) { const i = item.indexOf("="); env[item.slice(0, i)] = item.slice(i + 1); }
    const settled = new Promise(resolve => { this.resolveChild = resolve; });
    this.attempted = true;
    try {
      this.child = this.ports.spawn(program.argv[0], program.argv.slice(1), { cwd: program.workingDir, env,
        shell: false, stdio: ["ignore", this.handles.stdout.handle.fd, this.handles.stderr.handle.fd] });
    } catch {
      this.sample(); this.fail("spawn"); this.childSettled = true; this.emit("X");
      await this.closeOutputs();
      return;
    }
    this.spawnListener = this.onSpawn.bind(this);
    this.errorListener = this.onError.bind(this);
    this.child.once("spawn", this.spawnListener);
    this.child.once("error", this.errorListener);
    this.child.once("close", this.onClose.bind(this));
    await settled;
    this.permitted(false);
  }
  async execute() {
    try {
      if (this.cause || !this.permitted(true)) return;
      this.armTimers();
      const credentials = this.ports.credentials();
      const expected = this.profile.launcher;
      requireAcquisition(acquisitionFields(credentials, ["pid", "uid", "gid", "groups"])
        && /^[1-9][0-9]{0,9}$/.test(credentials.pid) && BigInt(credentials.pid) <= 0xffffffffn
        && credentials.uid === expected.uid && credentials.gid === expected.gid
        && Array.isArray(credentials.groups) && JSON.stringify(credentials.groups) === JSON.stringify(expected.groups), "LAUNCH_INPUT");
      this.pid = credentials.pid;
      try { await this.effect(() => this.ports.root(this.profile.ipc.root)); }
      catch { this.fail("identity"); return; }
      for (const role of roles) await this.openEndpoint(role);
      if (!this.permitted(true) || !roles.every(role => this.handles[role].state === "o")) return;
      this.emit("R");
      await this.drainControl();
      await this.launch();
    } catch { this.fail("input"); }
    finally {
      await this.closeOutputs();
      await this.drainControl();
      if (this.permitted(false) && (!this.attempted || this.childSettled)) { this.emit("E"); await this.drainControl(); }
      this.controlUsable = false;
      await this.close("control");
      this.permitted(false);
      this.completeWait();
    }
  }
}

/** Fixed entry: only profile path/hash/P/dev/ino, never a test mode or free shell. */
export async function acquisitionLauncherMain(args = process.argv.slice(2)) {
  let launcher;
  try {
    requireAcquisition(args.length === 5 && /^(0|[1-9][0-9]*)$/.test(args[2]), "LAUNCH_INPUT");
    const profile = await readLaunchProfile(args[0], { sha256: args[1], bytes: Number(args[2]),
      identity: { dev: args[3], ino: args[4] } });
    requireAcquisition(process.platform === "linux" && process.execPath === profile.profile.launcher.runtimePath
      && resolveEntry() === profile.profile.launcher.entryPath, "LAUNCH_INPUT");
    launcher = createAcquisitionLauncher(profile);
    process.once("SIGTERM", launcher.stop.bind(launcher));
    const result = await launcher.run();
    process.exitCode = result.exitStatus;
    if (result.exitStatus !== 0) process.stderr.write("LAUNCH_FAILED\n");
  } catch { process.stderr.write("LAUNCH_FAILED\n"); process.exitCode = 1; }
}

function resolveEntry() { return process.argv[1]; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void acquisitionLauncherMain();
}
