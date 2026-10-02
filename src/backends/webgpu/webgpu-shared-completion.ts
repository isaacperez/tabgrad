import { TabgradError, type TabgradErrorCode } from "../../shared/errors.js";
import { ExecutionTicket, type SynchronousCompletion } from "../../execution/execution-ticket.js";
import { isRecord } from "../../shared/object-shape.js";
import { GPU_ACCOUNTED, GPU_PULSE, assertGpuConnectionActive, wakeGpuObservers } from "./webgpu-connection.js";

// Fixed control and bounded diagnostics are separate from demand-sized payload.
const HEADER_BYTES = 16;
const DIAGNOSTIC_BYTES = 4096;
const PAYLOAD_OFFSET = HEADER_BYTES + DIAGNOSTIC_BYTES;
const STATUS = 0;
const DRAINED = 1;
const LENGTH = 2;
const PENDING = 0;
const SUCCESS = 1;
const FAILURE = 2;

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

/** Preserve useful immediate native diagnostics, never recurse through causes. */
function projectGpuCause(cause: unknown): GpuCauseDiagnostic | undefined {
  if (cause === undefined) return undefined;
  if (typeof cause === "string") return { name: "Error", message: cause };
  try {
    if (isRecord(cause) && typeof cause.message === "string") {
      return { name: typeof cause.name === "string" ? cause.name : "Error", message: cause.message };
    }
  } catch {
    // Diagnostic access must not prevent publishing the original failure.
    return { name: "Error", message: "The native cause diagnostic could not be read." };
  }
  return { name: "Error", message: "The native cause supplied no textual diagnostic." };
}

export function sharedGpuPayload(buffer: SharedArrayBuffer): Uint8Array {
  return new Uint8Array(buffer, PAYLOAD_OFFSET);
}

/** The sole result/drain authority; messages and Promises are delivery hints. */
export class SharedGpuCompletion<T> implements SynchronousCompletion<T> {
  readonly buffer: SharedArrayBuffer;
  readonly ticket: ExecutionTicket<T>;
  readonly #control: Int32Array;
  readonly #header: Int32Array;
  readonly #decode: (payload: Uint8Array) => T;
  readonly #retire: () => void;
  #resultObserver: { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } | undefined;
  #drainObserver: { promise: Promise<void>; resolve: () => void } | undefined;
  #outcome: { value: T } | { error: unknown } | undefined;
  #drainCallbacks: (() => void)[] | undefined;
  #retired = false;

  constructor(control: Int32Array, payloadBytes: number, decode: (payload: Uint8Array) => T, retire: () => void) {
    this.#control = control;
    this.#decode = decode;
    this.#retire = retire;
    this.buffer = new SharedArrayBuffer(PAYLOAD_OFFSET + payloadBytes);
    this.#header = new Int32Array(this.buffer, 0, HEADER_BYTES / 4);
    this.ticket = new ExecutionTicket(() => this.#observeResult(), () => this.#observeDrain(), this);
  }

  isDrained(): boolean {
    return Atomics.load(this.#header, DRAINED) !== 0 || Atomics.load(this.#control, GPU_ACCOUNTED) !== 0;
  }

  onDrained(callback: () => void): void {
    if (this.#retired) { callback(); return; }
    this.#drainCallbacks ??= [];
    this.#drainCallbacks.push(callback);
    this.refresh();
  }

  refresh(): void {
    if (this.#outcome === undefined) {
      const status = Atomics.load(this.#header, STATUS);
      try {
        if (status === FAILURE) throw readSharedFailure(this.buffer, Atomics.load(this.#header, LENGTH));
        assertGpuConnectionActive(this.#control);
        if (status === SUCCESS) {
          const length = Atomics.load(this.#header, LENGTH);
          const payload = sharedGpuPayload(this.buffer);
          if (length < 0 || length > payload.byteLength) throw new Error("Invalid shared GPU result length.");
          const value = this.#decode(payload.subarray(0, length));
          this.#outcome = { value };
        }
      } catch (error) {
        this.#outcome = { error };
      }
    }
    if (this.#outcome !== undefined && this.#resultObserver !== undefined) {
      if ("error" in this.#outcome) this.#resultObserver.reject(this.#outcome.error);
      else this.#resultObserver.resolve(this.#outcome.value);
    }
    if (this.isDrained()) {
      this.#drainObserver?.resolve();
      if (this.#outcome !== undefined && !this.#retired) {
        this.#retired = true;
        const callbacks = this.#drainCallbacks;
        this.#drainCallbacks = undefined;
        // Remove the transport obligation before semantic retirement can cause
        // reentrant allocation releases and further shared-state advancement.
        this.#retire();
        for (const callback of callbacks ?? []) callback();
      }
    }
  }

  #observeResult(): Promise<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((onSuccess, onFailure) => { resolve = onSuccess; reject = onFailure; });
    this.#resultObserver = { promise, resolve, reject };
    this.refresh();
    return promise;
  }

  #observeDrain(): Promise<void> {
    let resolve!: () => void;
    const promise = new Promise<void>((onDrained) => { resolve = onDrained; });
    this.#drainObserver = { promise, resolve };
    this.refresh();
    return promise;
  }

  read(): T {
    while (this.#outcome === undefined) {
      // Load the pulse before checking state: a publication between inspection
      // and enrollment makes wait return not-equal rather than losing a wakeup.
      const pulse = Atomics.load(this.#control, GPU_PULSE);
      this.refresh();
      if (this.#outcome === undefined) Atomics.wait(this.#control, GPU_PULSE, pulse);
    }
    if ("error" in this.#outcome) throw this.#outcome.error;
    return this.#outcome.value;
  }
}

export function publishSharedGpuSuccess(buffer: SharedArrayBuffer, control: Int32Array, bytes: Uint8Array): void {
  assertGpuConnectionActive(control);
  sharedGpuPayload(buffer).set(bytes);
  const header = new Int32Array(buffer, 0, HEADER_BYTES / 4);
  Atomics.store(header, LENGTH, bytes.byteLength);
  Atomics.store(header, DRAINED, 1);
  Atomics.store(header, STATUS, SUCCESS);
  wakeGpuObservers(control);
}

export function publishSharedGpuDrain(buffer: SharedArrayBuffer, control: Int32Array): void {
  Atomics.store(new Int32Array(buffer, 0, HEADER_BYTES / 4), DRAINED, 1);
  wakeGpuObservers(control);
}

export function publishSharedGpuFailure(buffer: SharedArrayBuffer, control: Int32Array, error: unknown): void {
  const primary = error instanceof TabgradError ? error : new TabgradError("BACKEND_STATUS_ERROR", "Physical GPU execution failed.", {}, error);
  const details: Record<string, unknown> = {};
  let diagnosticTruncated = primary.message.length > 1024;
  // Preserve the execution locator and bounded scalar diagnostics, never tensor
  // state, the program or an arbitrary exception object in shared storage.
  for (const name of ["backend", "device", "phase", "programValueSlot", "reason"]) {
    const value = primary.details[name];
    if (typeof value === "number" || typeof value === "boolean") details[name] = value;
    else if (typeof value === "string") {
      details[name] = value.slice(0, 256);
      diagnosticTruncated ||= value.length > 256;
    }
  }
  const cause = projectGpuCause(primary.cause);
  if (cause !== undefined) {
    diagnosticTruncated ||= cause.name.length > 128 || cause.message.length > 1024;
    cause.name = cause.name.slice(0, 128);
    cause.message = cause.message.slice(0, 1024);
  }
  const diagnostic: GpuFailureDiagnostic = { code: primary.code, message: primary.message.slice(0, 1024),
    details, cause, diagnosticTruncated };
  const encoder = new TextEncoder();
  let encoded = encoder.encode(JSON.stringify(diagnostic));
  while (encoded.byteLength > DIAGNOSTIC_BYTES) {
    diagnostic.diagnosticTruncated = true;
    diagnostic.message = diagnostic.message.slice(0, Math.floor(diagnostic.message.length / 2));
    if (cause !== undefined) cause.message = cause.message.slice(0, Math.floor(cause.message.length / 2));
    for (const [name, value] of Object.entries(details)) {
      if (typeof value === "string") details[name] = value.slice(0, Math.floor(value.length / 2));
    }
    encoded = encoder.encode(JSON.stringify(diagnostic));
  }
  const header = new Int32Array(buffer, 0, HEADER_BYTES / 4);
  new Uint8Array(buffer, HEADER_BYTES, DIAGNOSTIC_BYTES).set(encoded);
  Atomics.store(header, LENGTH, encoded.byteLength);
  Atomics.store(header, STATUS, FAILURE);
  wakeGpuObservers(control);
}

function readSharedFailure(buffer: SharedArrayBuffer, length: number): TabgradError {
  if (length <= 0 || length > DIAGNOSTIC_BYTES) return new TabgradError("BACKEND_STATUS_ERROR", "Invalid shared GPU failure length.");
  const record: unknown = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, HEADER_BYTES, length)));
  if (!isRecord(record) || typeof record.code !== "string" || typeof record.message !== "string" || !isRecord(record.details)) {
    return new TabgradError("BACKEND_STATUS_ERROR", "Invalid shared GPU failure diagnostic.");
  }
  let cause: Error | undefined;
  if (isRecord(record.cause) && typeof record.cause.name === "string" && typeof record.cause.message === "string") {
    cause = new Error(record.cause.message);
    cause.name = record.cause.name;
  }
  return new TabgradError(record.code as TabgradErrorCode, record.message,
    { ...record.details, diagnosticTruncated: record.diagnosticTruncated }, cause);
}
