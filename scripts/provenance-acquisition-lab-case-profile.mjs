import { join } from "node:path";
import { ACQUISITION_LIMITS, acquisitionSha256, encodeAcquisitionRecord, isAcquisitionUint, isAcquisitionUtc,
  requireAcquisition } from "./provenance-acquisition-record.mjs";
import { copyHostProfile, freezeHostData } from "./provenance-acquisition-host-profile.mjs";
import { encodeLaunchProfile } from "./provenance-acquisition-launch-profile.mjs";
import { describeExecRequest } from "./provenance-acquisition-exec-profile.mjs";
import { labPaths } from "./provenance-acquisition-lab-profile.mjs";
import { LAB_CONTAINER_INPUT, LAB_CONTAINER_IPC } from "./provenance-acquisition-lab-container.mjs";
import { labDiagnosticProgram } from "./provenance-acquisition-lab-diagnostic-program.mjs";
import { ACQUISITION_PAYLOAD_LIMITS } from "./provenance-acquisition-payload.mjs";
import { LAUNCH_CONTROL_LIMITS } from "./provenance-acquisition-launch-protocol.mjs";

const destination = value => ({ name: value.name, identity: { ...value.identity } });
const hash = value => acquisitionSha256(JSON.stringify(value));
function payloadFiles(root, raw, prefix) {
  return { root, destinations: Object.fromEntries(["stdout", "stderr"].map(role => [role, destination(raw[`${prefix}.${role}`])])) };
}

/** Compose existing closed profiles over observed case objects; no synthetic identities or borrowed gate. */
export async function buildLabCaseProfiles({ lab, plan, kind, t0MonotonicNs, startedUtc, caseFiles, groups, container, socket, records }) {
  requireAcquisition(isAcquisitionUint(t0MonotonicNs) && isAcquisitionUtc(startedUtc), "LAB_INPUT");
  const operationId = plan.operations[kind]; const files = caseFiles.snapshot(); const t = plan.timing;
  requireAcquisition(files.operationId === operationId && !files.firstFailure && container.operationId === operationId, "LAB_IDENTITY");
  const diagnostic = labDiagnosticProgram(kind, plan.image.nodePath, t);
  const program = { binarySha256: plan.image.nodeSha256, argv: [...diagnostic.argv], env: [...diagnostic.env], workingDir: "/" };
  const launcher = { runtimePath: plan.image.nodePath, runtimeSha256: plan.image.nodeSha256,
    entryPath: `${LAB_CONTAINER_INPUT}/provenance-acquisition-launch.mjs`,
    entrySha256: plan.launcherFiles["provenance-acquisition-launch.mjs"].sha256, ...plan.credentials };
  const launch = { schemaVersion: 1, operationId, launcher, program,
    programRecipeSha256: hash({ program, credentials: plan.credentials }),
    ipc: { root: { path: LAB_CONTAINER_IPC, identity: { ...files.directories.ipc } }, ...files.fifo },
    timing: { t0MonotonicNs, workUntilNs: t.workUntilNs, closeUntilNs: t.observeUntilNs } };
  const launchBytes = encodeLaunchProfile(launch); const launchRecord = await caseFiles.writeInput("profile.json", launchBytes);
  const launcherProfile = { hostPath: join(files.paths.input, "profile.json"), containerPath: `${LAB_CONTAINER_INPUT}/profile.json`,
    identity: launchRecord.identity, bytes: launchBytes.length, sha256: acquisitionSha256(launchBytes) };
  const root = lab.roots.evidence.path;
  const recordCapture = { root, destinations: Object.fromEntries(Object.keys(ACQUISITION_LIMITS).map(role => [role, destination(files.raw[role])])) };
  const exec = { operationId, socket, containerId: container.id,
    command: { argv: [launcher.runtimePath, launcher.entryPath, launcherProfile.containerPath, launcherProfile.sha256,
      String(launcherProfile.bytes), launcherProfile.identity.dev, launcherProfile.identity.ino], env: [],
    user: `${plan.credentials.uid}:${plan.credentials.gid}`, workingDir: "/" },
    capture: payloadFiles(root, files.raw, "daemon"), timing: { t0MonotonicNs, deadlineNs: t.observeUntilNs,
      processBudgetNs: t.processBudgetNs, pollMs: t.pollMs, closeWaitMs: t.closeWaitMs },
    limits: { headerBytes: plan.limits.headerBytes, controlBytes: plan.limits.controlBytes } };
  const recipe = describeExecRequest(exec);
  const host = copyHostProfile({ operationId, t0MonotonicNs, stopAtNs: t.workUntilNs, observeUntilNs: t.observeUntilNs,
    pollMs: t.pollMs, root: lab.roots.cgroup, groups });
  const guardLabel = `${caseFiles.prefix}.guard.json`; const guard = await records.json(guardLabel, host);
  const profileSha256 = hash({ labProfileSha256: hash(lab), diagnosticPlanSha256: hash(plan), kind, t0MonotonicNs,
    container, files, launcherProfileSha256: launcherProfile.sha256, guardSha256: guard.sha256 });
  const header = { recordType: "acq_header_v1", operationId, state: "pending", ...plan.evidenceRefs, profileSha256,
    recipeSha256: recipe.recipeSha256, priorStateMode: "initial", priorStateSha256: null,
    declaredLimitsSha256: hash({ timing: t, limits: plan.limits, record: ACQUISITION_LIMITS,
      payload: ACQUISITION_PAYLOAD_LIMITS, control: LAUNCH_CONTROL_LIMITS }),
    t0MonotonicNs, startedUtc, deadlineUtc: new Date(Date.parse(startedUtc) + Number(BigInt(t.deadlineNs) / 1000000n)).toISOString() };
  const headerBytes = encodeAcquisitionRecord("header", header);
  const actorContext = { operationId, expectedHeaderSha256: acquisitionSha256(headerBytes), profileSha256,
    t0MonotonicNs, deadlineNs: t.deadlineNs };
  const context = { operationId, t0MonotonicNs, deadlineNs: t.deadlineNs, root };
  const capture = { exec, launcherProfile, ipcHostRoot: { path: files.paths.ipc, identity: { ...files.directories.ipc } },
    programCapture: payloadFiles(root, files.raw, "program"), controlCapture: { root, destination: destination(files.raw.control) }, recordCapture };
  return freezeHostData({ input: { capture,
    activation: { context, socket, containerId: container.id, preparedContainerSha256: container.preparedContainerSha256,
      pollMs: t.pollMs, limits: { headerBytes: plan.limits.headerBytes } },
    placement: { context, containerId: container.id, preparedContainerSha256: container.preparedContainerSha256,
      launcherProfileSha256: launcherProfile.sha256, hierarchy: { root: lab.roots.cgroup, case: groups.case },
      proc: lab.roots.proc, namespaces: lab.namespaces, clockPolicy: "monotonic_offsets",
      limits: { procsBytes: plan.limits.procsBytes, procBytes: lab.limits.observationBytes, maxProcesses: plan.limits.maxProcesses } } },
  startup: { process: { ...recordCapture, header, supervisorContext: { ...actorContext, role: "supervisor" }, watchdogContext: { ...actorContext, role: "watchdog" },
    host, timing: t.process }, guardProfile: { path: `${labPaths(lab).prefix}.${guardLabel}`, sha256: guard.sha256 } },
  expected: { kind, ...diagnostic }, profileSha256 });
}
