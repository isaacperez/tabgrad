import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { applyEvent, canonicalBytes, emptyReplay, inputEvent, planBytes, sha256 } from "../../../scripts/release-record-data.mjs";
import { locationIdentity, releaseRecord } from "../../../scripts/release-record.mjs";

const at = "2026-01-01T00:00:00.000Z";
const deadline = "2026-01-01T01:00:00.000Z";
const now = Date.parse(at) + 1;
const identity = name => sha256(Buffer.from(`public synthetic ${name}`));
const operation = identity("operation");
const effect = identity("effect");
const call = identity("call");

function git(location, args, input) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Synthetic fixture",
    "-c", "user.email=fixture@invalid", "-C", location, ...args], {
    encoding: "utf8", input, env: { ...Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !key.startsWith("GIT_"))), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "0", GIT_ALLOW_PROTOCOL: "file", GIT_NO_REPLACE_OBJECTS: "1" },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "tabgrad-record-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const location = join(directory, "destination.git");
  await mkdir(location);
  git(location, ["init", "--bare", "--object-format=sha1", "--template="]);
  const evidence = {};
  for (const name of ["policy", "prior", "candidate", "authority", "owner", "effect", "effect2", "evidence"]) {
    const path = join(directory, `${name}.txt`);
    await writeFile(path, `public synthetic ${name}`);
    evidence[identity(name)] = path;
  }
  const config = { schemaVersion: 1, location, ref: "refs/heads/release-control-fixture", protocol: "file",
    root: null, writerPolicy: identity("policy"), evidence };
  const locationBytes = canonicalBytes({ location, ref: config.ref, protocol: config.protocol });
  const locationPath = join(directory, "private-location.json");
  await writeFile(locationPath, locationBytes);
  evidence[sha256(locationBytes)] = locationPath;
  const root = { type: "enroll", at, location: locationIdentity(config), writerPolicy: config.writerPolicy,
    priorEffects: identity("prior") };
  const opened = { type: "open", at, operation, plan: identity("plan"), candidate: identity("candidate"),
    authority: identity("authority"), owner: identity("owner"), window: { start: at, deadline }, effects: [effect] };
  opened.plan = sha256(planBytes(opened));
  const planPath = join(directory, "plan.json");
  await writeFile(planPath, planBytes(opened));
  evidence[opened.plan] = planPath;
  return { directory, config, root, opened };
}

function changedPlan(original, changes) {
  const event = { ...original, ...changes };
  event.plan = sha256(planBytes(event));
  return event;
}

function invoke(f, command, event, expectedHead, extra = {}) {
  const inputBytes = event === undefined ? undefined : canonicalBytes({ schemaVersion: 1, event });
  const { now: observedTime = now, ...options } = extra;
  return releaseRecord({ command, config: f.config, expectedHead, inputBytes,
    inspected: inputBytes && sha256(inputBytes), clock: () => observedTime, ...options });
}

async function enrolled(f) {
  const result = await invoke(f, "enroll", f.root, "absent");
  f.config.root = result.root;
  assert.equal(result.status, "confirmed");
  return result.head;
}

function intent(overrides = {}) {
  return { type: "intent", at, operation, call, effect, ...overrides };
}

function observation(overrides = {}) {
  return { type: "observe", at, operation, call, outcome: "verified-effect", basis: "call",
    evidence: identity("evidence"), ...overrides };
}

function close(overrides = {}) {
  return { type: "close", at, operation, result: "completed", evidence: identity("evidence"), ...overrides };
}

function replay(root, events) {
  const state = emptyReplay();
  for (const event of [root, ...events]) applyEvent(state, event);
  return state;
}

test("Git enrollment, exact root/head readback, intents, partial progress and completion", async t => {
  const f = await fixture(t);
  let head = await enrolled(f);
  const events = [f.opened, intent(), observation(), close()];
  for (const event of events) {
    const result = await invoke(f, "append", event, head);
    assert.equal(result.status, "confirmed");
    const parents = git(f.config.location, ["rev-list", "--parents", "-n", "1", result.head]).split(" ");
    assert.deepEqual(parents, [result.head, head]);
    const frame = JSON.parse(git(f.config.location, ["show", `${result.head}:checkpoint.json`]));
    assert.deepEqual(frame.event, event);
    assert.deepEqual(frame.checkpoint, result.checkpoint);
    head = result.head;
  }
  const observed = await invoke(f, "read", undefined, head);
  assert.equal(observed.status, "observed");
  assert.equal(observed.checkpoint.sequence, 5);
  assert.equal(observed.checkpoint.activeOperation, null);
  assert.equal(observed.checkpoint.unresolvedCalls, 0);
  assert.deepEqual(observed.operations[0].closure, close());
  assert.equal(git(f.config.location, ["for-each-ref", "--format=%(refname)"]), f.config.ref);
  assert.equal(git(f.config.location, ["show", "--format=%an <%ae>%n%cn <%ce>%n%B", "--no-patch", head]),
    "Tabgrad release recorder <release-recorder@invalid>\nTabgrad release recorder <release-recorder@invalid>\nTabgrad release record");
});

for (const [name, mutate] of [
  ["extra private field", value => { value.event.privateText = "synthetic unpublished canary"; }],
  ["unsupported version", value => { value.schemaVersion = 2; }],
  ["unsupported event", value => { value.event.type = "execute"; }],
  ["non-digest owner", value => { value.event.owner = "synthetic-name"; }],
  ["empty effects", value => { value.event.effects = []; }],
  ["duplicate effects", value => { value.event.effects = [effect, effect]; }],
  ["invalid calendar", value => { value.event.at = "2026-02-30T00:00:00.000Z"; }],
  ["window order", value => { value.event.window.deadline = at; }],
]) test(`closed input schema rejects ${name}`, () => {
  const value = { schemaVersion: 1, event: { type: "open", at, operation, plan: identity("plan"),
    candidate: identity("candidate"), authority: identity("authority"), owner: identity("owner"),
    window: { start: at, deadline }, effects: [effect] } };
  mutate(value);
  assert.throws(() => inputEvent(canonicalBytes(value)));
});

test("canonical encoding rejects duplicate keys, noncanonical spacing, invalid UTF-8 and oversized frames", () => {
  for (const bytes of [Buffer.from('{"schemaVersion":1,"schemaVersion":1}\n'), Buffer.from('{}'),
    Buffer.from([0xff]), Buffer.alloc(65537)]) assert.throws(() => inputEvent(bytes));
});

for (const [name, event, expected] of [
  ["unknown call", observation(), "CALL_NOT_FOUND"],
  ["wrong operation", intent({ operation: identity("other") }), "OPERATION_NOT_ACTIVE"],
  ["unadmitted effect", intent({ effect: identity("other") }), "EFFECT_NOT_ADMITTED"],
  ["expired intent", intent({ at: deadline }), "WINDOW_EXPIRED"],
  ["unfinished completion", close(), "EFFECTS_INCOMPLETE"],
]) test(`transition rejects ${name}`, async t => {
  const f = await fixture(t);
  assert.throws(() => applyEvent(replay(f.root, [f.opened]), event), { code: expected });
});

test("a missing call outcome, cancellation and destination presence remain unresolved", async t => {
  const f = await fixture(t);
  const state = replay(f.root, [f.opened, intent()]);
  for (const event of [intent({ call: identity("retry") }), close({ result: "abandoned" }),
    { ...f.opened, operation: identity("next") }]) assert.throws(() => applyEvent(state, event));
  applyEvent(state, observation({ outcome: "unknown", basis: "destination" }));
  assert.equal(state.unresolved.size, 1);
  assert.throws(() => applyEvent(state, observation({ basis: "destination" })), { code: "DESTINATION_IS_NOT_OUTCOME" });
  applyEvent(state, observation({ outcome: "verified-no-effect", basis: "reconciliation" }));
  applyEvent(state, intent({ call: identity("retry") }));
  assert.equal(state.unresolved.size, 1);
  assert.equal(state.calls.size, 2);
});

test("partial verified effects survive other unresolved calls and cannot be repeated", async t => {
  const f = await fixture(t);
  f.opened.effects.push(identity("effect2"));
  f.opened.plan = sha256(planBytes(f.opened));
  const state = replay(f.root, [f.opened, intent(), observation()]);
  assert.throws(() => applyEvent(state, intent({ call: identity("duplicate-effect") })), { code: "EFFECT_COMPLETED" });
  applyEvent(state, intent({ call: identity("second"), effect: identity("effect2") }));
  assert.throws(() => applyEvent(state, close()), { code: "CALL_UNSETTLED" });
  assert.equal(state.calls.get(call).outcome, "verified-effect");
  applyEvent(state, observation({ call: identity("second"), outcome: "verified-no-effect" }));
  assert.throws(() => applyEvent(state, close()), { code: "EFFECTS_INCOMPLETE" });
  applyEvent(state, close({ result: "abandoned" }));
  assert.equal(state.operations.get(operation).closure.result, "abandoned");
});

test("contrary observations require explicit reconciliation; late observations remain effective", async t => {
  const f = await fixture(t);
  const state = replay(f.root, [f.opened, intent(), observation(), close()]);
  applyEvent(state, observation({ outcome: "verified-no-effect" }));
  assert.equal(state.calls.get(call).outcome, "conflict");
  assert.equal(state.conflicts.size, 1);
  assert.throws(() => applyEvent(state, changedPlan(f.opened, { operation: identity("next") })), { code: "OPERATION_UNSETTLED" });
  applyEvent(state, observation());
  assert.equal(state.calls.get(call).outcome, "conflict");
  applyEvent(state, observation({ basis: "reconciliation" }));
  applyEvent(state, changedPlan(f.opened, { operation: identity("next") }));
  applyEvent(state, observation({ outcome: "unknown" }));
  assert.throws(() => applyEvent(state, intent({ operation: identity("next"), call: identity("next-call") })), { code: "CALL_UNSETTLED" });
  assert.equal(state.operations.get(operation).closure.result, "completed");
  assert.equal(state.unresolved.size, 1);
});

test("older retry observations do not erase a separately verified completed effect", async t => {
  const f = await fixture(t);
  const state = replay(f.root, [f.opened, intent(), observation({ outcome: "verified-no-effect" }),
    intent({ call: identity("retry") }), observation({ call: identity("retry") }),
    observation({ outcome: "verified-no-effect" })]);
  assert.throws(() => applyEvent(state, intent({ call: identity("third") })), { code: "EFFECT_COMPLETED" });
  applyEvent(state, close());
});

test("operation/call identities cannot be reused, even after closure", async t => {
  const f = await fixture(t);
  const state = replay(f.root, [f.opened, intent(), observation(), close()]);
  assert.throws(() => applyEvent(state, f.opened), { code: "OPERATION_REPEATED" });
  const next = identity("next");
  applyEvent(state, changedPlan(f.opened, { operation: next }));
  assert.throws(() => applyEvent(state, intent({ operation: next })), { code: "CALL_REPEATED" });
});

test("actual wall-clock admission rejects a backdated intent after its window", async t => {
  const f = await fixture(t);
  let head = await enrolled(f);
  head = (await invoke(f, "append", f.opened, head)).head;
  await assert.rejects(invoke(f, "append", intent(), head, { now: Date.parse(deadline) }), { code: "WINDOW_EXPIRED" });
  assert.equal(git(f.config.location, ["rev-parse", f.config.ref]), head);
});

test("stale competing heads reject; no automatic enrollment or reset on missing/changed roots", async t => {
  const f = await fixture(t);
  const root = await enrolled(f);
  const head = (await invoke(f, "append", f.opened, root)).head;
  await assert.rejects(invoke(f, "append", changedPlan(f.opened, { operation: identity("competing") }), root), { code: "STALE_HEAD" });
  await assert.rejects(invoke(f, "read", undefined, root), { code: "STALE_HEAD" });
  const oldRoot = f.config.root;
  f.config.root = identity("wrong").slice(0, 40);
  await assert.rejects(invoke(f, "read", undefined, head), { code: "HISTORY_INVALID" });
  f.config.root = oldRoot;
  git(f.config.location, ["update-ref", "-d", f.config.ref]);
  await assert.rejects(invoke(f, "read", undefined, head), { code: "STALE_HEAD" });
  assert.equal(git(f.config.location, ["for-each-ref"]), "");
});

test("missing or altered retained originals cannot become accepted evidence", async t => {
  const f = await fixture(t);
  const root = await enrolled(f);
  await rm(f.config.evidence[identity("policy")]);
  await assert.rejects(invoke(f, "read", undefined, root), { code: "EVIDENCE_UNAVAILABLE" });
  await writeFile(f.config.evidence[identity("policy")], "different public synthetic policy");
  await assert.rejects(invoke(f, "append", f.opened, root), { code: "EVIDENCE_CHANGED" });
  assert.equal(git(f.config.location, ["rev-parse", f.config.ref]), root);
});

test("copied root at another location is rejected even when its Git identities match", async t => {
  const f = await fixture(t);
  const root = await enrolled(f);
  const copy = join(f.directory, "copy.git");
  git(f.config.location, ["clone", "--bare", "--template=", f.config.location, copy]);
  f.config.location = copy;
  await assert.rejects(invoke(f, "read", undefined, root), { code: "ENROLLMENT_MISMATCH" });
});

test("CLI errors are JSON without private input paths, raw Git diagnostics or source contents", async t => {
  const f = await fixture(t);
  const path = join(f.directory, "nonexistent-private-fixture.json");
  const result = spawnSync(process.execPath, [resolve("scripts/release-record.mjs"), "read", "--config", path,
    "--expected-head", "0".repeat(40)], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { status: "failed", code: "LOCAL_FAILURE", cleanupFailed: false });
  assert.equal(result.stdout.includes(f.directory), false);
});

test("CLI inspect validates the exact canonical bytes without Git writes or private configuration", async t => {
  const f = await fixture(t);
  const bytes = canonicalBytes({ schemaVersion: 1, event: f.opened });
  const path = join(f.directory, "public-input.json");
  await writeFile(path, bytes);
  const result = spawnSync(process.execPath, [resolve("scripts/release-record.mjs"), "inspect", "--input", path], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { schemaVersion: 1, sha256: sha256(bytes), byteLength: bytes.length });
  assert.equal(git(f.config.location, ["count-objects", "-v"]).split("\n")[0], "count: 0");
});

async function wrapper(f, mode) {
  const executable = join(f.directory, `git-${mode}.mjs`);
  const log = join(f.directory, `git-${mode}.jsonl`);
  const marker = join(f.directory, `git-${mode}.marker`);
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  const source = `#!${process.execPath}
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2), input = fs.readFileSync(0);
const mode = ${JSON.stringify(mode)}, log = ${JSON.stringify(log)}, marker = ${JSON.stringify(marker)};
const realGit = ${JSON.stringify(realGit)};
fs.appendFileSync(log, JSON.stringify({ args, input: input.toString() }) + "\\n");
if (mode === "before" && args.includes("push")) process.exit(88);
if (mode === "object-fail" && args.includes("mktree")) process.exit(88);
if (mode === "readback" && args.includes("ls-remote") && fs.existsSync(marker)) process.exit(89);
if (mode === "race" && args.includes("push")) {
  const rival = JSON.parse(fs.readFileSync(marker));
  const update = spawnSync(realGit, ["--git-dir", rival.location, "update-ref", rival.ref, rival.commit, rival.old], { env: process.env });
  if (update.status !== 0) process.exit(91);
}
const result = spawnSync(realGit, args, { input, env: process.env });
if (args.includes("push") && mode !== "race") fs.writeFileSync(marker, "attempted");
if (mode === "cancel" && args.includes("push") && result.status === 0) process.kill(process.ppid, "SIGTERM");
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(mode === "after" && args.includes("push") ? 88 : result.status ?? 90);
`;
  await writeFile(executable, source);
  await chmod(executable, 0o700);
  return { executable, log, marker };
}

for (const mode of ["before", "after", "readback"]) test(`actual Git write failure boundary: ${mode}`, async t => {
  const f = await fixture(t);
  let head = await enrolled(f);
  head = (await invoke(f, "append", f.opened, head)).head;
  const observer = await wrapper(f, mode);
  let result;
  if (mode === "after") {
    result = await invoke(f, "append", intent(), head, { gitExecutable: observer.executable });
    assert.equal(result.status, "confirmed");
    assert.equal(result.pushExit, 88);
    assert.equal(git(f.config.location, ["rev-parse", f.config.ref]), result.head);
  } else {
    await assert.rejects(invoke(f, "append", intent(), head, { gitExecutable: observer.executable }), error => {
      assert.equal(error.code, "WRITE_UNCONFIRMED");
      assert.equal(error.receipt.status, "unconfirmed");
      result = error.receipt;
      return true;
    });
    assert.equal(git(f.config.location, ["rev-parse", f.config.ref]), mode === "before" ? head : result.attemptedCommit);
  }
  const lines = (await readFile(observer.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const push = lines.find(x => x.args.includes("push"));
  assert.ok(push.args.includes(`--force-with-lease=${f.config.ref}:${head}`));
  const blob = lines.find(x => x.args.includes("hash-object"));
  assert.deepEqual(JSON.parse(blob.input).event, intent());
  assert.equal(blob.input.includes(f.directory), false);
  for (const directory of new Set(lines.map(x => x.args[x.args.indexOf("--git-dir") + 1]))) {
    await assert.rejects(readdir(directory), { code: "ENOENT" });
  }
  const actual = git(f.config.location, ["rev-parse", f.config.ref]);
  const read = await invoke(f, "read", undefined, actual);
  assert.equal(read.checkpoint.unresolvedCalls, mode === "before" ? 0 : 1);
});

test("schema, inspection and missing evidence rejection precede any authored Git objects", async t => {
  const f = await fixture(t);
  const root = await enrolled(f);
  const observer = await wrapper(f, "observe");
  const bytes = canonicalBytes({ schemaVersion: 1, event: { ...f.opened, extra: "synthetic canary" } });
  await assert.rejects(invoke(f, "append", f.opened, root, { inputBytes: bytes, inspected: sha256(bytes), gitExecutable: observer.executable }), { code: "INVALID_DATA" });
  await assert.rejects(readFile(observer.log), { code: "ENOENT" });
  await assert.rejects(invoke(f, "append", f.opened, root, { inspected: "0".repeat(64), gitExecutable: observer.executable }), { code: "INSPECTION_MISMATCH" });
  delete f.config.evidence[identity("authority")];
  await assert.rejects(invoke(f, "append", f.opened, root, { gitExecutable: observer.executable }), { code: "EVIDENCE_UNAVAILABLE" });
  const lines = (await readFile(observer.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(lines.some(x => ["hash-object", "mktree", "commit-tree", "push"].some(command => x.args.includes(command))), false);
});

function authoredFrame(f, frame, parents) {
  const blob = git(f.config.location, ["hash-object", "-w", "--stdin"], canonicalBytes(frame));
  const tree = git(f.config.location, ["mktree"], `100644 blob ${blob}\tcheckpoint.json\n`);
  return git(f.config.location, ["commit-tree", tree, ...parents.flatMap(parent => ["-p", parent])], "Synthetic public fixture\n");
}

for (const variant of ["checkpoint", "merge", "root", "schema", "missing-object"]) {
  test(`real Git reader rejects ${variant} history instead of trusting the head checkpoint`, async t => {
    const f = await fixture(t);
    const root = await enrolled(f);
    const frame = JSON.parse(git(f.config.location, ["show", `${root}:checkpoint.json`]));
    let head;
    if (variant === "missing-object") {
      const blob = git(f.config.location, ["rev-parse", `${root}:checkpoint.json`]);
      await rm(join(f.config.location, "objects", blob.slice(0, 2), blob.slice(2)));
      head = root;
    } else {
      if (["checkpoint", "schema"].includes(variant)) {
        frame.event = f.opened;
        frame.checkpoint = applyEvent(replay(f.root, []), f.opened);
      }
      if (variant === "checkpoint") frame.checkpoint.unresolvedCalls = 1;
      if (variant === "schema") frame.schemaVersion = 2;
      const parents = variant === "root" ? [] : [root];
      if (variant === "merge") {
        const rival = authoredFrame(f, frame, []);
        parents.push(rival);
      }
      head = authoredFrame(f, frame, parents);
      git(f.config.location, ["update-ref", f.config.ref, head, root]);
    }
    await assert.rejects(invoke(f, "read", undefined, head));
    assert.equal(git(f.config.location, ["rev-parse", f.config.ref]), head);
  });
}

test("a rival ref update after admission cannot be overwritten by the append", async t => {
  const f = await fixture(t);
  const root = await enrolled(f);
  const priorFrame = JSON.parse(git(f.config.location, ["show", `${root}:checkpoint.json`]));
  const state = replay(f.root, []);
  const checkpoint = applyEvent(state, f.opened);
  const frame = { ...priorFrame, event: f.opened, checkpoint };
  const rival = authoredFrame(f, frame, [root]);
  const observer = await wrapper(f, "race");
  await writeFile(observer.marker, JSON.stringify({ location: f.config.location, ref: f.config.ref, commit: rival, old: root }));
  await assert.rejects(invoke(f, "append", f.opened, root, { gitExecutable: observer.executable }), { code: "WRITE_UNCONFIRMED" });
  assert.equal(git(f.config.location, ["rev-parse", f.config.ref]), rival);
  const observed = await invoke(f, "read", undefined, rival);
  assert.equal(observed.checkpoint.sequence, 2);
  assert.equal(observed.checkpoint.activeOperation, operation);
});

test("changed admission metadata cannot masquerade as the identified plan", async t => {
  const f = await fixture(t);
  for (const change of [{ owner: identity("other") }, { candidate: identity("other") },
    { authority: identity("other") }, { effects: [identity("other")] },
    { window: { start: at, deadline: "2026-01-01T02:00:00.000Z" } }]) {
    assert.throws(() => inputEvent(canonicalBytes({ schemaVersion: 1, event: { ...f.opened, ...change } })), { code: "PLAN_MISMATCH" });
  }
});

test("object creation failure cannot confirm a checkpoint or change the enrolled reference", async t => {
  const f = await fixture(t);
  const root = await enrolled(f);
  const observer = await wrapper(f, "object-fail");
  await assert.rejects(invoke(f, "append", f.opened, root, { gitExecutable: observer.executable }), error => {
    assert.equal(error.code, "GIT_FAILED");
    assert.equal(error.receipt, undefined);
    return true;
  });
  assert.equal(git(f.config.location, ["rev-parse", f.config.ref]), root);
  const lines = (await readFile(observer.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(lines.some(x => x.args.includes("push")), false);
  const blob = lines.find(x => x.args.includes("hash-object"));
  assert.deepEqual(JSON.parse(blob.input).event, f.opened);
  await assert.rejects(readdir(blob.args[blob.args.indexOf("--git-dir") + 1]), { code: "ENOENT" });
});

test("process cancellation after the real Git write leaves a readable unresolved intent", async t => {
  const f = await fixture(t);
  let head = await enrolled(f);
  const start = new Date(Date.now() - 1000).toISOString();
  f.opened = changedPlan(f.opened, { at: start,
    window: { start, deadline: new Date(Date.now() + 60000).toISOString() } });
  const planPath = join(f.directory, "current-plan.json");
  await writeFile(planPath, planBytes(f.opened));
  f.config.evidence[f.opened.plan] = planPath;
  head = (await invoke(f, "append", f.opened, head, { now: Date.now() })).head;
  const observer = await wrapper(f, "cancel");
  const bin = join(f.directory, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "git"), await readFile(observer.executable));
  await chmod(join(bin, "git"), 0o700);
  const configPath = join(f.directory, "private-config.json");
  const inputPath = join(f.directory, "intent.json");
  const bytes = canonicalBytes({ schemaVersion: 1, event: intent({ at: start }) });
  await writeFile(configPath, JSON.stringify(f.config));
  await writeFile(inputPath, bytes);
  const result = spawnSync(process.execPath, [resolve("scripts/release-record.mjs"), "append", "--config", configPath,
    "--input", inputPath, "--inspected", sha256(bytes), "--expected-head", head], {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8", timeout: 20000,
  });
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.stdout, "");
  const actual = git(f.config.location, ["rev-parse", f.config.ref]);
  assert.notEqual(actual, head);
  const observed = await invoke(f, "read", undefined, actual);
  assert.equal(observed.checkpoint.unresolvedCalls, 1);
  assert.equal(observed.operations[0].calls[0].outcome, "unknown");
  const logs = (await readFile(observer.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  // SIGTERM can prevent finally. The fixture identifies and removes only its own leftover.
  for (const directory of new Set(logs.map(x => x.args[x.args.indexOf("--git-dir") + 1]))) {
    assert.ok(directory.startsWith(join(tmpdir(), "tabgrad-release-record-")));
    await rm(directory, { recursive: true, force: true });
  }
});

test("window expiry during preparation prevents the actual Git write", async t => {
  const f = await fixture(t);
  const root = await enrolled(f);
  let reads = 0;
  const observer = await wrapper(f, "observe");
  await assert.rejects(invoke(f, "append", f.opened, root, { gitExecutable: observer.executable,
    clock: () => ++reads === 1 ? now : Date.parse(deadline) }), { code: "WINDOW_EXPIRED" });
  assert.equal(git(f.config.location, ["rev-parse", f.config.ref]), root);
  const lines = (await readFile(observer.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(lines.some(x => x.args.includes("push")), false);
  assert.equal(lines.some(x => x.args.includes("commit-tree")), true);
});

for (const operationCount of [1, 16, 64]) for (const effectCount of [1, 8]) {
  test(`checkpoint stays a summary for ${operationCount} operations and ${effectCount} effects each`, async t => {
    const f = await fixture(t);
    const state = replay(f.root, []);
    let checkpoint;
    for (let index = 0; index < operationCount; index += 1) {
      const current = identity(`operation-${index}`);
      const effects = Array.from({ length: effectCount }, (_, effectIndex) => identity(`effect-${effectIndex}`));
      applyEvent(state, changedPlan(f.opened, { operation: current, effects }));
      for (const [effectIndex, effect] of effects.entries()) {
        const currentCall = identity(`call-${index}-${effectIndex}`);
        applyEvent(state, intent({ operation: current, call: currentCall, effect }));
        applyEvent(state, observation({ operation: current, call: currentCall }));
      }
      checkpoint = applyEvent(state, close({ operation: current }));
    }
    assert.deepEqual(Object.keys(checkpoint).sort(),
      ["activeOperation", "conflictingCalls", "eventSha256", "sequence", "unresolvedCalls"]);
    assert.equal(checkpoint.sequence, 1 + operationCount * (2 + effectCount * 2));
    assert.equal(checkpoint.unresolvedCalls, 0);
    assert.equal(state.operations.size, operationCount);
    assert.equal(state.calls.size, operationCount * effectCount);
    assert.equal(state.calls.values().next().value.lastObservation.evidence, identity("evidence"));
  });
}
