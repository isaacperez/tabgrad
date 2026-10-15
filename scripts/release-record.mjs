import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReleaseRecordError, RECORD_LIMIT, applyEvent, canonicalBytes, digest, emptyReplay,
  frameEvent, inputEvent, publicReplay, requireRecord, sha256 } from "./release-record-data.mjs";

const oidPattern = /^[0-9a-f]{40}$/;
const refPattern = /^refs\/heads\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

function gitEnvironment(protocol) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  // Credentials, if separately authorized, have one explicit noninteractive path.
  for (const key of ["GIT_ASKPASS", "GIT_SSH_COMMAND"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return { ...environment, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: protocol, GIT_NO_REPLACE_OBJECTS: "1",
    GIT_AUTHOR_NAME: "Tabgrad release recorder", GIT_COMMITTER_NAME: "Tabgrad release recorder",
    GIT_AUTHOR_EMAIL: "release-recorder@invalid", GIT_COMMITTER_EMAIL: "release-recorder@invalid" };
}

class GitStore {
  constructor(directory, config, executable, timeoutMs) {
    this.directory = directory;
    this.config = config;
    this.executable = executable;
    this.timeoutMs = timeoutMs;
    this.environment = gitEnvironment(config.protocol);
  }

  call(arguments_, input) {
    return spawnSync(this.executable, ["-c", "core.hooksPath=/dev/null", "-c", "gc.auto=0",
      "--git-dir", this.directory, ...arguments_], { env: this.environment, input,
      encoding: "utf8", timeout: this.timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  }

  run(arguments_, input) {
    const result = this.call(arguments_, input);
    if (result.error || result.status !== 0) {
      const error = new ReleaseRecordError("GIT_FAILED", { cause: result });
      error.phase = arguments_[0];
      throw error;
    }
    return result.stdout;
  }

  head() {
    const result = this.call(["ls-remote", "--exit-code", "--refs", "--", this.config.location, this.config.ref]);
    if (!result.error && result.status === 2 && result.stdout === "") return null;
    if (result.error || result.status !== 0) {
      throw new ReleaseRecordError("HEAD_UNAVAILABLE", { cause: result });
    }
    const match = /^([0-9a-f]{40})\t([^\n]+)\n$/.exec(result.stdout);
    requireRecord(match && match[2] === this.config.ref, "HEAD_INVALID");
    return match[1];
  }

  fetch(expectedHead) {
    this.run(["fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--",
      this.config.location, `${this.config.ref}:refs/heads/snapshot`]);
    requireRecord(this.run(["rev-parse", "refs/heads/snapshot"]).trim() === expectedHead, "STALE_HEAD");
    requireRecord(this.run(["rev-parse", "--is-shallow-repository"]).trim() === "false", "HISTORY_INCOMPLETE");
  }

  replay(expectedHead) {
    const lines = this.run(["rev-list", "--reverse", "--parents", expectedHead]).trim().split("\n");
    const state = emptyReplay();
    let prior = null;
    for (const line of lines) {
      const [commit, ...parents] = line.split(" ");
      requireRecord(oidPattern.test(commit)
        && (prior === null ? parents.length === 0 && commit === this.config.root
          : parents.length === 1 && parents[0] === prior), "HISTORY_INVALID");
      const tree = this.run(["ls-tree", commit]);
      const match = /^100644 blob ([0-9a-f]{40})\tcheckpoint\.json\n$/.exec(tree);
      requireRecord(match, "TREE_INVALID");
      const size = Number(this.run(["cat-file", "-s", match[1]]).trim());
      requireRecord(Number.isSafeInteger(size) && size <= RECORD_LIMIT, "RECORD_TOO_LARGE");
      const bytes = Buffer.from(this.run(["cat-file", "blob", match[1]]));
      const frame = frameEvent(bytes);
      const checkpoint = applyEvent(state, frame.event);
      requireRecord(canonicalBytes(checkpoint).equals(canonicalBytes(frame.checkpoint)), "CHECKPOINT_INVALID");
      prior = commit;
    }
    requireRecord(state.root && state.root.location === locationIdentity(this.config)
      && state.root.writerPolicy === this.config.writerPolicy, "ENROLLMENT_MISMATCH");
    return state;
  }

  create(frame, parent) {
    const bytes = canonicalBytes(frame);
    requireRecord(bytes.length <= RECORD_LIMIT, "RECORD_TOO_LARGE");
    // All new blob/tree/commit content is fixed or schema-admitted before any -w.
    const blob = this.run(["hash-object", "-w", "--stdin"], bytes).trim();
    requireRecord(oidPattern.test(blob), "OBJECT_INVALID");
    const tree = this.run(["mktree"], `100644 blob ${blob}\tcheckpoint.json\n`).trim();
    requireRecord(oidPattern.test(tree), "OBJECT_INVALID");
    const commit = this.run(["commit-tree", tree, ...(parent === null ? [] : ["-p", parent])],
      "Tabgrad release record\n").trim();
    requireRecord(oidPattern.test(commit), "OBJECT_INVALID");
    return commit;
  }

  write(commit, expectedHead) {
    return this.call(["push", "--porcelain", "--no-verify", "--no-follow-tags", "--recurse-submodules=no",
      `--force-with-lease=${this.config.ref}:${expectedHead ?? ""}`, "--",
      this.config.location, `${commit}:${this.config.ref}`]);
  }
}

export function locationIdentity(config) {
  return sha256(canonicalBytes({ location: config.location, ref: config.ref, protocol: config.protocol }));
}

function validateConfig(config, command) {
  requireRecord(config && Object.keys(config).sort().join(",")
    === "evidence,location,protocol,ref,root,schemaVersion,writerPolicy", "CONFIG_INVALID");
  requireRecord(config.schemaVersion === 1 && typeof config.location === "string"
    && config.location.length > 0 && !config.location.startsWith("-")
    && !/[\r\n\0]/.test(config.location), "CONFIG_INVALID");
  requireRecord(refPattern.test(config.ref) && !["refs/heads/main", "refs/heads/master"].includes(config.ref), "CONFIG_INVALID");
  requireRecord(["file", "https", "ssh"].includes(config.protocol), "CONFIG_INVALID");
  requireRecord(config.protocol !== "file" || isAbsolute(config.location), "CONFIG_INVALID");
  requireRecord(config.protocol !== "https" || config.location.startsWith("https://"), "CONFIG_INVALID");
  requireRecord(config.protocol !== "ssh" || config.location.startsWith("ssh://"), "CONFIG_INVALID");
  requireRecord(command === "enroll" ? config.root === null : oidPattern.test(config.root), "ROOT_REQUIRED");
  digest(config.writerPolicy);
  requireRecord(config.evidence !== null && typeof config.evidence === "object" && !Array.isArray(config.evidence), "CONFIG_INVALID");
  for (const [identity, path] of Object.entries(config.evidence)) {
    digest(identity);
    requireRecord(typeof path === "string" && path.length > 0, "CONFIG_INVALID");
  }
}

async function retainedEvidence(identities, config) {
  for (const identity of identities) {
    const path = config.evidence[identity];
    requireRecord(typeof path === "string", "EVIDENCE_UNAVAILABLE");
    const hash = createHash("sha256");
    try {
      for await (const bytes of createReadStream(path)) hash.update(bytes);
    } catch {
      throw new ReleaseRecordError("EVIDENCE_UNAVAILABLE");
    }
    requireRecord(hash.digest("hex") === identity, "EVIDENCE_CHANGED");
  }
}

function admitTime(state, event, now) {
  requireRecord(Date.parse(event.at) <= now, "EVENT_IN_FUTURE");
  if (event.type === "open" || event.type === "intent") {
    const window = event.type === "open" ? event.window : state.operations.get(event.operation)?.admission.window;
    requireRecord(window && Date.parse(window.start) <= now && now < Date.parse(window.deadline), "WINDOW_EXPIRED");
  }
}

/** Local protocol, not service protection, producer authentication or publication admission. */
export async function releaseRecord({ command, config, expectedHead, inputBytes, inspected,
  gitExecutable = "git", timeoutMs = 30000, clock = Date.now }) {
  requireRecord(["enroll", "read", "append"].includes(command), "COMMAND_INVALID");
  config = structuredClone(config);
  validateConfig(config, command);
  requireRecord(command === "enroll" ? expectedHead === "absent" : oidPattern.test(expectedHead), "EXPECTED_HEAD_REQUIRED");
  let event;
  if (command !== "read") {
    digest(inspected);
    requireRecord(inputBytes instanceof Uint8Array && sha256(inputBytes) === inspected, "INSPECTION_MISMATCH");
    event = inputEvent(Buffer.from(inputBytes));
    requireRecord((event.type === "enroll") === (command === "enroll"), "COMMAND_INVALID");
  }
  const directory = await mkdtemp(join(tmpdir(), "tabgrad-release-record-"));
  let receipt;
  let failure;
  try {
    const store = new GitStore(directory, config, gitExecutable, timeoutMs);
    store.run(["init", "--bare", "--object-format=sha1", "--template=", directory]);
    const prior = command === "enroll" ? null : expectedHead;
    requireRecord(store.head() === prior, "STALE_HEAD");
    let state = emptyReplay();
    if (prior !== null) {
      store.fetch(prior);
      state = store.replay(prior);
      requireRecord(store.head() === prior, "STALE_HEAD");
    }
    if (command === "read") {
      await retainedEvidence(state.evidence, config);
      receipt = { status: "observed", head: prior, root: config.root, ...publicReplay(state) };
    } else {
      admitTime(state, event, clock());
      const checkpoint = applyEvent(state, event);
      requireRecord(state.root.location === locationIdentity(config)
        && state.root.writerPolicy === config.writerPolicy, "ENROLLMENT_MISMATCH");
      await retainedEvidence(state.evidence, config);
      const commit = store.create({ schemaVersion: 1, event, checkpoint }, prior);
      admitTime(state, event, clock());
      const pushed = store.write(commit, prior);
      receipt = { status: "unconfirmed", attemptedCommit: commit, priorHead: prior,
        pushExit: pushed.status, pushSignal: pushed.signal };
      try {
        requireRecord(store.head() === commit, "READBACK_MISMATCH");
        // A fresh store is unnecessary: fetch into a separate local snapshot ref.
        store.run(["update-ref", "-d", "refs/heads/snapshot"]);
        store.fetch(commit);
        const readback = new GitStore(directory, { ...config, root: config.root ?? commit }, gitExecutable, timeoutMs);
        const observed = readback.replay(commit);
        requireRecord(canonicalBytes(publicReplay(state)).equals(canonicalBytes(publicReplay(observed))), "READBACK_MISMATCH");
        requireRecord(store.head() === commit, "READBACK_MISMATCH");
        receipt = { ...receipt, status: "confirmed", head: commit, root: config.root ?? commit, checkpoint };
      } catch (error) {
        throw new ReleaseRecordError("WRITE_UNCONFIRMED", { cause: error });
      }
    }
  } catch (error) {
    failure = error instanceof ReleaseRecordError ? error : new ReleaseRecordError("LOCAL_FAILURE", { cause: error });
  }
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    failure ??= new ReleaseRecordError("CLEANUP_FAILED");
    failure.cleanupFailed = true;
  }
  if (failure) {
    failure.receipt = receipt;
    throw failure;
  }
  return receipt;
}

function options(arguments_) {
  const [command, ...rest] = arguments_;
  const parsed = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    requireRecord(["--config", "--input", "--expected-head", "--inspected"].includes(name)
      && rest[index + 1] !== undefined && !(name in parsed), "COMMAND_INVALID");
    parsed[name] = rest[index + 1];
  }
  requireRecord(command === "inspect" ? Object.keys(parsed).sort().join(",") === "--input,command"
    : ["enroll", "read", "append"].includes(command)
      && Object.keys(parsed).sort().join(",") === (command === "read"
        ? "--config,--expected-head,command" : "--config,--expected-head,--input,--inspected,command"), "COMMAND_INVALID");
  return parsed;
}

async function main() {
  try {
    const parsed = options(process.argv.slice(2));
    const inputBytes = parsed["--input"] ? await readFile(parsed["--input"]) : undefined;
    if (parsed.command === "inspect") {
      inputEvent(inputBytes);
      process.stdout.write(`${JSON.stringify({ schemaVersion: 1, sha256: sha256(inputBytes), byteLength: inputBytes.length })}\n`);
      return;
    }
    const configPath = resolve(parsed["--config"]);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (config?.evidence && typeof config.evidence === "object") {
      config.evidence = Object.fromEntries(Object.entries(config.evidence).map(([identity, path]) =>
        [identity, typeof path === "string" ? resolve(dirname(configPath), path) : path]));
    }
    const receipt = await releaseRecord({ command: parsed.command, config,
      expectedHead: parsed["--expected-head"], inputBytes, inspected: parsed["--inspected"] });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    const safe = error instanceof ReleaseRecordError ? error : new ReleaseRecordError("LOCAL_FAILURE");
    process.stdout.write(`${JSON.stringify({ status: "failed", code: safe.code,
      ...(safe.phase ? { phase: safe.phase } : {}),
      ...(safe.receipt ? { receipt: safe.receipt } : {}), cleanupFailed: safe.cleanupFailed === true })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
