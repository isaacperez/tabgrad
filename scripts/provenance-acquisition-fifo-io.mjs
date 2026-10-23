import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { ownedRoot, identityMatches } from "./provenance-acquisition-file-io.mjs";
import { requireAcquisition } from "./provenance-acquisition-record.mjs";

export const FIFO_OPEN_FLAGS = Object.freeze({
  reader: constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  sentinel: constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
});

/** No create, blocking fallback or preparation. Caller adopts the handle before any await. */
export function openFifoEndpoint(path, kind) {
  requireAcquisition(Object.hasOwn(FIFO_OPEN_FLAGS, kind)
    && Number.isInteger(constants.O_NONBLOCK) && Number.isInteger(constants.O_NOFOLLOW), "FIFO_OPEN");
  return open(path, FIFO_OPEN_FLAGS[kind]);
}

export function verifyFifoStat(stat, expected) {
  requireAcquisition(stat.isFIFO(), "FIFO_IDENTITY");
  return identityMatches(stat, expected);
}

export const fifoNativePorts = Object.freeze({
  clock: () => process.hrtime.bigint(),
  root: async root => {
    const actual = await ownedRoot(root.path);
    requireAcquisition(actual.dev === root.identity.dev && actual.ino === root.identity.ino, "FIFO_ROOT");
  },
  open: openFifoEndpoint,
  read: (handle, buffer, length) => handle.read(buffer, 0, length, null),
  close: handle => handle.close(),
  schedule: (callback, ms) => ms === 0
    ? { kind: "immediate", handle: setImmediate(callback) }
    : { kind: "timeout", handle: setTimeout(callback, ms) },
  cancel: timer => timer.kind === "immediate" ? clearImmediate(timer.handle) : clearTimeout(timer.handle),
});
