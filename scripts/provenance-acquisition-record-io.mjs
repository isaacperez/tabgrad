import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  ACQUISITION_LIMITS, AcquisitionRecordError, encodeAcquisitionRecord, requireAcquisition,
} from "./provenance-acquisition-record.mjs";

const roles = Object.keys(ACQUISITION_LIMITS);
export const ACQUISITION_ACTOR_PARTS = Object.freeze({
  supervisor: Object.freeze(["header", "progress", "supervisor"]),
  watchdog: Object.freeze(["watchdog"]),
});
const nativeTransfer = {
  write: (handle, bytes, offset, length, position) => handle.write(bytes, offset, length, position),
  read: (handle, bytes, offset, length, position) => handle.read(bytes, offset, length, position),
};

/** Identity of an effective regular file, not a pathname or allocation proof. */
export function acquisitionFileIdentity(stat) {
  requireAcquisition(typeof stat.dev === "bigint" && typeof stat.ino === "bigint"
    && stat.dev >= 0n && stat.ino > 0n, "FILE_IDENTITY");
  return Object.freeze({ dev: stat.dev.toString(), ino: stat.ino.toString() });
}

function identityMatches(stat, expected) {
  const actual = acquisitionFileIdentity(stat);
  requireAcquisition(expected && actual.dev === expected.dev && actual.ino === expected.ino, "FILE_IDENTITY");
  return `${actual.dev}:${actual.ino}`;
}

async function ownedRoot(root) {
  requireAcquisition(typeof root === "string" && isAbsolute(root) && resolve(root) === root, "FILE_ROOT");
  const before = await lstat(root, { bigint: true });
  requireAcquisition(before.isDirectory() && !before.isSymbolicLink(), "FILE_ROOT");
  requireAcquisition(await realpath(root) === root, "FILE_ROOT");
  return acquisitionFileIdentity(before);
}

async function openPart(root, role, destination, owned) {
  requireAcquisition(destination && typeof destination.name === "string"
    && destination.name !== "." && destination.name !== ".."
    && basename(destination.name) === destination.name && destination.name.length > 0, "FILE_DESTINATION");
  requireAcquisition(Number.isInteger(constants.O_NOFOLLOW), "FILE_IDENTITY");
  const handle = await open(join(root, destination.name), constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  owned.push(handle);
  const stat = await handle.stat({ bigint: true });
  requireAcquisition(stat.isFile() && stat.nlink === 1n
    && stat.size === BigInt(ACQUISITION_LIMITS[role]), "FILE_DESTINATION");
  const identity = identityMatches(stat, destination.identity);
  return { handle, identity };
}

function closedError(error, fallback) {
  return error instanceof AcquisitionRecordError ? error : new AcquisitionRecordError(fallback);
}

async function closeHandles(handles) {
  const results = await Promise.allSettled(handles.map(handle => handle.close()));
  return { openedHandles: handles.length,
    closedHandles: results.filter(result => result.status === "fulfilled").length };
}

function writerSnapshot(writer) {
  return Object.freeze({ role: writer.role, state: writer.state, confirmedBytes: writer.confirmedBytes,
    uncertain: writer.uncertain, firstError: writer.firstError, closeError: writer.closeError,
    sha256: writer.digest.copy().digest("hex") });
}

function failWriter(writer, code, ambiguous = false) {
  writer.firstError ??= code;
  writer.uncertain ||= ambiguous;
  writer.state = code === "PART_LIMIT" ? "limit" : "incomplete";
  throw new AcquisitionRecordError(writer.firstError);
}

async function writePart(writer, handle, transfer, bytes, record) {
  try {
    if (bytes.length > ACQUISITION_LIMITS[writer.role] - writer.confirmedBytes) failWriter(writer, "PART_LIMIT");
    let offset = 0;
    while (offset < bytes.length) {
      let result;
      try {
        result = await transfer.write(handle, bytes, offset, bytes.length - offset, writer.confirmedBytes);
      } catch { failWriter(writer, "WRITE_FAILED", true); }
      const count = result?.bytesWritten;
      if (!Number.isInteger(count) || count < 0 || count > bytes.length - offset) failWriter(writer, "WRITE_EXTENT_UNKNOWN", true);
      if (count === 0) failWriter(writer, "WRITE_NO_PROGRESS");
      writer.digest.update(bytes.subarray(offset, offset + count));
      writer.confirmedBytes += count;
      offset += count;
    }
    if (writer.role === "progress") {
      writer.nextSequence += 1n;
      writer.operationId = record.operationId;
      writer.lastAtNs = BigInt(record.atNs);
    } else writer.state = "complete";
    return writerSnapshot(writer);
  } finally { writer.busy = null; }
}

async function closePart(writer, handle) {
  if (writer.busy) await writer.busy.catch(() => {});
  try { await handle.close(); }
  catch { writer.firstError ??= "CLOSE_FAILED"; writer.closeError = "CLOSE_FAILED"; writer.state = "incomplete"; }
  return writerSnapshot(writer);
}

/** Read only a known prefix; virtual size and zero padding never supply length. */
async function readPrefix(handle, length, transfer) {
  const bytes = Buffer.alloc(length ?? 0);
  let offset = 0;
  let readError = null;
  while (offset < bytes.length) {
    let result;
    try { result = await transfer.read(handle, bytes, offset, bytes.length - offset, offset); }
    catch { readError = "READ_FAILED"; break; }
    const count = result?.bytesRead;
    if (!Number.isInteger(count) || count < 0 || count > bytes.length - offset) { readError = "READ_EXTENT_UNKNOWN"; break; }
    if (count === 0) { readError = "READ_INCOMPLETE"; break; }
    offset += count;
  }
  return { bytes: bytes.subarray(0, offset), readBytes: offset, readError };
}

async function checkHeaderHandle(handle, expectedIdentity) {
  const stat = await handle.stat({ bigint: true });
  const identity = acquisitionFileIdentity(stat);
  requireAcquisition(stat.isFile() && stat.nlink === 1n && stat.size === BigInt(ACQUISITION_LIMITS.header)
    && `${identity.dev}:${identity.ino}` === expectedIdentity, "FILE_IDENTITY");
}

async function readHeaderPart(writer, handle, transfer, expectedIdentity) {
  const confirmedBytes = writer.confirmedBytes;
  let result = { bytes: Buffer.alloc(0), readBytes: 0, readError: null };
  try {
    await checkHeaderHandle(handle, expectedIdentity);
    result = await readPrefix(handle, confirmedBytes, transfer);
    await checkHeaderHandle(handle, expectedIdentity);
  } catch (error) {
    result.readError ??= closedError(error, "READ_FAILED").code;
  } finally { writer.busy = null; }
  return { ...result, confirmedBytes, state: result.readError ? "unknown" : "complete",
    uncertain: result.readError !== null };
}

/** One independent positional writer. No cross-role access, implicit finish, or retry. */
function partWriter(role, handle, transfer, identity) {
  const writer = { role, state: "pending", confirmedBytes: 0, uncertain: false, firstError: null, closeError: null,
    busy: null, closed: false, closing: null, readStarted: false, nextSequence: 1n, operationId: null, lastAtNs: 0n,
    digest: createHash("sha256") };
  return Object.freeze({
    snapshot() { return writerSnapshot(writer); },
    async write(record) {
      requireAcquisition(!writer.closed && !writer.busy && writer.state === "pending", "WRITER_STOPPED");
      const bytes = encodeAcquisitionRecord(role, record);
      if (role === "progress") {
        requireAcquisition(BigInt(record.sequence) === writer.nextSequence && BigInt(record.atNs) >= writer.lastAtNs, "EVENT_ORDER");
        requireAcquisition(writer.operationId === null || writer.operationId === record.operationId, "OPERATION_MISMATCH");
      }
      // Deferring the operation ensures busy is installed even if it fails before its first await.
      const committed = role === "progress" ? { operationId: record.operationId, atNs: record.atNs } : null;
      writer.busy = Promise.resolve().then(() => writePart(writer, handle, transfer, bytes, committed));
      return writer.busy;
    },
    finish() {
      requireAcquisition(role === "progress" && !writer.closed && !writer.busy && writer.state === "pending", "WRITER_STOPPED");
      writer.state = "complete";
      return writerSnapshot(writer);
    },
    async readHeader() {
      requireAcquisition(role === "header" && !writer.closed && !writer.busy && !writer.readStarted
        && writer.state === "complete" && !writer.uncertain, "WRITER_STOPPED");
      requireAcquisition(typeof transfer.read === "function" && Number.isSafeInteger(writer.confirmedBytes)
        && writer.confirmedBytes > 0 && writer.confirmedBytes <= ACQUISITION_LIMITS.header, "READ_RANGE");
      writer.readStarted = true;
      writer.busy = Promise.resolve().then(() => readHeaderPart(writer, handle, transfer, identity));
      return writer.busy;
    },
    async close() {
      if (writer.closing) return writer.closing;
      writer.closed = true;
      writer.closing = closePart(writer, handle);
      return writer.closing;
    },
  });
}

/**
 * Open all four pre-existing, single-link reserved files before creating writers.
 * destinations maps each role to {name: basename, identity: {dev, ino} strings}.
 * transfer is a trusted, narrow test seam with FileHandle read/write signatures.
 * Native failures are replaced with closed codes; root paths are never diagnostics.
 */
async function openRecordParts({ root, destinations, transfer }, selected) {
  const opened = [];
  const owned = [];
  try {
    requireAcquisition(destinations && Object.keys(destinations).sort().join() === [...selected].sort().join(), "FILE_DESTINATION");
    requireAcquisition(typeof transfer.write === "function", "FILE_DESTINATION");
    const rootIdentity = await ownedRoot(root);
    const seen = new Set();
    for (const role of selected) {
      const part = await openPart(root, role, destinations[role], owned);
      opened.push(part);
      requireAcquisition(!seen.has(part.identity), "FILE_ALIAS");
      seen.add(part.identity);
    }
    identityMatches(await lstat(root, { bigint: true }), rootIdentity);
    const writers = Object.fromEntries(selected.map((role, index) => [role,
      partWriter(role, opened[index].handle, transfer, opened[index].identity)]));
    return Object.freeze({ writers: Object.freeze(writers),
      readHeader() {
        requireAcquisition(writers.header !== undefined, "WRITER_STOPPED");
        return writers.header.readHeader();
      },
      async close() {
        const snapshots = await Promise.all(selected.map(role => writers[role].close()));
        return Object.fromEntries(selected.map((role, index) => [role, snapshots[index]]));
      },
    });
  } catch (error) {
    const failure = closedError(error, "OPEN_FAILED");
    failure.cleanup = await closeHandles(owned);
    throw failure;
  }
}

export async function openAcquisitionRecord({ root, destinations, transfer = nativeTransfer }) {
  return openRecordParts({ root, destinations, transfer }, roles);
}

/**
 * Open only one actor's assigned parts. The preparer must first validate the
 * complete set with openAcquisitionRecord and close those preparer handles.
 * This rechecks the assigned native identities; it is not filesystem isolation.
 */
export function openAcquisitionActorRecord({ role, root, destinations, transfer = nativeTransfer }) {
  requireAcquisition(Object.hasOwn(ACQUISITION_ACTOR_PARTS, role), "FILE_DESTINATION");
  return openRecordParts({ root, destinations, transfer }, ACQUISITION_ACTOR_PARTS[role]);
}

/**
 * Read an explicitly confirmed range after the owner has stopped writing.
 * range: {confirmedBytes: bounded integer|null, state, uncertain: boolean}.
 * null means unknown, so no bytes are read. Preallocated size/zeros never supply length.
 * Caller metadata is not authenticated. A read does not certify external closure.
 */
export async function readAcquisitionPart({ root, role, destination, range, transfer = nativeTransfer }) {
  requireAcquisition(Object.hasOwn(ACQUISITION_LIMITS, role) && range
    && ["pending", "complete", "incomplete", "limit", "unknown"].includes(range.state)
    && typeof range.uncertain === "boolean", "READ_RANGE");
  const length = range.confirmedBytes;
  requireAcquisition(length === null || (Number.isSafeInteger(length) && length >= 0
    && length <= ACQUISITION_LIMITS[role]), "READ_RANGE");
  requireAcquisition(length !== null || range.state !== "complete", "READ_RANGE");
  requireAcquisition(typeof transfer.read === "function", "READ_RANGE");
  let opened;
  let result;
  let failure;
  const owned = [];
  try {
    const rootIdentity = await ownedRoot(root);
    opened = await openPart(root, role, destination, owned);
    identityMatches(await lstat(root, { bigint: true }), rootIdentity);
    const prefix = await readPrefix(opened.handle, length, transfer);
    const { readError } = prefix;
    result = { ...prefix, state: readError || length === null ? "unknown" : range.state,
      uncertain: range.uncertain || readError !== null || length === null,
      confirmedBytes: length };
  } catch (error) { failure = closedError(error, "READ_FAILED"); }
  const cleanup = await closeHandles(owned);
  if (failure) { failure.cleanup = cleanup; throw failure; }
  if (cleanup.closedHandles !== cleanup.openedHandles) {
    result.state = "unknown";
    result.uncertain = true;
    result.readError ??= "CLOSE_FAILED";
  }
  return { ...result, cleanup };
}
