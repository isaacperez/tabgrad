import { isAbsolute, resolve } from "node:path";
import { constants as bufferConstants } from "node:buffer";
import { acquisitionFields as fields, requireAcquisition, acquisitionSha256,
  isAcquisitionToken, isAcquisitionUint, isAcquisitionHash } from "./provenance-acquisition-record.mjs";

const path = value => typeof value === "string" && !value.includes("\0") && isAbsolute(value) && resolve(value) === value;
const contextKeys = ["operationId", "t0MonotonicNs", "deadlineNs", "root"];

/** Closed ordinary data copied before borrowing callbacks; no I/O or clock port. */
export function copyActivationProfile(input, gate) {
  requireAcquisition(fields(input, ["context", "socket", "containerId", "preparedContainerSha256", "pollMs", "limits"])
    && fields(input.context, contextKeys) && isAcquisitionToken(input.context.operationId)
    && isAcquisitionUint(input.context.t0MonotonicNs) && isAcquisitionUint(input.context.deadlineNs)
    && input.context.deadlineNs !== "0" && BigInt(input.context.deadlineNs) <= 180000000000n && path(input.context.root)
    && fields(input.socket, ["path", "identity"]) && path(input.socket.path)
    && fields(input.socket.identity, ["dev", "ino"])
    && isAcquisitionUint(input.socket.identity.dev) && isAcquisitionUint(input.socket.identity.ino) && input.socket.identity.ino !== "0"
    && isAcquisitionHash(input.containerId) && isAcquisitionHash(input.preparedContainerSha256)
    && Number.isInteger(input.pollMs) && input.pollMs > 0 && input.pollMs <= 5000
    && fields(input.limits, ["headerBytes"]) && Number.isSafeInteger(input.limits.headerBytes)
    && input.limits.headerBytes > 0 && input.limits.headerBytes <= bufferConstants.MAX_LENGTH, "ACTIVATION_INPUT");
  const context = Object.freeze({ ...input.context });
  const socket = { path: input.socket.path, identity: { ...input.socket.identity } };
  const { containerId, preparedContainerSha256, pollMs } = input;
  const limits = { ...input.limits };
  requireAcquisition(fields(gate, ["context", "check", "appendIntent", "revoke"])
    && fields(gate.context, contextKeys) && contextKeys.every(key => gate.context[key] === context[key])
    && ["check", "appendIntent", "revoke"].every(key => typeof gate[key] === "function"), "ACTIVATION_INPUT");
  const method = "POST";
  const route = `/v1.56/containers/${containerId}/start`;
  const intent = JSON.stringify({ operationId: context.operationId, containerId, preparedContainerSha256,
    method, path: route, bodySha256: acquisitionSha256(Buffer.alloc(0)) });
  return { context, socket, containerId, preparedContainerSha256, pollMs, limits, method, route,
    intentSha256: acquisitionSha256(intent) };
}
