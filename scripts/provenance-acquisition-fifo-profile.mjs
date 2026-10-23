import { basename, isAbsolute, join, resolve } from "node:path";
import { acquisitionFields as fields, isAcquisitionUint, requireAcquisition } from "./provenance-acquisition-record.mjs";
import { ACQUISITION_PAYLOAD_LIMITS } from "./provenance-acquisition-payload.mjs";
import { LAUNCH_CONTROL_LIMITS } from "./provenance-acquisition-launch-protocol.mjs";

export const FIFO_ROLES = Object.freeze(["stdout", "stderr", "control"]);
export const FIFO_LIMITS = Object.freeze({
  stdout: Object.freeze({ capacity: ACQUISITION_PAYLOAD_LIMITS.stdout, quantum: 16 * 1024 }),
  stderr: Object.freeze({ capacity: ACQUISITION_PAYLOAD_LIMITS.stderr, quantum: 16 * 1024 }),
  control: Object.freeze({ capacity: LAUNCH_CONTROL_LIMITS.total, quantum: LAUNCH_CONTROL_LIMITS.line }),
});

const check = condition => requireAcquisition(condition, "FIFO_INPUT");

function fifoText(value) {
  check(typeof value === "string" && value.isWellFormed() && !value.includes("\0") && Buffer.byteLength(value) <= 4096);
  return value;
}

function fifoPath(value) {
  fifoText(value);
  check(isAbsolute(value) && resolve(value) === value && value.split("/").filter(Boolean).length <= 64);
  return value;
}

function fifoIdentity(value) {
  check(fields(value, ["dev", "ino"]) && isAcquisitionUint(value.dev)
    && isAcquisitionUint(value.ino) && value.ino !== "0");
  return Object.freeze({ dev: value.dev, ino: value.ino });
}

/** Host-view IPC is independently admitted data, not a program/credential profile. */
export function copyFifoProfile(input) {
  check(fields(input, ["ipc", "timing"]) && fields(input.ipc, ["root", ...FIFO_ROLES]));
  const i = input.ipc;
  check(fields(i.root, ["path", "identity"]));
  const root = Object.freeze({ path: fifoPath(i.root.path), identity: fifoIdentity(i.root.identity) });
  const ipc = { root };
  const names = new Set(); const identities = new Set([`${root.identity.dev}:${root.identity.ino}`]);
  for (const role of FIFO_ROLES) {
    const e = i[role];
    check(fields(e, ["name", "identity"]));
    const name = fifoText(e.name);
    check(name !== "" && name !== "." && name !== ".." && basename(name) === name && !names.has(name));
    const identity = fifoIdentity(e.identity);
    const key = `${identity.dev}:${identity.ino}`;
    check(!identities.has(key));
    names.add(name); identities.add(key);
    ipc[role] = Object.freeze({ name, path: fifoPath(join(root.path, name)), identity });
  }
  const t = input.timing;
  check(fields(t, ["t0MonotonicNs", "workUntilNs", "closeUntilNs", "pollMs"])
    && ["t0MonotonicNs", "workUntilNs", "closeUntilNs"].every(k => isAcquisitionUint(t[k]))
    && BigInt(t.workUntilNs) > 0n && BigInt(t.workUntilNs) <= BigInt(t.closeUntilNs)
    && BigInt(t.closeUntilNs) <= 2147483647n * 1000000n
    && Number.isInteger(t.pollMs) && t.pollMs >= 1 && t.pollMs <= 5000);
  return Object.freeze({ ipc: Object.freeze(ipc), timing: Object.freeze({ ...t }) });
}
