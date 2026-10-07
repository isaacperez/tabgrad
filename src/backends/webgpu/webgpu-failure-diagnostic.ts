import { TabgradError, type TabgradErrorCode } from "../../shared/errors.js";
import { isRecord } from "../../shared/object-shape.js";

/** Private setup and execution diagnostics share one fixed UTF-8 budget. */
export const GPU_DIAGNOSTIC_BYTES = 4096;

interface GpuCauseDiagnostic {
  name: string;
  message: string;
}

interface GpuFailureDiagnostic {
  readonly code: TabgradErrorCode;
  message: string;
  readonly details: Record<string, unknown>;
  readonly cause: GpuCauseDiagnostic | undefined;
  diagnosticTruncated: boolean;
}

/** Diagnostics are best effort; one unreadable field cannot replace failure. */
function readDiagnosticField(record: unknown, name: string): unknown {
  try { return isRecord(record) ? record[name] : undefined; }
  catch { return undefined; }
}

function projectGpuCause(cause: unknown): GpuCauseDiagnostic | undefined {
  if (cause === undefined) return undefined;
  if (typeof cause === "string") return { name: "Error", message: cause };
  const message = readDiagnosticField(cause, "message");
  const name = readDiagnosticField(cause, "name");
  return { name: typeof name === "string" ? name : "Error",
    message: typeof message === "string" ? message : "The native cause supplied no readable textual diagnostic." };
}

/** Reduce the largest textual field first so short locators remain useful. */
function shrinkGpuDiagnostic(diagnostic: GpuFailureDiagnostic): boolean {
  let length = diagnostic.message.length;
  let detail: string | undefined;
  let cause = false;
  if (diagnostic.cause !== undefined && diagnostic.cause.message.length > length) {
    length = diagnostic.cause.message.length;
    cause = true;
  }
  for (const [name, value] of Object.entries(diagnostic.details)) {
    if (typeof value === "string" && value.length > length) {
      length = value.length;
      detail = name;
      cause = false;
    }
  }
  if (length === 0) return false;
  const remaining = Math.floor(length / 2);
  if (detail !== undefined) diagnostic.details[detail] = (diagnostic.details[detail] as string).slice(0, remaining);
  else if (cause) diagnostic.cause!.message = diagnostic.cause!.message.slice(0, remaining);
  else diagnostic.message = diagnostic.message.slice(0, remaining);
  return true;
}

/** Project only bounded scalar locators and the immediate textual cause. */
export function encodeGpuFailure(error: unknown): Uint8Array {
  const primary = error instanceof TabgradError ? error : new TabgradError("BACKEND_STATUS_ERROR", "Physical GPU execution failed.", {}, error);
  const primaryMessage = readDiagnosticField(primary, "message");
  const message = typeof primaryMessage === "string" ? primaryMessage : "The GPU failure diagnostic could not be read.";
  const primaryCode = readDiagnosticField(primary, "code");
  const code = typeof primaryCode === "string" ? primaryCode as TabgradErrorCode : "BACKEND_STATUS_ERROR";
  const primaryDetails = readDiagnosticField(primary, "details");
  const details: Record<string, unknown> = {};
  let diagnosticTruncated = message.length > 1024;
  for (const name of ["backend", "device", "phase", "programValueSlot", "reason"]) {
    const value = readDiagnosticField(primaryDetails, name);
    if (typeof value === "number" || typeof value === "boolean") details[name] = value;
    else if (typeof value === "string") {
      details[name] = value.slice(0, 256);
      diagnosticTruncated ||= value.length > 256;
    }
  }
  const cause = projectGpuCause(readDiagnosticField(primary, "cause"));
  if (cause !== undefined) {
    diagnosticTruncated ||= cause.name.length > 128 || cause.message.length > 1024;
    cause.name = cause.name.slice(0, 128);
    cause.message = cause.message.slice(0, 1024);
  }
  const diagnostic: GpuFailureDiagnostic = { code, message: message.slice(0, 1024), details, cause, diagnosticTruncated };
  const encoder = new TextEncoder();
  let encoded = encoder.encode(JSON.stringify(diagnostic));
  while (encoded.byteLength > GPU_DIAGNOSTIC_BYTES) {
    diagnostic.diagnosticTruncated = true;
    if (!shrinkGpuDiagnostic(diagnostic)) {
      // A malformed code outside the typed error domain must not stall cleanup.
      return encoder.encode(JSON.stringify({ code: "BACKEND_STATUS_ERROR", message: "The GPU failure diagnostic exceeds its capacity.",
        details: {}, diagnosticTruncated: true }));
    }
    encoded = encoder.encode(JSON.stringify(diagnostic));
  }
  return encoded;
}

export function decodeGpuFailure(bytes: Uint8Array): TabgradError {
  try {
    if (bytes.byteLength <= 0 || bytes.byteLength > GPU_DIAGNOSTIC_BYTES) throw new Error("Invalid diagnostic length.");
    const record: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(record) || typeof record.code !== "string" || typeof record.message !== "string" || !isRecord(record.details)) {
      throw new Error("Invalid diagnostic fields.");
    }
    let cause: Error | undefined;
    if (isRecord(record.cause) && typeof record.cause.name === "string" && typeof record.cause.message === "string") {
      cause = new Error(record.cause.message);
      cause.name = record.cause.name;
    }
    return new TabgradError(record.code as TabgradErrorCode, record.message,
      { ...record.details, diagnosticTruncated: record.diagnosticTruncated }, cause);
  } catch {
    return new TabgradError("BACKEND_STATUS_ERROR", "Invalid GPU failure diagnostic.");
  }
}
