import { spawn as nativeSpawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { acquisitionSha256, AcquisitionRecordError, requireAcquisition } from "./provenance-acquisition-record.mjs";
import { createAcquisitionPayload, createAcquisitionPayloadStore } from "./provenance-acquisition-payload.mjs";
import { freezeHostData } from "./provenance-acquisition-host-profile.mjs";
import { LAB_ERRORS } from "./provenance-acquisition-lab-profile.mjs";

const roles = ["stdout", "stderr"];
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

/** Strong ownership of open/pending/rejected handles only; successful closes leave no history. */
export class LabHandles {
  #records = new WeakMap(); #active = new Set(); #closed = 0;
  push(handle) {
    requireAcquisition(handle && typeof handle.close === "function" && !this.#records.has(handle), "LAB_IDENTITY");
    this.#records.set(handle, { promise: null, state: "open" }); this.#active.add(handle);
  }
  has(handle) { return this.#records.has(handle); }
  close(handle) {
    const record = this.#records.get(handle); requireAcquisition(record, "LAB_IDENTITY");
    if (!record.promise) {
      record.state = "pending";
      record.promise = Promise.resolve().then(() => handle.close()).then(() => {
        record.state = "closed"; this.#active.delete(handle); this.#closed++;
      }, error => { record.state = "unknown"; throw error; });
    }
    return record.promise;
  }
  async closeAll() { await Promise.allSettled([...this.#active].map(h => this.close(h))); return this.snapshot(); }
  snapshot() {
    const states = [...this.#active].map(h => this.#records.get(h).state);
    return Object.freeze({ retained: states.length, closed: this.#closed,
      pending: states.filter(s => s === "pending").length, unknown: states.filter(s => s === "unknown").length });
  }
}
export function labFailureCode(error, fallback = "LAB_PROTOCOL") {
  if (error instanceof AcquisitionRecordError && LAB_ERRORS.includes(error.code)) return error.code;
  const map = { CAPTURE_CLOCK: "LAB_CLOCK", CAPTURE_DEADLINE: "LAB_DEADLINE", CAPTURE_STOPPED: "LAB_STOPPED",
    CAPTURE_LIMIT: "LAB_LIMIT", CLOSE_FAILED: "LAB_CLEANUP", WRITE_FAILED: "LAB_WRITE",
    WRITE_NO_PROGRESS: "LAB_WRITE", WRITE_EXTENT_UNKNOWN: "LAB_WRITE", HOST_IDENTITY: "LAB_IDENTITY",
    HOST_FILESYSTEM: "LAB_IDENTITY", FILE_IDENTITY: "LAB_IDENTITY", FILE_ROOT: "LAB_IDENTITY",
    HOST_READ: "LAB_READ", PLACEMENT_IDENTITY: "LAB_IDENTITY", PLACEMENT_LIMIT: "LAB_LIMIT" };
  return error instanceof AcquisitionRecordError && Object.hasOwn(map, error.code) ? map[error.code] : fallback;
}

/** Finite command output, retained only until its consumer selects original evidence. */
export class LabMemorySink {
  #limit; #chunks = { stdout: [], stderr: [] }; #counts = { stdout: 0, stderr: 0 };
  #ended = { stdout: false, stderr: false }; #closed = false;
  constructor(limit) { this.#limit = limit; }
  remaining(role) { return this.#limit - this.#counts[role]; }
  async write(role, bytes) {
    requireAcquisition(!this.#closed && !this.#ended[role] && bytes.length <= this.remaining(role), "LAB_LIMIT");
    if (bytes.length) { this.#chunks[role].push(Buffer.from(bytes)); this.#counts[role] += bytes.length; }
  }
  finish(role) { this.#ended[role] = true; }
  async close() { this.#closed = true; }
  async collect(role) { return Buffer.concat(this.#chunks[role], this.#counts[role]); }
  snapshot() { return freezeHostData({ ioClosed: this.#closed ? "closed" : "open",
    channels: Object.fromEntries(roles.map(role => [role, { confirmedBytes: this.#counts[role], eof: this.#ended[role] }])) }); }
}

class LabFileSink {
  #writer; #paths; #identities; #limit; #handles;
  constructor(writer, paths, identities, limit, handles) {
    this.#writer = writer; this.#paths = paths; this.#identities = identities; this.#limit = limit; this.#handles = handles;
  }
  remaining(role) { return this.#limit - this.#writer.snapshot().channels[role].submittedBytes; }
  write(role, bytes) { return this.#writer.write(role, bytes); }
  finish(role) { this.#writer.finish(role); }
  close() { return this.#writer.close(); }
  snapshot() { return Object.freeze({ ...this.#writer.snapshot(), files: Object.freeze(Object.fromEntries(roles.map(role =>
    [role, Object.freeze({ identity: this.#identities[role], capacity: this.#limit })]))) }); }
  async collect(role) {
    const count = this.#writer.snapshot().channels[role].confirmedBytes;
    const h = await open(this.#paths[role], constants.O_RDONLY | constants.O_NOFOLLOW); this.#handles.push(h);
    let bytes; let failure;
    try {
      const s = await h.stat({ bigint: true });
      requireAcquisition(s.isFile() && s.nlink === 1n && `${s.dev}:${s.ino}` === this.#identities[role]
        && s.size === BigInt(this.#limit), "LAB_IDENTITY");
      bytes = Buffer.alloc(count); let offset = 0;
      while (offset < count) {
        const r = await h.read(bytes, offset, count - offset, offset);
        requireAcquisition(Number.isInteger(r.bytesRead) && r.bytesRead > 0 && r.bytesRead <= count - offset, "LAB_READ");
        offset += r.bytesRead;
      }
    } catch (error) { failure = error; }
    try { await this.#handles.close(h); } catch { failure ??= new AcquisitionRecordError("LAB_CLEANUP"); }
    if (failure) throw failure;
    return bytes;
  }
}

/** New exclusive logical reservations on already admitted bounded storage; no physical allocation claim. */
export async function createLabFileSink(prefix, limit, context, clock, check, handles) {
  const opened = []; const parts = {}; const paths = {}; const identities = {};
  try {
    for (const role of roles) {
      check(); paths[role] = `${prefix}.${role}`;
      const h = await open(paths[role], constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      handles.push(h); opened.push(h); check(); await h.truncate(limit); check();
      const s = await h.stat({ bigint: true }); check();
      requireAcquisition(s.isFile() && s.nlink === 1n && s.size === BigInt(limit), "LAB_IDENTITY");
      identities[role] = `${s.dev}:${s.ino}`; parts[role] = { handle: h, identity: identities[role] };
    }
    requireAcquisition(identities.stdout !== identities.stderr, "LAB_IDENTITY");
    const timing = { origin: BigInt(context.t0MonotonicNs), deadline: BigInt(context.deadlineNs) };
    const store = createAcquisitionPayloadStore(parts, timing, clock(), clock,
      { write: (h, ...args) => h.write(...args), close: h => handles.close(h) }, { stdout: limit, stderr: limit });
    return new LabFileSink(createAcquisitionPayload(store), paths, identities, limit, handles);
  } catch (error) {
    const results = await Promise.allSettled(opened.map(h => handles.close(h)));
    const failure = new AcquisitionRecordError(labFailureCode(error, "LAB_WRITE"));
    failure.cleanupError = results.some(r => r.status === "rejected") ? "LAB_CLEANUP" : null;
    // The caller's handle owner retains pending/rejected closes without retry.
    throw failure;
  }
}

/** One direct child and two independently backpressured streams, never a unit-retirement proof. */
class LabCommand {
  #input; #sink; #spawn; #check; #child = null; #stopped = false; #killSent = false; #first = null;
  #begun = false; #exited = false; #closed = false; #exitCode = null; #signal = null;
  #streamEnded = { stdout: false, stderr: false }; #cleanup = null; #childClose = deferred(); #result = deferred();
  #inputState = "not_requested";
  constructor(input, sink, check, spawn) {
    this.#input = { file: input.file, args: [...input.args], env: { ...input.env },
      stdin: input.stdin === undefined ? null : Buffer.from(input.stdin) };
    this.#sink = sink; this.#check = check; this.#spawn = spawn;
  }
  #fail(error) { this.#first ??= labFailureCode(error); this.stop(); }
  #kill() {
    if (!this.#child || this.#killSent || this.#closed) return;
    this.#killSent = true;
    try { this.#child.kill("SIGKILL"); } catch { this.#cleanup ??= "LAB_CLEANUP"; }
  }
  stop() { this.#stopped = true; this.#kill(); }
  get result() { return this.#result.promise; }
  #gate() {
    requireAcquisition(!this.#stopped, this.#first ?? "LAB_STOPPED"); this.#check();
    requireAcquisition(!this.#stopped, this.#first ?? "LAB_STOPPED");
  }
  async #pump(role, stream) {
    try {
      stream.on("end", () => { this.#streamEnded[role] = true; });
      for await (const data of stream) {
        this.#gate(); requireAcquisition(Buffer.isBuffer(data), "LAB_READ");
        const allowed = Math.min(data.length, this.#sink.remaining(role));
        if (allowed) await this.#sink.write(role, data.subarray(0, allowed));
        this.#gate();
        requireAcquisition(allowed === data.length, "LAB_LIMIT");
        if (!data.length) await new Promise(resolve => setImmediate(resolve));
      }
      requireAcquisition(this.#streamEnded[role], "LAB_READ"); this.#gate(); this.#sink.finish(role);
    } catch (error) { this.#fail(error); }
  }
  #sendInput(stream) {
    if (this.#input.stdin === null) return Promise.resolve();
    this.#inputState = "pending";
    return new Promise(resolve => {
      let settled = false;
      const fail = () => {
        if (settled) return; settled = true; this.#inputState = "unknown";
        this.#fail(new AcquisitionRecordError("LAB_WRITE")); resolve();
      };
      stream.on("error", fail); stream.once("close", () => { if (this.#inputState !== "acknowledged") fail(); });
      try {
        this.#gate(); stream.end(this.#input.stdin, () => {
          if (settled) return; settled = true; this.#inputState = "acknowledged"; resolve();
        });
      } catch { fail(); }
    });
  }
  begin() {
    if (this.#begun) return this;
    this.#begun = true;
    void Promise.resolve().then(async () => {
      try {
        this.#gate();
        const child = this.#spawn(this.#input.file, [...this.#input.args],
          { env: { ...this.#input.env }, stdio: [this.#input.stdin === null ? "ignore" : "pipe", "pipe", "pipe"], shell: false });
        this.#child = child;
        child.on("error", error => this.#fail(error));
        child.once("exit", (code, signal) => { this.#exited = true; this.#exitCode = code; this.#signal = signal; });
        child.once("close", () => { this.#closed = true; this.#childClose.resolve(); });
        // Install resource ownership/listeners before a post-spawn cancellation check.
        const pumps = [...roles.map(role => this.#pump(role, child[role])), this.#sendInput(child.stdin)];
        try { this.#gate(); } catch (error) { this.#fail(error); }
        await Promise.allSettled([...pumps, this.#childClose.promise]);
      } catch (error) { this.#fail(error); }
      try { await this.#sink.close(); } catch { this.#cleanup ??= "LAB_CLEANUP"; }
      this.#result.resolve(this.snapshot());
    });
    return this;
  }
  collect(role) { return this.#sink.collect(role); }
  snapshot() {
    const capture = this.#sink.snapshot();
    return freezeHostData({ begun: this.#begun, pid: this.#child?.pid ?? null, stopped: this.#stopped,
      killRequested: this.#killSent, exited: this.#exited, closed: this.#closed, exitCode: this.#exitCode,
      signal: this.#signal, streamEnded: { ...this.#streamEnded }, firstFailure: this.#first,
      inputState: this.#inputState,
      cleanupError: this.#cleanup ?? (capture.ioClosed === "unknown" ? "LAB_CLEANUP" : null), capture });
  }
}

/** Internal prepared arguments and owned sink only; no executable can be selected through a wire message. */
export function startLabCommand(input, sink, check, spawn = nativeSpawn) {
  return new LabCommand(input, sink, check, spawn).begin();
}

export async function collectLabCommand(command) {
  const result = await command.result;
  requireAcquisition(result.closed && result.exited && !result.firstFailure && !result.cleanupError, result.firstFailure ?? "LAB_PROTOCOL");
  const stdout = await command.collect("stdout"); const stderr = await command.collect("stderr");
  return { result, stdout, stderr, hashes: { stdout: acquisitionSha256(stdout), stderr: acquisitionSha256(stderr) } };
}
