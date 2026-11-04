import type { WebGpuDiagnostics, WebGpuWorkerController } from "@tabgrad/tabgrad/python";

/** Page-owned Python GPU service; the interpreter receives only its connection. */
export class GpuLease {
  private readonly cancellation = new AbortController();
  private controller: WebGpuWorkerController | null = null;

  async acquire(runtimeBase: string): Promise<WebGpuWorkerController> {
    const base = new URL(runtimeBase, location.origin);
    if (base.origin !== location.origin || !base.pathname.startsWith("/vendor/tabgrad/") || base.search || base.hash) throw new Error("Invalid same-origin Tabgrad location.");
    const api = await import(/* @vite-ignore */ new URL("python.js", base).href) as typeof import("@tabgrad/tabgrad/python");
    this.cancellation.signal.throwIfAborted();
    const controller = await api.createWebGpuWorker({ signal: this.cancellation.signal });
    this.controller = controller;
    if (this.cancellation.signal.aborted) {
      await controller.close();
      this.cancellation.signal.throwIfAborted();
    }
    return controller;
  }

  close(): Promise<void> {
    this.cancellation.abort();
    return this.controller?.close() ?? Promise.resolve();
  }

  diagnostics(): WebGpuDiagnostics | null {
    return this.controller?.diagnostics() ?? null;
  }
}
