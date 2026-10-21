import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  acquisitionFields, acquisitionSha256, isAcquisitionHash, isAcquisitionToken,
  isAcquisitionUint, requireAcquisition,
} from "./provenance-acquisition-record.mjs";
import { identityMatches, ownedRoot } from "./provenance-acquisition-file-io.mjs";

export const LAUNCH_PROFILE_LIMIT = 32 * 1024;
const check = condition => requireAcquisition(condition, "LAUNCH_PROFILE");
const fields = (value, keys) => check(acquisitionFields(value, keys.split(" ")));
const uint32 = value => isAcquisitionUint(value) && BigInt(value) > 0n && BigInt(value) <= 0xffffffffn;

function text(value) {
  check(typeof value === "string" && value.length <= LAUNCH_PROFILE_LIMIT && value.isWellFormed() && !value.includes("\0"));
  return value;
}

export function launchPath(value) {
  text(value);
  check(isAbsolute(value) && resolve(value) === value && Buffer.byteLength(value) <= 4096
    && value.split("/").filter(Boolean).length <= 64);
  return value;
}

function strings(value) {
  check(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype);
  check(value.length <= LAUNCH_PROFILE_LIMIT);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(value).length === value.length + 1);
  const result = [];
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    check(descriptors[i] && Object.hasOwn(descriptors[i], "value") && descriptors[i].enumerable);
    const item = text(descriptors[i].value);
    bytes += Buffer.byteLength(item);
    check(bytes <= LAUNCH_PROFILE_LIMIT);
    result.push(item);
  }
  return Object.freeze(result);
}

function identity(value) {
  fields(value, "dev ino");
  check(isAcquisitionUint(value.dev) && isAcquisitionUint(value.ino) && value.ino !== "0");
  return Object.freeze({ dev: value.dev, ino: value.ino });
}

function endpoint(value) {
  fields(value, "name identity");
  text(value.name);
  check(value.name.length > 0 && value.name !== "." && value.name !== ".."
    && basename(value.name) === value.name && Buffer.byteLength(value.name) <= 4096);
  return Object.freeze({ name: value.name, identity: identity(value.identity) });
}

/** Ordinary data only. Canonical order belongs here, not in JSON caller order. */
function copyData(value) {
  fields(value, "schemaVersion operationId launcher program programRecipeSha256 ipc timing");
  check(value.schemaVersion === 1 && isAcquisitionToken(value.operationId));
  const l = value.launcher;
  fields(l, "runtimePath runtimeSha256 entryPath entrySha256 uid gid groups");
  check(isAcquisitionHash(l.runtimeSha256) && isAcquisitionHash(l.entrySha256)
    && uint32(l.uid) && uint32(l.gid));
  const groups = strings(l.groups);
  check(groups.includes(l.gid) && groups.every((g, i) => uint32(g)
    && (i === 0 || BigInt(groups[i - 1]) < BigInt(g))));
  const launcher = Object.freeze({ runtimePath: launchPath(l.runtimePath), runtimeSha256: l.runtimeSha256,
    entryPath: launchPath(l.entryPath), entrySha256: l.entrySha256, uid: l.uid, gid: l.gid, groups });
  const p = value.program;
  fields(p, "binarySha256 argv env workingDir");
  check(isAcquisitionHash(p.binarySha256));
  const argv = strings(p.argv);
  check(argv.length > 0);
  launchPath(argv[0]);
  const env = strings(p.env);
  const names = new Set();
  for (const item of env) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(item);
    check(match !== null && !names.has(match[1]));
    names.add(match[1]);
  }
  const program = Object.freeze({ binarySha256: p.binarySha256, argv, env, workingDir: launchPath(p.workingDir) });
  const credentials = { uid: launcher.uid, gid: launcher.gid, groups };
  check(isAcquisitionHash(value.programRecipeSha256)
    && value.programRecipeSha256 === acquisitionSha256(JSON.stringify({ program, credentials })));
  const i = value.ipc;
  fields(i, "root stdout stderr control");
  fields(i.root, "path identity");
  const ipc = Object.freeze({ root: Object.freeze({ path: launchPath(i.root.path), identity: identity(i.root.identity) }),
    stdout: endpoint(i.stdout), stderr: endpoint(i.stderr), control: endpoint(i.control) });
  check(new Set([ipc.stdout.name, ipc.stderr.name, ipc.control.name]).size === 3
    && new Set([ipc.root, ipc.stdout, ipc.stderr, ipc.control].map(e => `${e.identity.dev}:${e.identity.ino}`)).size === 4);
  for (const role of ["stdout", "stderr", "control"]) launchPath(join(ipc.root.path, ipc[role].name));
  const t = value.timing;
  fields(t, "t0MonotonicNs workUntilNs closeUntilNs");
  check(Object.values(t).every(isAcquisitionUint) && BigInt(t.workUntilNs) > 0n
    && BigInt(t.workUntilNs) <= BigInt(t.closeUntilNs));
  const timing = Object.freeze({ t0MonotonicNs: t.t0MonotonicNs, workUntilNs: t.workUntilNs, closeUntilNs: t.closeUntilNs });
  return Object.freeze({ schemaVersion: 1, operationId: value.operationId, launcher, program,
    programRecipeSha256: value.programRecipeSha256, ipc, timing });
}

export function encodeLaunchProfile(value) {
  const bytes = Buffer.from(JSON.stringify(copyData(value)));
  check(bytes.length > 0 && bytes.length <= LAUNCH_PROFILE_LIMIT);
  return bytes;
}

/** P and hash come from independent admission; hashing is not authentication. */
export function copyLaunchProfile(bytes, expected) {
  fields(expected, "sha256 bytes");
  check(Number.isInteger(expected.bytes) && expected.bytes > 0 && expected.bytes <= LAUNCH_PROFILE_LIMIT
    && isAcquisitionHash(expected.sha256));
  check(Buffer.isBuffer(bytes) && bytes.length === expected.bytes);
  check(acquisitionSha256(bytes) === expected.sha256);
  let decoded;
  try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { check(false); }
  const profile = copyData(decoded);
  check(encodeLaunchProfile(profile).equals(bytes));
  return Object.freeze({ profile, sha256: expected.sha256, bytes: expected.bytes });
}

/** Bounded, readonly, existing regular file. Namespace stability is an admitted premise. */
export async function readLaunchProfile(path, expected) {
  fields(expected, "sha256 bytes identity");
  const admittedIdentity = identity(expected.identity);
  check(Number.isInteger(expected.bytes) && expected.bytes > 0 && expected.bytes <= LAUNCH_PROFILE_LIMIT
    && isAcquisitionHash(expected.sha256));
  const admitted = Object.freeze({ sha256: expected.sha256, bytes: expected.bytes, identity: admittedIdentity });
  launchPath(path);
  let handle;
  let result;
  let failed = false;
  try {
    await ownedRoot(resolve(path, ".."));
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    check(before.isFile() && before.nlink === 1n && before.size === BigInt(admitted.bytes));
    identityMatches(before, admitted.identity);
    const bytes = Buffer.alloc(admitted.bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      check(Number.isInteger(bytesRead) && bytesRead > 0 && bytesRead <= bytes.length - offset);
      offset += bytesRead;
    }
    const probe = await handle.read(Buffer.alloc(1), 0, 1, offset);
    check(probe.bytesRead === 0);
    const after = await handle.stat({ bigint: true });
    check(after.isFile() && after.nlink === 1n && after.size === before.size);
    identityMatches(after, admitted.identity);
    result = copyLaunchProfile(bytes, { sha256: admitted.sha256, bytes: admitted.bytes });
  } catch { failed = true; }
  if (handle) {
    try { await handle.close(); } catch { failed = true; }
  }
  requireAcquisition(!failed, "LAUNCH_PROFILE_READ");
  return result;
}
