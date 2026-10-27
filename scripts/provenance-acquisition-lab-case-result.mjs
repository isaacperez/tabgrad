import { acquisitionSha256 } from "./provenance-acquisition-record.mjs";
import { freezeHostData } from "./provenance-acquisition-host-profile.mjs";

/** Explicit metadata projection: record bytes already have their own nine original files. */
export function labCaseAttemptMetadata(state) {
  const result = state.controlsResult;
  if (!result?.process?.parts) return state;
  const parts = Object.fromEntries(Object.entries(result.process.parts).map(([role, value]) => {
    const { bytes, ...metadata } = value;
    return [role, { ...metadata, collectedSha256: acquisitionSha256(bytes) }];
  }));
  return freezeHostData({ ...state, controlsResult: { ...result, process: { ...result.process, parts } } });
}

/** Last confirmed prefixes, including explicit unavailable producer observations; never infer padding. */
export function labCasePrefixes(files, state) {
  const output = {};
  for (const [part, file] of Object.entries(files.raw)) {
    let observed;
    if (part.includes(".")) {
      const [group, role] = part.split("."); observed = state?.capture?.files?.[group]?.channels?.[role];
    } else if (part === "control") observed = state?.capture?.files?.control?.channels?.control;
    else observed = state?.controls?.process?.actors?.[part === "watchdog" ? "watchdog" : "supervisor"]?.writes?.[part];
    output[part] = { name: file.name, identity: file.identity, capacity: file.capacity,
      confirmedBytes: observed?.confirmedBytes ?? 0, sha256: observed?.sha256 ?? acquisitionSha256(Buffer.alloc(0)),
      producerObservation: observed ? "observed" : "unavailable", uncertain: observed?.uncertain ?? true,
      continuation: "unknown_after_last_observation" };
  }
  return freezeHostData(output);
}

/** Local joins only. The later exterior producer-domain boundary remains a different observation. */
export function labCaseLocallyJoined(state) {
  const capture = state?.capture; const controls = state?.controls;
  // The aggregate deliberately marks a controller/deadline ending as a control failure.
  // That original remains visible. It alone says nothing about descriptor/process joins.
  const cause = controls?.firstFailure?.code;
  const semanticControlEnd = state?.cleanupError === "ACQ_ATTEMPT_CONTROLS"
    && ["controller", "deadline"].includes(cause) && state.controlsResult?.finished === true
    && ["controller", "deadline"].includes(state.controlsResult.firstFailure?.code);
  return state?.finished === true && !state.workPending && !state.placementPending && !state.auxiliaryClosePending
    && !state.controlsClosePending && !state.cleanupWaitExpired && (!state.cleanupError || semanticControlEnd)
    && state.activation?.transportClosed === true && !state.activation.workPending
    && state.placement?.io?.ioClosed === "closed" && !state.placement.io.ioPending
    && capture?.finished === true && !capture.flowPending && !capture.opening && !capture.cleanupError && !capture.cleanupWaitExpired
    && capture.exec?.transportClosed === true && !capture.exec.workPending
    && capture.fifo?.ioClosed === "closed" && capture.fifo.pendingEffects === 0
    && capture.files?.pendingEffects === 0 && !capture.files.cleanupError
    && ["program", "daemon", "control"].every(role => capture.files[role]?.ioClosed === "closed" && capture.files[role].ioPending === 0)
    && controls?.finished === true && controls.guard?.closed === true && controls.guard.exitCode === 0
    && controls.guard.signal === null && !controls.guard.channelError
    && controls.guard.phase === "settled" && controls.guard.report?.ioClosed === "closed"
    && Object.values(controls.process?.children ?? {}).length === 2
    && Object.values(controls.process.children).every(child => child.state === "closed" && child.exitCode === 0
      && child.signal === null && !child.firstError && !child.channelError && (child.finishAck || child.finalReceipt))
    && ["supervisor", "watchdog"].every(role => controls.process.actors?.[role]?.localClosed === true
      && controls.process.actors[role].host?.ioClosed === "closed")
    && controls.process.collection?.formatComplete === true;
}

/** A diagnostic expectation remains separate from successful capture and exterior retirement. */
export function labCaseOutcome(kind, state) {
  const program = state?.capture?.files?.program?.channels;
  const stdout = program?.stdout; const stderr = program?.stderr;
  const prefixMatches = stdout?.confirmedBytes === 4 && stderr?.confirmedBytes === 4
    && stdout.sha256 === acquisitionSha256(Buffer.from([0, 65, 255, 10]))
    && stderr.sha256 === acquisitionSha256(Buffer.from([254, 0, 66, 13]));
  const observation = state?.capture?.control?.observations;
  const after = state?.capture?.exec?.after;
  const p = state?.placement;
  // Revocation intentionally clears permission/executionObserved in the existing owner.
  // Its successful identified reads and launch bindings survive a STOPPED ending.
  const beforeStop = p?.firstFailure === "PLACEMENT_STOPPED" && p.sources?.R && p.sources?.S
    && p.io?.subjects?.init && p.io.subjects.launcher?.namespacePids?.at(-1) === p.sources.R.launcherPid
    && p.io.subjects.program?.namespacePids?.at(-1) === p.sources.S.childPid
    && p.io.subjects.program.ppid === p.io.subjects.launcher.pid && p.sources.R.launcherPid === p.sources.S.launcherPid;
  const placement = p?.executionObserved === true || !!beforeStop;
  const joined = labCaseLocallyJoined(state);
  let expected = false;
  if (kind === "A") expected = joined && placement && prefixMatches && state.localComplete === true;
  if (kind === "B") expected = joined && placement && prefixMatches && state.firstFailure === "CAPTURE_ATTEMPT_LAUNCH"
    && state.capture.exec.protocolComplete === true
    && after?.reportedExitCode === 7 && observation?.X?.exitCode === 7 && observation?.E?.exitCode === 7
    && !observation.F && observation.E.cleanupError === null && observation.E.fds === "cc"
    && state.capture.firstFailure === "CAPTURE_ATTEMPT_LAUNCH" && !state.capture.cleanupError;
  if (kind === "C") {
    const guard = state?.controls?.guard; const report = guard?.report;
    expected = joined && placement && prefixMatches && state.firstFailure === "ACQ_ATTEMPT_GATE" && report?.firstFailure === "HOST_DEADLINE"
      && report.observation?.frozen === true && report.observation.populated === false
      && guard.closed === true && guard.exitCode === 0;
  }
  return Object.freeze({ kind, expected, prefixMatches, placementObservedBeforeStop: !!beforeStop, localCaptureComplete: state?.capture?.localComplete === true,
    firstFailure: state?.firstFailure ?? null, cleanupError: state?.cleanupError ?? null,
    caseRetirement: "unknown", exteriorRetirement: "not_observed", releaseAdmission: "unqualified" });
}
