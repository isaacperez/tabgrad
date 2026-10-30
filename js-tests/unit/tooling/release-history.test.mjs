import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { canonicalBytes, sha256 } from "../../../scripts/release-record-data.mjs";
import { publicationRecordConfig } from "../../../scripts/publication-controller.mjs";
import { historyContext, historyDispatch, historyInputLimit, materializeHistory,
  observeHistoryArtifact, prepareHistory, writeHistoryOutput } from "../../../scripts/release-history.mjs";

const now = Date.parse("2026-10-30T00:00:00.000Z");
const source = "a".repeat(40);
const expiresAt = "2026-10-30T01:00:00.000Z";
const environment = { TABGRAD_HISTORY_ENABLED: "true", TABGRAD_HISTORY_CONFIRMATION: "release-history",
  TABGRAD_HISTORY_SOURCE: source, TABGRAD_HISTORY_DEADLINE: expiresAt,
  GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", GITHUB_RUN_ATTEMPT: "1",
  GITHUB_SHA: source, GITHUB_REPOSITORY: "example/project", GITHUB_REPOSITORY_ID: "10",
  GITHUB_RUN_ID: "20", GITHUB_WORKFLOW_REF: "example/project/.github/workflows/release-history.yml@refs/heads/main" };

async function fixture(t, originals = [Buffer.from('{ "unchanged": true }\n'), Buffer.from([0, 255, 128, 10])]) {
  const root = await io.mkdtemp(join(tmpdir(), "tabgrad-history-test-"));
  t.after(() => io.rm(root, { recursive: true, force: true }));
  const directory = join(root, "originals");
  await io.mkdir(directory);
  for (const bytes of originals) await io.writeFile(join(directory, `${sha256(bytes)}.json`), bytes);
  return { root, directory, originals, output: join(root, "prepared") };
}

function packetFor(files) {
  return canonicalBytes({ schemaVersion: 1, files: files.map(bytes => ({ sha256: sha256(bytes),
    base64: bytes.toString("base64") })).sort((a, b) => a.sha256.localeCompare(b.sha256)) });
}

function packetEnvironment(raw) {
  return { ...environment, TABGRAD_HISTORY_JSON: raw.toString("utf8"), TABGRAD_HISTORY_SHA256: sha256(raw) };
}

test("initial history preserves exact original bytes through the existing publication reader", async t => {
  const f = await fixture(t);
  const result = await prepareHistory({ ...f, source, expiresAt, now });
  const raw = await io.readFile(join(f.output, "history.json"));
  const dispatch = await io.readFile(join(f.output, "dispatch.json"));
  assert.equal(result.packetSha256, sha256(raw));
  assert.equal(result.dispatchCharacters, dispatch.length);
  assert.deepEqual(dispatch, canonicalBytes(historyDispatch(raw.toString("utf8"), source, expiresAt, now)));
  const output = join(f.root, "received");
  await materializeHistory({ output, environment: packetEnvironment(raw), now });
  const config = await publicationRecordConfig(output, { record: {}, writerPolicySha256: "b".repeat(64) });
  assert.equal(Object.keys(config.evidence).length, f.originals.length);
  for (const bytes of f.originals) {
    assert.deepEqual(await io.readFile(config.evidence[sha256(bytes)]), bytes);
    assert.deepEqual(await io.readFile(join(f.directory, `${sha256(bytes)}.json`)), bytes);
  }
});

test("the real prepare CLI is offline, emits a bounded receipt and never prints originals", async t => {
  const f = await fixture(t, [Buffer.from("PRIVATE synthetic original\n")]);
  const deadline = new Date(Date.now() + 3600000).toISOString();
  const child = spawnSync(process.execPath, ["scripts/release-history.mjs", "prepare", f.directory, source,
    deadline, f.output], { encoding: "utf8", env: {}, timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  assert.equal(JSON.parse(child.stdout).status, "prepared");
  assert(!child.stdout.includes("PRIVATE"));
  const failed = spawnSync(process.execPath, ["scripts/release-history.mjs", "prepare", f.directory, source,
    deadline, f.output], { encoding: "utf8", env: {}, timeout: 10000 });
  assert.equal(failed.status, 1);
  assert.equal(JSON.parse(failed.stdout).code, "PUBLICATION_HISTORY_OUTPUT");
  assert(!failed.stdout.includes(f.root));
  const raw = await io.readFile(join(f.output, "history.json"));
  const output = join(f.root, "cli-received");
  const received = spawnSync(process.execPath, ["scripts/release-history.mjs", "materialize", output], {
    encoding: "utf8", env: { ...packetEnvironment(raw), TABGRAD_HISTORY_DEADLINE: deadline }, timeout: 10000 });
  assert.equal(received.status, 0, received.stderr);
  assert.equal(JSON.parse(received.stdout).status, "materialized");
  assert(!received.stdout.includes("PRIVATE"));
  assert.deepEqual(await io.readFile(join(output, `${sha256(f.originals[0])}.json`)), f.originals[0]);
});

test("actual CI entrypoints are inert without admitted context", async t => {
  const f = await fixture(t), output = join(f.root, "not-created");
  for (const arguments_ of [["materialize", output], ["observe"]]) {
    const child = spawnSync(process.execPath, ["scripts/release-history.mjs", ...arguments_],
      { encoding: "utf8", env: {}, timeout: 10000 });
    assert.equal(child.status, 1);
    assert.equal(JSON.parse(child.stdout).code, "PUBLICATION_HISTORY_CONTEXT");
    assert.equal(child.stderr, "");
    assert(!child.stdout.includes(f.root));
  }
  await assert.rejects(io.stat(output), { code: "ENOENT" });
});

test("the exact entire REST-input budget includes packet escaping and auxiliary fields", () => {
  const overhead = canonicalBytes(historyDispatch("", source, expiresAt, now)).length;
  const packet = "x".repeat(historyInputLimit - overhead);
  assert.equal(canonicalBytes(historyDispatch(packet, source, expiresAt, now)).length, historyInputLimit);
  assert.throws(() => historyDispatch(packet + "x", source, expiresAt, now), /PUBLICATION_HISTORY_INPUT_LIMIT/);
  assert.throws(() => historyDispatch(packet.slice(1) + '"', source, expiresAt, now), /PUBLICATION_HISTORY_INPUT_LIMIT/);
  assert(packet.length < historyInputLimit);
});

test("a reader-valid large original fails before creating output rather than being truncated", async t => {
  const f = await fixture(t, [Buffer.alloc(65536)]);
  await assert.rejects(prepareHistory({ ...f, source, expiresAt, now }), /PUBLICATION_HISTORY_INPUT_LIMIT/);
  await assert.rejects(io.stat(f.output), { code: "ENOENT" });
  assert.equal((await io.readFile(join(f.directory, `${sha256(f.originals[0])}.json`))).length, 65536);
});

test("the largest one-original packet admitted by the full frame rejects its first excess", async t => {
  let low = 0, high = 65536;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    try { historyDispatch(packetFor([Buffer.alloc(middle)]).toString(), source, expiresAt, now); low = middle; }
    catch { high = middle; }
  }
  const f = await fixture(t, [Buffer.alloc(low)]);
  await prepareHistory({ ...f, source, expiresAt, now });
  assert((await io.readFile(join(f.output, "dispatch.json"))).length <= historyInputLimit);
  assert.throws(() => historyDispatch(packetFor([Buffer.alloc(high)]).toString(), source, expiresAt, now),
    /PUBLICATION_HISTORY_INPUT_LIMIT/);
});

test("packet canonical form, closed fields, original names and bytes are admitted before any write", async t => {
  const f = await fixture(t), raw = packetFor(f.originals), valid = JSON.parse(raw);
  const invalid = [
    Buffer.from(JSON.stringify(valid)),
    Buffer.from('{"files":[],"schemaVersion":1,"schemaVersion":1}\n'),
    canonicalBytes({ ...valid, extra: true }),
    canonicalBytes({ ...valid, files: [] }),
    canonicalBytes({ ...valid, files: [...valid.files].reverse() }),
    canonicalBytes({ ...valid, files: [valid.files[0], valid.files[0]] }),
    canonicalBytes({ ...valid, files: [{ ...valid.files[0], path: "../private" }] }),
    canonicalBytes({ ...valid, files: [{ ...valid.files[0], sha256: "../private" }] }),
    canonicalBytes({ ...valid, files: [{ ...valid.files[0], base64: "!!" }] }),
    canonicalBytes({ ...valid, files: [{ ...valid.files[0], base64: Buffer.from("different").toString("base64") }] }),
    Buffer.from("not-json\n"),
  ];
  for (const [index, bytes] of invalid.entries()) {
    const output = join(f.root, `invalid-${index}`);
    await assert.rejects(materializeHistory({ output, environment: packetEnvironment(bytes), now }), /PUBLICATION_HISTORY_PACKET/);
    await assert.rejects(io.stat(output), { code: "ENOENT" });
  }
  await assert.rejects(materializeHistory({ output: join(f.root, "changed-hash"),
    environment: { ...packetEnvironment(raw), TABGRAD_HISTORY_SHA256: "0".repeat(64) }, now }), /PUBLICATION_HISTORY_PACKET/);
});

test("wrong or expired execution context cannot materialize any original", async t => {
  const f = await fixture(t), raw = packetFor(f.originals);
  const changes = { TABGRAD_HISTORY_ENABLED: "false", TABGRAD_HISTORY_CONFIRMATION: "other",
    GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/other", GITHUB_RUN_ATTEMPT: "2", GITHUB_SHA: "b".repeat(40),
    GITHUB_WORKFLOW_REF: "example/project/.github/workflows/other.yml@refs/heads/main", GITHUB_RUN_ID: "0",
    GITHUB_REPOSITORY_ID: "missing", TABGRAD_HISTORY_DEADLINE: "2026-10-29T00:00:00.000Z" };
  for (const [key, value] of Object.entries(changes)) {
    const output = join(f.root, key);
    await assert.rejects(materializeHistory({ output, environment: { ...packetEnvironment(raw), [key]: value }, now }),
      /PUBLICATION_HISTORY_CONTEXT/);
    await assert.rejects(io.stat(output), { code: "ENOENT" });
  }
});

test("existing destinations and foreign files survive failure", async t => {
  const f = await fixture(t), output = join(f.root, "foreign");
  await io.mkdir(output);
  const marker = join(output, "keep");
  await io.writeFile(marker, "unchanged");
  await assert.rejects(materializeHistory({ output, environment: packetEnvironment(packetFor(f.originals)), now }),
    /PUBLICATION_HISTORY_OUTPUT/);
  assert.equal(await io.readFile(marker, "utf8"), "unchanged");
});

test("preparation cannot add outputs to its selected original directory, including aliases", async t => {
  const f = await fixture(t), alias = join(f.root, "alias");
  await io.symlink(f.directory, alias);
  const before = await io.readdir(f.directory);
  for (const output of [f.directory, join(f.directory, "prepared"), join(alias, "prepared")]) {
    await assert.rejects(prepareHistory({ ...f, output, source, expiresAt, now }), /PUBLICATION_HISTORY_OUTPUT/);
  }
  assert.deepEqual(await io.readdir(f.directory), before);
});

test("the shared reader rejects symlinks, nonregular, changed and unrecognized originals", async t => {
  const f = await fixture(t);
  const path = join(f.directory, `${sha256(f.originals[0])}.json`);
  await io.writeFile(path, "changed");
  await assert.rejects(prepareHistory({ ...f, source, expiresAt, now }), /PUBLICATION_HISTORY_CHANGED/);
  await io.rm(path);
  await io.symlink(join(f.root, "absent"), path);
  await assert.rejects(prepareHistory({ ...f, source, expiresAt, now }), /PUBLICATION_INPUT_INVALID/);
  await io.rm(path);
  await io.mkdir(path);
  await assert.rejects(prepareHistory({ ...f, source, expiresAt, now }), /PUBLICATION_INPUT_INVALID/);
  await io.rm(path, { recursive: true });
  await io.writeFile(join(f.directory, "private-config.json"), "not an original");
  await assert.rejects(prepareHistory({ ...f, source, expiresAt, now }), /PUBLICATION_HISTORY_NAME/);
});

test("owned output removes partial writes and retains an unconfirmed-cleanup outcome", async t => {
  const f = await fixture(t), files = [["history.json", Buffer.from("one")], ["dispatch.json", Buffer.from("two")]];
  for (const failedCleanup of [false, true]) {
    let writes = 0;
    const adapter = { ...io, async writeFile(...arguments_) {
      if (++writes === 2) throw new Error("PRIVATE injected write failure");
      return io.writeFile(...arguments_);
    }, async rm(...arguments_) {
      if (failedCleanup) throw new Error("PRIVATE injected cleanup failure");
      return io.rm(...arguments_);
    } };
    const output = join(f.root, `partial-${failedCleanup}`);
    await assert.rejects(writeHistoryOutput(output, files, adapter), error =>
      error.code === "PUBLICATION_HISTORY_OUTPUT" && error.cleanup === (failedCleanup ? "unconfirmed" : "confirmed"));
    if (failedCleanup) assert.equal(await io.readFile(join(output, "history.json"), "utf8"), "one");
    else await assert.rejects(io.stat(output), { code: "ENOENT" });
  }
});

test("output readback disagreement is failure and cleans only that owned output", async t => {
  const f = await fixture(t), output = join(f.root, "bad-readback");
  const adapter = { ...io, async readFile() { return Buffer.from("different"); } };
  await assert.rejects(writeHistoryOutput(output, [["history.json", Buffer.from("expected")]], adapter), error =>
    error.code === "PUBLICATION_HISTORY_OUTPUT" && error.cleanup === "confirmed");
  await assert.rejects(io.stat(output), { code: "ENOENT" });
  assert.deepEqual(await io.readFile(join(f.directory, `${sha256(f.originals[0])}.json`)), f.originals[0]);
});

test("metadata comes from the actual artifact fields and remains distinct from the packet", async () => {
  const env = { ...environment, TABGRAD_HISTORY_ARTIFACT_ID: "30", TABGRAD_HISTORY_ARTIFACT_DIGEST: "c".repeat(64) };
  const artifact = { id: 30, name: historyContext(env, now).name, digest: `sha256:${"c".repeat(64)}`,
    expired: false, size_in_bytes: 100, expires_at: "2027-01-28T00:00:00Z",
    workflow_run: { id: 20, repository_id: 10, head_repository_id: 10, head_sha: source } };
  const requests = [], api = { async request(path) { requests.push(path); return artifact; } };
  const history = await observeHistoryArtifact({ environment: env, api, now });
  assert.deepEqual(requests, ["/actions/artifacts/30"]);
  assert.deepEqual(history, { id: "30", sha256: "c".repeat(64), expiresAt: "2027-01-28T00:00:00.000Z",
    runId: "20", revision: source, name: "tabgrad-publication-history-20-1" });
  const late = await observeHistoryArtifact({ environment: env, api, now: now + 7200000 });
  assert.deepEqual(late, history); // Late readback conserves a fact, never uploads another artifact.
  for (const change of [{ digest: `sha256:${"d".repeat(64)}` }, { expired: true }, { expires_at: "invalid" },
    { name: "other" }, { size_in_bytes: "100" }, { size_in_bytes: 0 },
    { workflow_run: { ...artifact.workflow_run, head_sha: "b".repeat(40) } },
    { workflow_run: { ...artifact.workflow_run, id: 21 } }, { workflow_run: { ...artifact.workflow_run, repository_id: 11 } }]) {
    await assert.rejects(observeHistoryArtifact({ environment: env, now,
      api: { async request() { return { ...artifact, ...change }; } } }), /PUBLICATION_HISTORY_ARTIFACT/);
  }
});
