import type { BackendCapabilities } from "../../execution/backend.js";
import { TabgradError } from "../../shared/errors.js";
import type { WebGpuDiagnostics } from "./webgpu-backend.js";

/** Library-issued, single-use connection; transfer using its controller's list. */
export interface WebGpuConnection {
  readonly connectionType: "tabgrad-webgpu";
}

/** @internal Physical connection data, not a user-supplied backend interface. */
export interface WebGpuConnectionData extends WebGpuConnection {
  readonly protocolVersion: 1;
  readonly port: MessagePort;
  readonly supervision: MessagePort;
  readonly control: SharedArrayBuffer;
  readonly capabilities: BackendCapabilities;
  readonly diagnostics: WebGpuDiagnostics;
  readonly metrics: SharedArrayBuffer;
}

// One context has one generation. Retirement is permanent, never recovery.
export const GPU_GENERATION = 0;
export const GPU_CONSUMED = 1;
export const GPU_PULSE = 2;
export const GPU_ACCOUNTED = 3;
export const GPU_CONTROL_LENGTH = 4;

export const GPU_METRICS = ["ownedBufferBytes", "peakOwnedBufferBytes", "pendingSubmissions", "unknownCompletionBytes",
  "uploadBytes", "readbackBytes", "kernelCalls"] as const;
export const GPU_METRIC_STATE = GPU_METRICS.length;
export const GPU_METRIC_LENGTH = GPU_METRICS.length + 1;

export function writeGpuMetrics(metrics: SharedArrayBuffer, diagnostics: WebGpuDiagnostics): void {
  const counters = new BigInt64Array(metrics);
  GPU_METRICS.forEach((name, index) => Atomics.store(counters, index, BigInt(diagnostics[name])));
  Atomics.store(counters, GPU_METRIC_STATE, diagnostics.state === "ready" ? 0n : diagnostics.state === "lost" ? 1n : 2n);
}

export function readGpuMetrics(metrics: SharedArrayBuffer, diagnostics: WebGpuDiagnostics, control: Int32Array): WebGpuDiagnostics {
  const counters = new BigInt64Array(metrics);
  const result = { ...diagnostics };
  GPU_METRICS.forEach((name, index) => { result[name] = Number(Atomics.load(counters, index)); });
  const state = Atomics.load(counters, GPU_METRIC_STATE);
  result.state = state === 2n ? "closed" : state === 1n || Atomics.load(control, GPU_GENERATION) !== 0 ? "lost" : "ready";
  if (Atomics.load(control, GPU_ACCOUNTED) === 2) {
    // A dead producer cannot update its final counters. Keep its last known
    // owned obligations visible instead of claiming successful reclamation.
    result.unknownCompletionBytes = Math.max(result.unknownCompletionBytes, result.ownedBufferBytes);
  }
  return Object.freeze(result);
}

export function wakeGpuObservers(control: Int32Array): void {
  Atomics.add(control, GPU_PULSE, 1);
  Atomics.notify(control, GPU_PULSE);
}

export function retireGpuConnection(control: Int32Array): void {
  Atomics.compareExchange(control, GPU_GENERATION, 0, 1);
  wakeGpuObservers(control);
}

export function assertGpuConnectionActive(control: Int32Array): void {
  if (Atomics.load(control, GPU_GENERATION) !== 0) {
    throw new TabgradError("BACKEND_STATUS_ERROR", "The WebGPU connection has been retired.", {
      backend: "webgpu", device: "webgpu", phase: "connection-loss",
    });
  }
}
