import { isAbsolute, resolve, posix } from "node:path";
import { constants as bufferConstants } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import { parseAcquisitionJson } from "./provenance-acquisition-json.mjs";
import {
  acquisitionFields as fields, requireAcquisition,
  isAcquisitionToken, isAcquisitionUint, acquisitionSha256,
} from "./provenance-acquisition-record.mjs";

const id = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const budget = value => Number.isSafeInteger(value) && value > 0 && value <= bufferConstants.MAX_LENGTH;
const text = value => typeof value === "string" && !value.includes("\0");

function strings(value, allowance, nonempty = false) {
  requireAcquisition(Array.isArray(value) && value.length <= allowance
    && Reflect.ownKeys(value).length === value.length + 1 && (!nonempty || value.length > 0), "EXEC_INPUT");
  let bytes = 0;
  const result = [];
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    requireAcquisition(d && Object.hasOwn(d, "value") && text(d.value), "EXEC_INPUT");
    bytes += Buffer.byteLength(d.value) + 2;
    requireAcquisition(bytes <= allowance, "EXEC_INPUT");
    result.push(d.value);
  }
  return result;
}

function commandProfile(input) {
  requireAcquisition(fields(input, ["operationId", "socket", "containerId", "command", "capture", "timing", "limits"])
    && isAcquisitionToken(input.operationId) && id(input.containerId)
    && fields(input.socket, ["path", "identity"]) && fields(input.socket.identity, ["dev", "ino"])
    && text(input.socket.path) && isAbsolute(input.socket.path) && resolve(input.socket.path) === input.socket.path
    && isAcquisitionUint(input.socket.identity.dev) && isAcquisitionUint(input.socket.identity.ino) && input.socket.identity.ino !== "0"
    && fields(input.limits, ["headerBytes", "controlBytes"])
    && Object.values(input.limits).every(budget)
    && fields(input.timing, ["t0MonotonicNs", "deadlineNs", "processBudgetNs", "pollMs", "closeWaitMs"])
    && ["t0MonotonicNs", "deadlineNs", "processBudgetNs"].every(k => isAcquisitionUint(input.timing[k]))
    && input.timing.deadlineNs !== "0" && input.timing.processBudgetNs !== "0"
    && ["pollMs", "closeWaitMs"].every(k => Number.isInteger(input.timing[k]) && input.timing[k] > 0 && input.timing[k] <= 2147483647)
    && input.timing.pollMs <= 5000
    && fields(input.command, ["argv", "env", "user", "workingDir"])
    && text(input.command.user) && input.command.user.length > 0
    && text(input.command.workingDir) && posix.isAbsolute(input.command.workingDir)
    && posix.resolve(input.command.workingDir) === input.command.workingDir
    && fields(input.capture, ["root", "destinations"]), "EXEC_INPUT");
  const command = { argv: strings(input.command.argv, input.limits.controlBytes, true),
    env: strings(input.command.env, input.limits.controlBytes), user: input.command.user, workingDir: input.command.workingDir };
  requireAcquisition(command.argv[0].length > 0
    && Buffer.byteLength(command.user) <= input.limits.controlBytes
    && Buffer.byteLength(command.workingDir) <= input.limits.controlBytes
    && command.env.every(e => /^[A-Za-z_][A-Za-z0-9_]*=/.test(e))
    && new Set(command.env.map(e => e.slice(0, e.indexOf("=")))).size === command.env.length, "EXEC_INPUT");
  const body = Buffer.from(JSON.stringify({ AttachStdin: false, AttachStdout: true, AttachStderr: true,
    Tty: false, Privileged: false, Cmd: command.argv, Env: command.env, User: command.user, WorkingDir: command.workingDir }));
  requireAcquisition(body.length <= input.limits.controlBytes, "EXEC_INPUT");
  return { command, body };
}

function matchesContext(input, binding) {
  return fields(binding, ["operationId", "t0MonotonicNs", "deadlineNs", "root"])
    && binding.operationId === input.operationId && binding.t0MonotonicNs === input.timing.t0MonotonicNs
    && isAcquisitionUint(binding.deadlineNs) && BigInt(input.timing.deadlineNs) <= BigInt(binding.deadlineNs)
    && binding.root === input.capture.root;
}

function copiedProfile(input, { command, body }) {
  return { operationId: input.operationId, socket: { path: input.socket.path, identity: { ...input.socket.identity } },
    containerId: input.containerId, command, body, recipeSha256: acquisitionSha256(body),
    capture: input.capture, timing: { ...input.timing }, limits: { ...input.limits } };
}

/** Concrete preparations can bind the exact request recipe before constructing a borrowed gate. */
export function describeExecRequest(input) {
  const { body } = commandProfile(input);
  return Object.freeze({ body: Buffer.from(body), recipeSha256: acquisitionSha256(body) });
}

/** Preserve data validation, startup observations, then final copying in that order. */
export function copyExecProfile(input, startup) {
  const command = commandProfile(input);
  const binding = startup?.context;
  requireAcquisition(matchesContext(input, binding)
    && ["start", "stop", "finish", "snapshot"].every(k => typeof startup[k] === "function")
    && typeof startup.supervisor?.append === "function", "EXEC_INPUT");
  return copiedProfile(input, command);
}

/** A borrowed gate has no startup/finish authority. Limits remain declared budgets. */
export function copyExecAttemptProfile(input, gate) {
  const command = commandProfile(input);
  requireAcquisition(fields(gate, ["context", "check", "appendIntent", "revoke"])
    && matchesContext(input, gate.context)
    && text(gate.context.root) && isAbsolute(gate.context.root) && resolve(gate.context.root) === gate.context.root
    && ["check", "appendIntent", "revoke"].every(k => typeof gate[k] === "function"), "EXEC_INPUT");
  return copiedProfile(input, command);
}

export function parseExecMetadata(bytes) {
  return parseAcquisitionJson(bytes, "EXEC_PROTOCOL");
}

export function createdExec(bytes) {
  const data = parseExecMetadata(bytes);
  requireAcquisition(fields(data, ["Id"]) && id(data.Id), "EXEC_IDENTITY");
  return data.Id;
}

export function inspectedExec(bytes, profile, execId, before) {
  const data = parseExecMetadata(bytes);
  const pc = data?.ProcessConfig;
  requireAcquisition(fields(data, ["CanRemove", "DetachKeys", "ID", "Running", "ExitCode", "ProcessConfig",
    "OpenStdin", "OpenStderr", "OpenStdout", "ContainerID", "Pid"])
    && fields(pc, ["tty", "entrypoint", "arguments", "privileged", "user"])
    && data.ID === execId && data.ContainerID === profile.containerId
    && data.OpenStdin === false && data.OpenStdout === true && data.OpenStderr === true
    && data.DetachKeys === "" && (before ? data.CanRemove === false : typeof data.CanRemove === "boolean")
    && pc.tty === false && pc.privileged === false
    && pc.user === profile.command.user && pc.entrypoint === profile.command.argv[0]
    && isDeepStrictEqual(pc.arguments ?? [], profile.command.argv.slice(1))
    && typeof data.Running === "boolean" && Number.isSafeInteger(data.Pid) && data.Pid >= 0
    && (data.ExitCode === null || Number.isSafeInteger(data.ExitCode) && data.ExitCode >= 0), "EXEC_IDENTITY");
  requireAcquisition(before ? !data.Running && data.Pid === 0 && data.ExitCode === null
    : !data.Running && data.Pid > 0 && data.ExitCode !== null, "EXEC_PROTOCOL");
  return Object.freeze({ pid: data.Pid, reportedRunning: data.Running, reportedExitCode: data.ExitCode });
}
