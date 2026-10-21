import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, stat, rm, symlink, link, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { copyLaunchProfile, encodeLaunchProfile, readLaunchProfile } from "../../../scripts/provenance-acquisition-launch-profile.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
// Independently spelled JSON, not the production encoder as its own oracle.
const program = `{"binarySha256":"${"3".repeat(64)}","argv":["/bin/client","--finite"],"env":["A=1","B=2"],"workingDir":"/work"}`;
const recipe = hash(`{"program":${program},"credentials":{"uid":"1000","gid":"1000","groups":["1000","2000"]}}`);
const literal = `{"schemaVersion":1,"operationId":"${"a".repeat(32)}","launcher":{"runtimePath":"/bin/node","runtimeSha256":"${"1".repeat(64)}","entryPath":"/work/launcher.mjs","entrySha256":"${"2".repeat(64)}","uid":"1000","gid":"1000","groups":["1000","2000"]},"program":${program},"programRecipeSha256":"${recipe}","ipc":{"root":{"path":"/ipc","identity":{"dev":"1","ino":"2"}},"stdout":{"name":"out","identity":{"dev":"1","ino":"3"}},"stderr":{"name":"err","identity":{"dev":"1","ino":"4"}},"control":{"name":"control","identity":{"dev":"1","ino":"5"}}},"timing":{"t0MonotonicNs":"100","workUntilNs":"1000000000","closeUntilNs":"2000000000"}}`;
const admit = bytes => copyLaunchProfile(bytes, { sha256: hash(bytes), bytes: bytes.length });

test("canonical literal, independent recipe, immutable closed copy and exact bytes", () => {
  const bytes = Buffer.from(literal);
  const admitted = admit(bytes);
  assert.equal(admitted.sha256, hash(literal));
  assert.deepEqual(encodeLaunchProfile(admitted.profile), bytes);
  bytes.fill(0);
  assert.equal(admitted.profile.program.argv[0], "/bin/client");
  assert.ok(Object.isFrozen(admitted.profile.program.argv));
  assert.throws(() => { admitted.profile.ipc.stdout.name = "other"; });
});

test("duplicate/unknown keys, order, whitespace, escaping, BOM and malformed UTF-8 reject", () => {
  const candidates = [literal + "\n", literal.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    literal.replace('"schemaVersion":1', '"unknown":1,"schemaVersion":1'),
    literal.replace('{"schemaVersion":1,', '{ "schemaVersion":1,'),
    literal.replace('"schemaVersion":1,"operationId":"' + "a".repeat(32) + '"',
      '"operationId":"' + "a".repeat(32) + '","schemaVersion":1'),
    literal.replace('"schemaVersion"', '"schema\\u0056ersion"')];
  for (const value of candidates) assert.throws(() => admit(Buffer.from(value)), { code: "LAUNCH_PROFILE" });
  for (const bytes of [Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(literal)]),
    Buffer.concat([Buffer.from(literal), Buffer.from([255])])]) assert.throws(() => admit(bytes));
});

test("closed nested domains and recipe binding reject independently", () => {
  const changes = [p => { p.launcher.uid = "0"; }, p => { p.launcher.groups.reverse(); },
    p => { p.launcher.groups.push("2000"); }, p => { p.launcher.groups = ["2000"]; },
    p => { p.program.argv = []; }, p => { p.program.argv[0] = "relative"; },
    p => { p.program.env.push("A=again"); }, p => { p.program.env.push("bad-name=x"); },
    p => { p.program.workingDir = "/a/../b"; }, p => { p.program.argv.push("\0"); },
    p => { p.program.argv.push("\ud800"); }, p => { p.ipc.stdout = p.ipc.stderr; },
    p => { p.ipc.stdout.name = "../out"; }, p => { p.ipc.stdout.identity.ino = "0"; },
    p => { p.timing.workUntilNs = "0"; }, p => { p.timing.closeUntilNs = "1"; },
    p => { p.timing.t0MonotonicNs = "18446744073709551616"; }, p => { p.programRecipeSha256 = "0".repeat(64); }];
  for (const change of changes) { const p = JSON.parse(literal); change(p); assert.throws(() => encodeLaunchProfile(p)); }
  let calls = 0;
  const p = JSON.parse(literal);
  Object.defineProperty(p.program, "argv", { enumerable: true, get() { calls++; return []; } });
  assert.throws(() => encodeLaunchProfile(p));
  const q = JSON.parse(literal);
  Object.defineProperty(q.program.argv, "0", { enumerable: true, get() { calls++; return "/x"; } });
  assert.throws(() => encodeLaunchProfile(q));
  assert.equal(calls, 0);
});

test("independent length/hash and 32 KiB quota are checked before decoding", () => {
  const bytes = Buffer.from(literal);
  for (const expected of [{ sha256: hash(bytes), bytes: bytes.length + 1 }, { sha256: "0".repeat(64), bytes: bytes.length },
    { sha256: hash(bytes), bytes: 32769 }, { sha256: hash(bytes), bytes: 0 }]) assert.throws(() => copyLaunchProfile(bytes, expected));
  assert.throws(() => admit(Buffer.alloc(32769)));
});

test("readonly identified file: exact P, no symlink, single link, exact size and EOF", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "launch-profile-")));
  try {
    const path = join(root, "profile");
    await writeFile(path, literal);
    const info = await stat(path, { bigint: true });
    const expected = { sha256: hash(literal), bytes: Buffer.byteLength(literal), identity: { dev: String(info.dev), ino: String(info.ino) } };
    assert.equal((await readLaunchProfile(path, expected)).sha256, expected.sha256);
    await assert.rejects(readLaunchProfile(path, { ...expected, bytes: expected.bytes - 1 }));
    await assert.rejects(readLaunchProfile(path, { ...expected, bytes: expected.bytes + 1 }));
    await assert.rejects(readLaunchProfile(path, { ...expected, identity: { ...expected.identity, ino: "1" } }));
    await symlink(path, join(root, "alias"));
    await assert.rejects(readLaunchProfile(join(root, "alias"), expected));
    await link(path, join(root, "hard"));
    await assert.rejects(readLaunchProfile(path, expected));
  } finally { await rm(root, { recursive: true, force: true }); }
});
