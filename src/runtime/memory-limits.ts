import { DEFAULT_CPU_LINEAR_MEMORY_BYTES, validateCpuLinearMemoryBytes } from "../backends/cpu/memory-capacity.js";

export interface RuntimeMemoryLimits {
  readonly cpuLinearMemoryBytes?: number;
  readonly updateBackingBytes?: number;
}

export const DEFAULT_UPDATE_BACKING_BYTES = 64 * 1024 * 1024;

/** Capture numerical capacity separately from semantic update reservations. */
export function resolveRuntimeMemoryLimits(limits: RuntimeMemoryLimits | undefined): Readonly<Required<RuntimeMemoryLimits>> {
  if (limits !== undefined && (typeof limits !== "object" || limits === null || Array.isArray(limits))) {
    throw new TypeError("memoryLimits must be an object.");
  }
  if (limits !== undefined && Reflect.ownKeys(limits).some(key => key !== "cpuLinearMemoryBytes" && key !== "updateBackingBytes")) {
    throw new TypeError("memoryLimits contains an unsupported field.");
  }
  const cpu = limits?.cpuLinearMemoryBytes;
  const update = limits?.updateBackingBytes;
  const cpuLinearMemoryBytes = cpu === undefined ? DEFAULT_CPU_LINEAR_MEMORY_BYTES : cpu;
  const updateBackingBytes = update === undefined ? DEFAULT_UPDATE_BACKING_BYTES : update;
  validateCpuLinearMemoryBytes(cpuLinearMemoryBytes);
  if (!Number.isSafeInteger(updateBackingBytes) || updateBackingBytes < 0 || updateBackingBytes > DEFAULT_UPDATE_BACKING_BYTES) {
    throw new TypeError("updateBackingBytes must be a nonnegative safe byte count at most 64 MiB.");
  }
  return Object.freeze({ cpuLinearMemoryBytes, updateBackingBytes });
}
