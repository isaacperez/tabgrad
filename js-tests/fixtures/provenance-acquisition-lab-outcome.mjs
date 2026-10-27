import { acquisitionSha256 } from "../../scripts/provenance-acquisition-record.mjs";

/** Independent finite ending observations, not native integration or qualification evidence. */
export function diagnosticEnding(kind = "A") {
  const prefix = bytes => ({ confirmedBytes: bytes.length, sha256: acquisitionSha256(bytes), uncertain: false });
  const program = { stdout: prefix(Buffer.from([0, 65, 255, 10])), stderr: prefix(Buffer.from([254, 0, 66, 13])) };
  const empty = () => prefix(Buffer.alloc(0));
  const actor = writes => ({ localClosed: true, host: { ioClosed: "closed" }, writes });
  const child = () => ({ state: "closed", exitCode: 0, signal: null, firstError: null, channelError: null, finishAck: true });
  const firstFailure = kind === "A" ? null : kind === "B" ? "CAPTURE_ATTEMPT_LAUNCH" : "ACQ_ATTEMPT_GATE";
  const cause = kind === "A" ? null : { actor: kind === "C" ? "guard" : "supervisor", code: kind === "C" ? "deadline" : "controller" };
  const channels = values => ({ ioClosed: "closed", ioPending: 0, channels: values });
  return { finished: true, localComplete: kind === "A", firstFailure, cleanupError: kind === "A" ? null : "ACQ_ATTEMPT_CONTROLS",
    workPending: false, placementPending: false, auxiliaryClosePending: false, controlsClosePending: false, cleanupWaitExpired: false,
    activation: { protocolComplete: true, effectState: "unknown", transportClosed: true, workPending: false },
    placement: { executionObserved: kind === "A", firstFailure: kind === "A" ? null : "PLACEMENT_STOPPED",
      sources: { R: { launcherPid: "2" }, S: { launcherPid: "2", childPid: "3" } },
      io: { ioClosed: "closed", ioPending: false, subjects: { init: { pid: "1001", namespacePids: ["1001", "1"] },
        launcher: { pid: "1002", namespacePids: ["1002", "2"] }, program: { pid: "1003", ppid: "1002", namespacePids: ["1003", "3"] } } } },
    capture: { finished: true, localComplete: kind === "A", firstFailure, cleanupError: null, cleanupWaitExpired: false,
      flowPending: false, opening: false, exec: { protocolComplete: true, transportClosed: true, workPending: false,
        after: { reportedExitCode: kind === "B" ? 7 : 0 } }, fifo: { ioClosed: "closed", pendingEffects: 0 },
      files: { pendingEffects: 0, cleanupError: null, program: channels(program), daemon: channels({ stdout: empty(), stderr: empty() }),
        control: channels({ control: empty() }) },
      control: { observations: kind === "B" ? { X: { exitCode: 7 }, E: { exitCode: 7, cleanupError: null, fds: "cc" } } : {} } },
    controls: { finished: true, firstFailure: cause, guard: { closed: true, exitCode: 0, signal: null, channelError: null,
      phase: "settled", report: { ioClosed: "closed", firstFailure: kind === "C" ? "HOST_DEADLINE" : "HOST_CONTROLLER",
        observation: { frozen: true, populated: false } } },
    process: { children: { supervisor: child(), watchdog: child() }, collection: { formatComplete: true },
      actors: { supervisor: actor({ header: empty(), progress: empty(), supervisor: empty() }), watchdog: actor({ watchdog: empty() }) } } },
    controlsResult: { finished: true, firstFailure: cause, process: { parts: Object.fromEntries(["header", "progress", "supervisor", "watchdog"]
      .map(role => [role, { bytes: Buffer.alloc(0), confirmedBytes: 0 }])) } } };
}
