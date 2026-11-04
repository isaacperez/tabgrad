export type Language = "python" | "javascript";
export type Device = "cpu" | "webgpu";
export interface CpuResources { wasmMemoryBytes: number; peakAllocationBytes: number; kernelCalls: number }
export interface GpuResources {
  state: "ready" | "closed" | "lost";
  adapter: { vendor: string; architecture: string; device: string; description: string; isFallbackAdapter: boolean | null };
  ownedBufferBytes: number; peakOwnedBufferBytes: number; pendingSubmissions: number;
  unknownCompletionBytes: number; kernelCalls: number; uploadBytes: number; readbackBytes: number;
}
export interface RunResources {
  language: Language; device: Device; gpuAcquired: boolean; programMilliseconds: number | null;
  cpu: CpuResources | null; gpu: GpuResources | null;
}
export type HostMessage = { kind: "stage"; text: string }
  | { kind: "failure"; text: string }
  | { kind: "output-limit"; text: string }
  | { kind: "output"; text: string; stream: string }
  | { kind: "resources"; data: RunResources }
  | { kind: "done"; cleanup: "acknowledged" };

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function milliseconds(value: unknown): boolean { return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0); }
function cpuResources(value: unknown): value is CpuResources {
  return record(value) && ["wasmMemoryBytes", "peakAllocationBytes", "kernelCalls"].every((key) => count(value[key]));
}
function gpuResources(value: unknown): value is GpuResources {
  if (!record(value) || typeof value.state !== "string" || !["ready", "closed", "lost"].includes(value.state) || !record(value.adapter)) return false;
  const adapter = value.adapter;
  return ["vendor", "architecture", "device", "description"].every((key) => typeof adapter[key] === "string")
    && (adapter.isFallbackAdapter === null || typeof adapter.isFallbackAdapter === "boolean")
    && ["ownedBufferBytes", "peakOwnedBufferBytes", "pendingSubmissions", "unknownCompletionBytes", "kernelCalls", "uploadBytes", "readbackBytes"].every((key) => count(value[key]));
}
function resources(value: unknown): value is RunResources {
  if (!record(value) || typeof value.language !== "string" || !["python", "javascript"].includes(value.language)
      || typeof value.device !== "string" || !["cpu", "webgpu"].includes(value.device)
      || typeof value.gpuAcquired !== "boolean" || !milliseconds(value.programMilliseconds)) return false;
  if (value.language === "python") return value.cpu === null && value.gpu === null && (value.device !== "cpu" || !value.gpuAcquired);
  return cpuResources(value.cpu) && (value.gpu === null || gpuResources(value.gpu))
    && (value.gpu !== null) === value.gpuAcquired && (value.device !== "cpu" || value.gpu === null);
}

/** Validate data received on the application-owned MessagePort. */
export function isHostMessage(value: unknown): value is HostMessage {
  if (!record(value) || typeof value.kind !== "string") return false;
  if (value.kind === "resources") return resources(value.data);
  if (value.kind === "done") return value.cleanup === "acknowledged";
  if (!["stage", "failure", "output", "output-limit"].includes(value.kind)) return false;
  return typeof value.text === "string" && (value.kind !== "output" || typeof value.stream === "string");
}
