import { TabgradError } from "../../shared/errors.js";

interface GpuStorageLimits {
  readonly maxBufferSize: number;
  readonly maxStorageBufferBindingSize: number;
}

const MAXIMUM_SHARED_GPU_PAYLOAD_BYTES = 0x7fff_ffff;

/** Storage words and shared completion bytes have independent representations. */
export function gpuStorageCapacityBytes(limits: GpuStorageLimits): number {
  return Math.floor(Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize, 0xffff_ffff * 4) / 4) * 4;
}

export function gpuTensorCapacityBytes(limits: GpuStorageLimits): number {
  return Math.floor(Math.min(gpuStorageCapacityBytes(limits), MAXIMUM_SHARED_GPU_PAYLOAD_BYTES) / 4) * 4;
}

/** Validate before allocating: mapping payloads need not have tensor geometry. */
export function validateSharedGpuPayloadBytes(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAXIMUM_SHARED_GPU_PAYLOAD_BYTES) {
    throw new TabgradError("RESOURCE_EXHAUSTED", "GPU shared completion exceeds its signed byte-count domain.");
  }
  return bytes;
}
