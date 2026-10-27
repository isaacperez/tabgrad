import { constants as bufferConstants } from "node:buffer";
import { acquisitionFields as fields, isAcquisitionToken, isAcquisitionHash, isAcquisitionUint,
  requireAcquisition } from "./provenance-acquisition-record.mjs";
import { freezeHostData } from "./provenance-acquisition-host-profile.mjs";
import { launchPath, copyLaunchCredentials } from "./provenance-acquisition-launch-profile.mjs";
import { validateProcessTiming } from "./provenance-acquisition-process-protocol.mjs";
import { LAB_PROFILE_BYTES } from "./provenance-acquisition-lab-profile.mjs";

export const LAB_DIAGNOSTIC_CASES = Object.freeze(["A", "B", "C"]);
export const LAB_LAUNCH_FILES = Object.freeze(["provenance-acquisition-launch.mjs", "provenance-acquisition-launch-profile.mjs",
  "provenance-acquisition-launch-protocol.mjs", "provenance-acquisition-record.mjs", "provenance-acquisition-file-io.mjs"]);
const check = value => requireAcquisition(value, "LAB_INPUT");
const capacity = value => Number.isSafeInteger(value) && value > 0 && value < bufferConstants.MAX_LENGTH;
const duration = value => isAcquisitionUint(value) && value !== "0";

/** Fixed A/B/C inputs; syntax neither admits an image nor grants native authority. */
export function copyLabDiagnosticPlan(input) {
  check(fields(input, ["schemaVersion", "sourceRevision", "operations", "image", "launcherFiles", "credentials", "timing", "evidenceRefs", "limits"])
    && input.schemaVersion === 1 && typeof input.sourceRevision === "string" && /^[a-f0-9]{40}$/.test(input.sourceRevision)
    && fields(input.operations, LAB_DIAGNOSTIC_CASES) && Object.values(input.operations).every(isAcquisitionToken)
    && new Set(Object.values(input.operations)).size === 3
    && fields(input.image, ["archive", "id", "nodePath", "nodeSha256", "configSha256"])
    && typeof input.image.id === "string" && /^sha256:[a-f0-9]{64}$/.test(input.image.id) && isAcquisitionHash(input.image.nodeSha256)
    && isAcquisitionHash(input.image.configSha256)
    && fields(input.image.archive, ["path", "identity", "bytes", "sha256"])
    && fields(input.image.archive.identity, ["dev", "ino"])
    && Object.values(input.image.archive.identity).every(isAcquisitionUint) && input.image.archive.identity.ino !== "0"
    && capacity(input.image.archive.bytes) && isAcquisitionHash(input.image.archive.sha256)
    && fields(input.launcherFiles, LAB_LAUNCH_FILES));
  launchPath(input.image.archive.path); launchPath(input.image.nodePath);
  for (const file of Object.values(input.launcherFiles)) check(fields(file, ["bytes", "sha256"])
    && capacity(file.bytes) && isAcquisitionHash(file.sha256));
  copyLaunchCredentials(input.credentials);
  const t = input.timing;
  check(fields(t, ["deadlineNs", "workUntilNs", "observeUntilNs", "processBudgetNs", "holdMs", "descendantMs", "pollMs", "closeWaitMs", "process"])
    && [t.deadlineNs, t.workUntilNs, t.observeUntilNs, t.processBudgetNs].every(duration)
    && [t.deadlineNs, t.workUntilNs, t.observeUntilNs, t.processBudgetNs].every(v => BigInt(v) % 1000000n === 0n)
    && BigInt(t.deadlineNs) <= 180000000000n && BigInt(t.processBudgetNs) <= 120000000000n
    && BigInt(t.workUntilNs) <= 135000000000n && BigInt(t.processBudgetNs) < BigInt(t.workUntilNs)
    && BigInt(t.workUntilNs) < BigInt(t.observeUntilNs) && BigInt(t.observeUntilNs) < BigInt(t.deadlineNs)
    && [t.holdMs, t.descendantMs, t.pollMs, t.closeWaitMs].every(v => Number.isInteger(v) && v > 0 && v <= 2147483647)
    && t.pollMs <= 5000 && BigInt(t.holdMs) * 1000000n < BigInt(t.processBudgetNs)
    && BigInt(t.descendantMs) * 1000000n > BigInt(t.observeUntilNs));
  validateProcessTiming(t.process);
  check(BigInt(t.observeUntilNs) + BigInt(t.closeWaitMs + t.process.closeWaitMs) * 1000000n <= BigInt(t.deadlineNs));
  const e = input.evidenceRefs;
  check(fields(e, ["authorizationRef", "inputEvidenceSha256", "toolEvidenceSha256", "clockEvidenceSha256"])
    && isAcquisitionToken(e.authorizationRef) && [e.inputEvidenceSha256, e.toolEvidenceSha256, e.clockEvidenceSha256].every(isAcquisitionHash)
    && fields(input.limits, ["responseBytes", "headerBytes", "controlBytes", "procsBytes", "maxProcesses"])
    && Object.values(input.limits).every(capacity));
  const p = JSON.parse(JSON.stringify(input));
  check(Buffer.byteLength(JSON.stringify(p)) <= LAB_PROFILE_BYTES); return freezeHostData(p);
}
