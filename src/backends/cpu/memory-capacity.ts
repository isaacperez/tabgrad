/** The matched CPU artifact profile; a session may choose a smaller maximum. */
export const CPU_MEMORY_PROFILE = Object.freeze({
  moduleVersion: 8,
  initialPages: 32,
  maximumPages: 4096,
  alignment: 16,
});

export const WEBASSEMBLY_PAGE_BYTES = 65_536;
export const DEFAULT_CPU_LINEAR_MEMORY_BYTES = 64 * 1024 * 1024;

export interface CpuMemoryCapacity {
  readonly artifactMaximumBytes: number;
  readonly linearMemoryLimitBytes: number;
  readonly arenaBaseBytes: number;
  readonly arenaCapacityBytes: number;
}

export function validateCpuLinearMemoryBytes(value: number): number {
  if (!Number.isSafeInteger(value)
    || value < CPU_MEMORY_PROFILE.initialPages * WEBASSEMBLY_PAGE_BYTES
    || value > CPU_MEMORY_PROFILE.maximumPages * WEBASSEMBLY_PAGE_BYTES
    || value % WEBASSEMBLY_PAGE_BYTES !== 0) {
    throw new TypeError("cpuLinearMemoryBytes must be a page-aligned byte count between 2 MiB and 256 MiB.");
  }
  return value;
}
