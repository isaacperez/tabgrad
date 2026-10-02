import { TabgradError } from "../../shared/errors.js";

function setupCancelled(signal: AbortSignal): TabgradError {
  return new TabgradError("BACKEND_LOAD_FAILED", "WebGPU setup was cancelled.", {
    backend: "webgpu", phase: "device-acquisition",
  }, signal.reason);
}

export function assertWebGpuSetupActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw setupCancelled(signal);
}

/** The browser cannot abort acquisition; retain cleanup ownership of late results. */
async function requestDevice(signal?: AbortSignal): Promise<GPUDevice> {
  if (signal?.aborted) throw setupCancelled(signal);
  if (typeof navigator === "undefined" || navigator.gpu === undefined) {
    throw new TabgradError("UNSUPPORTED_DEVICE", "WebGPU is unavailable in this environment.", {
      device: "webgpu", backend: "webgpu", phase: "device-acquisition",
    });
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (signal?.aborted) throw setupCancelled(signal);
  if (adapter === null) {
    throw new TabgradError("UNSUPPORTED_DEVICE", "No WebGPU adapter is available.", {
      device: "webgpu", backend: "webgpu", phase: "device-acquisition",
    });
  }
  const device = await adapter.requestDevice();
  if (signal?.aborted) {
    device.destroy();
    throw setupCancelled(signal);
  }
  return device;
}

/** Acquire an owned device, with prompt cancellation and eventual late cleanup. */
export async function acquireWebGpuDevice(signal?: AbortSignal): Promise<GPUDevice> {
  let onAbort: (() => void) | undefined;
  let acquired: GPUDevice | undefined;
  try {
    if (signal?.aborted) throw setupCancelled(signal);
    const acquisition = requestDevice(signal).then((device) => { acquired = device; return device; });
    if (signal === undefined) return await acquisition;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(setupCancelled(signal));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const device = await Promise.race([acquisition, cancelled]);
    assertWebGpuSetupActive(signal);
    return device;
  } catch (error) {
    acquired?.destroy();
    if (error instanceof TabgradError) throw error;
    throw new TabgradError("BACKEND_LOAD_FAILED", "WebGPU device acquisition failed.", {
      backend: "webgpu", phase: "device-acquisition",
    }, error);
  } finally {
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}
