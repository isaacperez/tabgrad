import {
  acquisitionFields as fields, isAcquisitionHash, isAcquisitionUint, requireAcquisition,
} from "./provenance-acquisition-record.mjs";
import { validateHostReport } from "./provenance-acquisition-host-profile.mjs";
import { ACQUISITION_PROCESS_MESSAGE_LIMIT, ACQUISITION_PROCESS_CAUSES } from "./provenance-acquisition-process-protocol.mjs";

function guardMessage(value) {
  requireAcquisition(fields(value, ["version", "profileSha256", "pid", "sequence", "phase", "report"])
    && value.version === 1 && isAcquisitionHash(value.profileSha256)
    && Number.isSafeInteger(value.pid) && value.pid > 0 && isAcquisitionUint(value.sequence) && value.sequence !== "0"
    && ["armed", "observation", "boundary", "settled", "failed"].includes(value.phase), "PROCESS_PROTOCOL");
  validateHostReport(value.report, "guard");
  requireAcquisition(value.report.entry, "PROCESS_PROTOCOL");
  return value;
}

function parseWire(wire) {
  requireAcquisition(typeof wire === "string" && Buffer.byteLength(wire) <= ACQUISITION_PROCESS_MESSAGE_LIMIT, "PROCESS_PROTOCOL");
  let parsed;
  try { parsed = JSON.parse(wire); } catch { requireAcquisition(false, "PROCESS_PROTOCOL"); }
  requireAcquisition(JSON.stringify(parsed) === wire, "PROCESS_PROTOCOL");
  return parsed;
}

export function encodeStartupGuardMessage(value) {
  guardMessage(value);
  const wire = JSON.stringify(value);
  requireAcquisition(Buffer.byteLength(wire) <= ACQUISITION_PROCESS_MESSAGE_LIMIT, "PROCESS_PROTOCOL");
  return wire;
}

export function decodeStartupGuardMessage(wire) { return guardMessage(parseWire(wire)); }

export function encodeStartupGuardStop(operationId, code) {
  requireAcquisition(typeof operationId === "string" && /^[a-f0-9]{32}$/.test(operationId)
    && ACQUISITION_PROCESS_CAUSES.includes(code), "PROCESS_PROTOCOL");
  return JSON.stringify({ version: 1, operationId, code });
}

export function decodeStartupGuardStop(wire, operationId) {
  const p = parseWire(wire);
  requireAcquisition(fields(p, ["version", "operationId", "code"]) && p.version === 1 && p.operationId === operationId
    && ACQUISITION_PROCESS_CAUSES.includes(p.code), "PROCESS_PROTOCOL");
  return p.code;
}
