import { beginGpuPublication, endGpuPublication, type GpuProgressPath } from "./webgpu-progress-notification.js";
import { TabgradError } from "../../shared/errors.js";
import { ExecutionTicket, type SynchronousCompletion } from "../../execution/execution-ticket.js";
import { GPU_DIAGNOSTIC_BYTES, decodeGpuFailure, encodeGpuFailure } from "./webgpu-failure-diagnostic.js";
import { GPU_ACCOUNTED, GPU_PULSE, assertGpuConnectionActive, wakeGpuObservers } from "./webgpu-connection.js";

// Fixed control and bounded diagnostics are separate from demand-sized payload.
const HEADER_BYTES = 16;
const PAYLOAD_OFFSET = HEADER_BYTES + GPU_DIAGNOSTIC_BYTES;
const STATUS = 0;
const DRAINED = 1;
const LENGTH = 2;
const PENDING = 0;
const SUCCESS = 1;
const FAILURE = 2;

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
  readonly #failed: (() => void) | undefined;
  #resultObserver: { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } | undefined;
  #drainObserver: { promise: Promise<void>; resolve: () => void } | undefined;
  #outcome: { value: T } | { error: unknown } | undefined;
  #drainCallbacks: (() => void)[] | undefined;
  #retired = false;

  constructor(control: Int32Array, payloadBytes: number, decode: (payload: Uint8Array) => T, retire: () => void, failed?: () => void) {
    this.#control = control;
    this.#decode = decode;
    this.#retire = retire;
    this.#failed = failed;
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
        this.#failed?.();
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

export function publishSharedGpuSuccess(buffer: SharedArrayBuffer, control: Int32Array, bytes: Uint8Array, progress?: GpuProgressPath): void {
  assertGpuConnectionActive(control);
  beginGpuPublication(buffer, progress);
  sharedGpuPayload(buffer).set(bytes);
  const header = new Int32Array(buffer, 0, HEADER_BYTES / 4);
  Atomics.store(header, LENGTH, bytes.byteLength);
  Atomics.store(header, DRAINED, 1);
  Atomics.store(header, STATUS, SUCCESS);
  endGpuPublication(buffer, progress);
  wakeGpuObservers(control);
}

export function publishSharedGpuDrain(buffer: SharedArrayBuffer, control: Int32Array, progress?: GpuProgressPath): void {
  beginGpuPublication(buffer, progress);
  Atomics.store(new Int32Array(buffer, 0, HEADER_BYTES / 4), DRAINED, 1);
  endGpuPublication(buffer, progress);
  wakeGpuObservers(control);
}

export function publishSharedGpuFailure(buffer: SharedArrayBuffer, control: Int32Array, error: unknown, progress?: GpuProgressPath): void {
  const encoded = encodeGpuFailure(error);
  beginGpuPublication(buffer, progress);
  const header = new Int32Array(buffer, 0, HEADER_BYTES / 4);
  new Uint8Array(buffer, HEADER_BYTES, GPU_DIAGNOSTIC_BYTES).set(encoded);
  Atomics.store(header, LENGTH, encoded.byteLength);
  Atomics.store(header, STATUS, FAILURE);
  endGpuPublication(buffer, progress);
  wakeGpuObservers(control);
}

function readSharedFailure(buffer: SharedArrayBuffer, length: number): TabgradError {
  if (length <= 0 || length > GPU_DIAGNOSTIC_BYTES) return new TabgradError("BACKEND_STATUS_ERROR", "Invalid shared GPU failure length.");
  return decodeGpuFailure(new Uint8Array(buffer, HEADER_BYTES, length));
}
