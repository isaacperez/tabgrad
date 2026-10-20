import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { requireAcquisition } from "./provenance-acquisition-record.mjs";

/** Shared native file premises for record partitions and binary capture, not allocation/isolation. */
export function acquisitionFileIdentity(stat) {
  requireAcquisition(typeof stat.dev === "bigint" && typeof stat.ino === "bigint"
    && stat.dev >= 0n && stat.ino > 0n, "FILE_IDENTITY");
  return Object.freeze({ dev: stat.dev.toString(), ino: stat.ino.toString() });
}

export function identityMatches(stat, expected) {
  const actual = acquisitionFileIdentity(stat);
  requireAcquisition(expected && actual.dev === expected.dev && actual.ino === expected.ino, "FILE_IDENTITY");
  return `${actual.dev}:${actual.ino}`;
}

export async function ownedRoot(root) {
  requireAcquisition(typeof root === "string" && isAbsolute(root) && resolve(root) === root, "FILE_ROOT");
  const before = await lstat(root, { bigint: true });
  requireAcquisition(before.isDirectory() && !before.isSymbolicLink(), "FILE_ROOT");
  requireAcquisition(await realpath(root) === root, "FILE_ROOT");
  return acquisitionFileIdentity(before);
}

/** Caller supplies a fixed role capacity and retains every opened handle even on failure. */
export async function openOwnedAcquisitionFile(root, destination, capacity, owned) {
  requireAcquisition(destination && typeof destination.name === "string"
    && destination.name !== "." && destination.name !== ".."
    && basename(destination.name) === destination.name && destination.name.length > 0, "FILE_DESTINATION");
  requireAcquisition(Number.isInteger(constants.O_NOFOLLOW), "FILE_IDENTITY");
  const handle = await open(join(root, destination.name), constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  owned.push(handle);
  const stat = await handle.stat({ bigint: true });
  requireAcquisition(stat.isFile() && stat.nlink === 1n && stat.size === BigInt(capacity), "FILE_DESTINATION");
  const identity = identityMatches(stat, destination.identity);
  return { handle, identity };
}

export async function closeHandles(handles) {
  const results = await Promise.allSettled(handles.map(handle => handle.close()));
  return { openedHandles: handles.length,
    closedHandles: results.filter(result => result.status === "fulfilled").length };
}
