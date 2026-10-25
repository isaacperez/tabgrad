import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { acquisitionFields as fields, isAcquisitionHash, isAcquisitionUint, requireAcquisition } from "./provenance-acquisition-record.mjs";
import { copyExecAttemptProfile } from "./provenance-acquisition-exec-profile.mjs";
import { launchPath, LAUNCH_PROFILE_LIMIT } from "./provenance-acquisition-launch-profile.mjs";

const check = value => requireAcquisition(value, "CAPTURE_ATTEMPT_INPUT");
const fileKey = value => `${value.dev}:${value.ino}`;
function identity(value) {
  check(fields(value, ["dev", "ino"]) && isAcquisitionUint(value.dev) && isAcquisitionUint(value.ino) && value.ino !== "0");
  return Object.freeze({ dev: value.dev, ino: value.ino });
}
function destination(value) {
  check(fields(value, ["name", "identity"]) && typeof value.name === "string" && value.name.isWellFormed()
    && value.name !== "." && value.name !== ".." && value.name.length > 0 && !value.name.includes("\0")
    && basename(value.name) === value.name);
  return Object.freeze({ name: value.name, identity: identity(value.identity) });
}
function files(value, roles, root) {
  check(fields(value, ["root", "destinations"]) && value.root === root && fields(value.destinations, roles));
  return Object.freeze({ root, destinations: Object.freeze(Object.fromEntries(roles.map(role => {
    const d = destination(value.destinations[role]); launchPath(join(root, d.name)); return [role, d];
  }))) });
}

/** Closed independent data only. The four record reserves remain owned by the caller. */
export function copyCaptureAttemptProfile(input, gate) {
  check(fields(input, ["exec", "launcherProfile", "ipcHostRoot", "programCapture", "controlCapture", "recordCapture"]));
  const exec = copyExecAttemptProfile(input.exec, gate);
  const root = launchPath(exec.capture.root);
  const daemon = files(exec.capture, ["stdout", "stderr"], root);
  const program = files(input.programCapture, ["stdout", "stderr"], root);
  const record = files(input.recordCapture, ["header", "progress", "supervisor", "watchdog"], root);
  check(fields(input.controlCapture, ["root", "destination"]) && input.controlCapture.root === root);
  const control = Object.freeze({ root, destination: destination(input.controlCapture.destination) });
  launchPath(join(root, control.destination.name));
  const f = input.launcherProfile;
  check(fields(f, ["hostPath", "containerPath", "identity", "sha256", "bytes"])
    && isAcquisitionHash(f.sha256) && Number.isInteger(f.bytes) && f.bytes > 0 && f.bytes <= LAUNCH_PROFILE_LIMIT);
  const launcherProfile = Object.freeze({ hostPath: launchPath(f.hostPath), containerPath: launchPath(f.containerPath),
    identity: identity(f.identity), sha256: f.sha256, bytes: f.bytes });
  check(fields(input.ipcHostRoot, ["path", "identity"]));
  const ipcHostRoot = Object.freeze({ path: launchPath(input.ipcHostRoot.path), identity: identity(input.ipcHostRoot.identity) });
  check(ipcHostRoot.path !== root && BigInt(exec.timing.deadlineNs) <= 180000000000n
    && BigInt(exec.timing.processBudgetNs) <= 120000000000n);
  const all = [...Object.values(daemon.destinations), ...Object.values(program.destinations),
    control.destination, ...Object.values(record.destinations)];
  check(new Set(all.map(d => d.name)).size === 9 && new Set(all.map(d => fileKey(d.identity))).size === 9
    && all.every(d => fileKey(d.identity) !== fileKey(launcherProfile.identity)));
  return Object.freeze({ exec: Object.freeze({ ...exec, capture: daemon,
    command: Object.freeze({ ...exec.command, argv: Object.freeze(exec.command.argv), env: Object.freeze(exec.command.env) }),
    timing: Object.freeze(exec.timing), limits: Object.freeze(exec.limits) }),
  launcherProfile, ipcHostRoot, programCapture: program, controlCapture: control, recordCapture: record });
}

/** Hashes bind three distinct recipes; matching paths alone never supplies that binding. */
export function bindCaptureLaunch(p, launch) {
  const l = launch.profile;
  const f = p.launcherProfile;
  check(l.operationId === p.exec.operationId && l.timing.t0MonotonicNs === p.exec.timing.t0MonotonicNs
    && BigInt(l.timing.workUntilNs) <= 135000000000n
    && BigInt(l.timing.closeUntilNs) <= BigInt(p.exec.timing.deadlineNs)
    && p.ipcHostRoot.identity.dev === l.ipc.root.identity.dev && p.ipcHostRoot.identity.ino === l.ipc.root.identity.ino
    && isDeepStrictEqual(p.exec.command.argv, [l.launcher.runtimePath, l.launcher.entryPath, f.containerPath,
      f.sha256, String(f.bytes), f.identity.dev, f.identity.ino])
    && p.exec.command.user === `${l.launcher.uid}:${l.launcher.gid}`);
  return Object.freeze({ ipc: Object.freeze({ ...l.ipc, root: p.ipcHostRoot }),
    timing: Object.freeze({ ...l.timing, pollMs: p.exec.timing.pollMs }) });
}
