import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  acquisitionSha256, isAcquisitionHash, AcquisitionRecordError, requireAcquisition,
} from "./provenance-acquisition-record.mjs";
import { copyHostProfile } from "./provenance-acquisition-host-profile.mjs";
import { createAcquisitionHostController } from "./provenance-acquisition-host.mjs";

export const HOST_PROFILE_FILE_LIMIT = 32 * 1024;
const waitNative = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Separate entry has no parent-channel lease. Joining native work is not a physical-time guarantee. */
export async function runAcquisitionHostGuard(profile, {
  clock = () => process.hrtime.bigint(), wait = waitNative, createController = createAcquisitionHostController, onArmed = null,
} = {}) {
  const p = copyHostProfile(profile);
  requireAcquisition(typeof clock === "function" && typeof wait === "function" && typeof createController === "function"
    && (onArmed === null || typeof onArmed === "function"), "HOST_INPUT");
  const controller = await createController(p, "guard", { clock });
  // One trusted nonblocking notification; a missing receipt cannot admit later work.
  try { if (onArmed) onArmed(controller.snapshot()); }
  catch { controller.contain("channel"); }
  let observing = false;
  // Read work may stall. Neither a sample nor a freeze completion blocks the deadline loop.
  for (;;) {
    const at = controller.check();
    if (at === null || BigInt(at) >= BigInt(p.observeUntilNs)) break;
    if (!observing) {
      observing = true;
      void controller.poll().finally(() => { observing = false; }).catch(() => {});
    }
    const boundary = BigInt(at) < BigInt(p.stopAtNs) ? BigInt(p.stopAtNs) : BigInt(p.observeUntilNs);
    const remainingMs = (boundary - BigInt(at) + 999999n) / 1000000n;
    await wait(Math.max(1, Math.min(p.pollMs, Number(remainingMs))));
  }
  // Preserve the final wait-boundary observation; do not rewrite it when native callbacks arrive later.
  const closing = controller.close();
  void closing.catch(() => {});
  return Object.freeze({ observation: controller.snapshot(), settled: closing });
}

export async function readHostGuardProfile(path, expectedSha256) {
  requireAcquisition(typeof path === "string" && isAcquisitionHash(expectedSha256), "HOST_INPUT");
  let handle;
  let result;
  let failure;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat({ bigint: true });
    requireAcquisition(stat.isFile() && stat.nlink === 1n && stat.size > 0n && stat.size <= BigInt(HOST_PROFILE_FILE_LIMIT), "HOST_INPUT");
    const bytes = Buffer.alloc(Number(stat.size));
    let at = 0;
    while (at < bytes.length) {
      const r = await handle.read(bytes, at, bytes.length - at, at);
      requireAcquisition(r.bytesRead > 0 && r.bytesRead <= bytes.length - at, "HOST_READ");
      at += r.bytesRead;
    }
    const finalStat = await handle.stat({ bigint: true });
    requireAcquisition((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead === 0
      && finalStat.size === stat.size && finalStat.nlink === 1n, "HOST_INPUT");
    requireAcquisition(acquisitionSha256(bytes) === expectedSha256, "HOST_INPUT");
    const text = bytes.toString("utf8");
    requireAcquisition(Buffer.from(text, "utf8").equals(bytes), "HOST_INPUT");
    const parsed = JSON.parse(text);
    requireAcquisition(JSON.stringify(parsed) === text, "HOST_INPUT");
    result = copyHostProfile(parsed);
  } catch (error) { failure = new AcquisitionRecordError(error instanceof AcquisitionRecordError ? error.code : "HOST_INPUT"); }
  if (handle) {
    try { await handle.close(); }
    catch {
      failure ??= new AcquisitionRecordError("HOST_CLOSE");
      failure.closeError = "HOST_CLOSE";
    }
  }
  if (failure) throw failure;
  return result;
}

/** Explicit future bootstrap invocation: config path plus independently supplied exact digest. */
export async function hostGuardMain(args = process.argv.slice(2), send = process.send?.bind(process)) {
  requireAcquisition(args.length === 2, "HOST_INPUT");
  const profile = await readHostGuardProfile(args[0], args[1]);
  const result = await runAcquisitionHostGuard(profile, { onArmed: observation => {
    if (send && process.connected) send(JSON.stringify({ phase: "armed", observation }), () => {});
  } });
  if (send && process.connected) await new Promise((resolve, reject) => {
    send(JSON.stringify({ phase: "boundary", observation: result.observation }), error => error ? reject(new AcquisitionRecordError("HOST_CHANNEL")) : resolve());
  });
  if (process.connected) process.disconnect();
  // A pending native close may keep the process alive; no completed-termination claim follows.
  void result.settled.catch(() => {});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  hostGuardMain().catch(() => { process.exitCode = 1; });
}
