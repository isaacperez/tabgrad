import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquisitionSha256 } from "../../scripts/provenance-acquisition-record.mjs";
import { createAcquisitionStartup } from "../../scripts/provenance-acquisition-startup.mjs";
import { createAcquisitionAttempt } from "../../scripts/provenance-acquisition-attempt.mjs";
import { captureFixture } from "./provenance-acquisition-capture-attempt.mjs";
import { hostProfile } from "./provenance-acquisition-host.mjs";

export const observedUtc = "2026-01-02T03:04:05.006Z";
const entry = new URL("./provenance-acquisition-startup-child.mjs", import.meta.url);

/** Actual startup/process owners; only their child's fixed host syscalls are synthetic. */
export async function preparedStartup(t, capture) {
  const { exec, recordCapture } = capture.input;
  const host = hostProfile(exec.timing.t0MonotonicNs);
  Object.assign(host, { stopAtNs: "3000000000", observeUntilNs: "3300000000", pollMs: 20 });
  const hash = "a".repeat(64);
  const header = { recordType: "acq_header_v1", operationId: exec.operationId, state: "pending", authorizationRef: "2".repeat(32),
    profileSha256: hash, recipeSha256: hash, inputEvidenceSha256: hash, toolEvidenceSha256: hash,
    priorStateMode: "initial", priorStateSha256: null, declaredLimitsSha256: hash,
    t0MonotonicNs: exec.timing.t0MonotonicNs, startedUtc: observedUtc, clockEvidenceSha256: hash, deadlineUtc: "2026-01-02T03:05:05.006Z" };
  const headerBytes = Buffer.from(JSON.stringify(header) + "\n");
  const context = role => ({ role, operationId: exec.operationId, expectedHeaderSha256: acquisitionSha256(headerBytes),
    profileSha256: hash, t0MonotonicNs: exec.timing.t0MonotonicNs, deadlineNs: exec.timing.deadlineNs });
  const guardPath = join(recordCapture.root, "host.profile");
  await writeFile(guardPath, JSON.stringify(host), { flag: "wx", mode: 0o600 });
  const children = []; const launches = [];
  const startup = await createAcquisitionStartup({ process: { ...recordCapture, header,
    supervisorContext: context("supervisor"), watchdogContext: context("watchdog"), host,
    timing: { heartbeatMs: 20, peerTimeoutMs: 1500, termAfterMs: 100, killAfterMs: 200, closeWaitMs: 500 } },
  guardProfile: { path: guardPath, sha256: acquisitionSha256(JSON.stringify(host)) } }, {
    forkActor(role, path, options) {
      assert(path.pathname.endsWith("/provenance-acquisition-startup-actor.mjs")); launches.push(role);
      const child = fork(entry, ["actor"], options); children.push(child); return child;
    },
    forkGuard(path, args, options) {
      assert(path.pathname.endsWith("/provenance-acquisition-startup-guard.mjs")); launches.push("guard");
      const child = fork(entry, ["guard", ...args], options); children.push(child); return child;
    },
  });
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await startup.finish({ observedUtc });
  });
  return { startup, launches, headerBytes };
}

/** Real capture files/peer with a finite startup port for scheduling/failure cutpoints. */
export async function attemptFixture(t, options = {}) {
  const f = await captureFixture(t, options.capture);
  const events = []; let ready = false; let finished = false; let firstFailure = null;
  const state = { starts: 0, stops: 0, finishes: 0, appends: 0 };
  const startup = { context: f.ports.gate.context,
    async start() { state.starts++; events.push("start"); await options.start?.(); ready = !options.deny; return this.snapshot(); },
    stop() { state.stops++; ready = false; firstFailure ??= { actor: "supervisor", code: "controller" }; options.stop?.(); },
    supervisor: { async append(event) { state.appends++; events.push("intent"); await options.append?.(event); } },
    async finish({ observedUtc: utc }) {
      state.finishes++; events.push("finish"); ready = false; await options.finish?.(utc); finished = true;
      return { finished, firstFailure: options.controlFailure ? { actor: "guard", code: "cleanup" } : firstFailure,
        process: { collection: { formatComplete: !options.badRecord } } };
    },
    snapshot() { return { mayStart: ready, finished, firstFailure }; },
  };
  const create = (factory = createAcquisitionAttempt) => f.create((input, ports) => {
    const { gate, ...capture } = ports;
    return factory(input, { startup, ...capture });
  });
  return { ...f, create, startup, state, events, get owner() { return f.owner; }, deny() { ready = false; } };
}
