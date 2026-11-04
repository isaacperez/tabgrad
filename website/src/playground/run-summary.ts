import { required } from "./dom.ts";
import type { Device, GpuResources, Language, RunResources } from "./messages";
export type RunOutcome = "idle" | "running" | "complete" | "error" | "stopped";
const number = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) { bytes /= 1024; unit++; }
  return `${number.format(bytes)} ${units[unit]}`;
}
function time(milliseconds: number | null): string {
  return milliseconds === null ? "—" : milliseconds < 1000 ? `${number.format(milliseconds)} ms` : `${number.format(milliseconds / 1000)} s`;
}
export function deviceState(outcome: RunOutcome, device: Device, data: RunResources | null): string {
  if (outcome === "error") return "Run failed";
  if (outcome === "stopped") return "Stopped · cleanup unconfirmed";
  if (device === "cpu") return outcome === "complete" ? "Code finished" : outcome === "running" ? "Preparing / running" : "Selected";
  if (data?.gpu?.state === "lost") return "GPU connection lost";
  if (!data?.gpuAcquired) return outcome === "running" ? "Preparing GPU" : "Selected";
  if (outcome !== "complete") return "Device ready";
  const gpu = data.gpu;
  if (!gpu || gpu.pendingSubmissions || gpu.unknownCompletionBytes || gpu.state !== "closed") return "Completion unconfirmed";
  if (gpu.kernelCalls === 0) return "Enabled · no GPU calculations";
  if (gpu.adapter.isFallbackAdapter === true) return "Finished using software";
  if (gpu.adapter.isFallbackAdapter === null) return "Finished · GPU type not reported";
  return "GPU work completed";
}

/** Render only validated observations, with unavailable data distinct from zero. */
export class RunSummary {
  private data: RunResources | null = null;
  private outcome: RunOutcome = "idle";
  private language: Language = "python";
  private device: Device = "cpu";
  private elapsed: number | null = null;
  private root: HTMLElement;
  constructor(root: HTMLElement) { this.root = root; }
  reset(language: Language, device: Device): void {
    this.language = language; this.device = device; this.data = null; this.elapsed = null; this.outcome = "idle"; this.render();
  }
  running(): void { this.outcome = "running"; this.render(); }
  update(data: RunResources): void { this.data = data; this.render(); }
  updateGpu(gpu: GpuResources | null): void {
    if (!gpu) return;
    const data = this.data ?? { language: this.language, device: this.device, gpuAcquired: true,
      programMilliseconds: null, cpu: null, gpu: null };
    this.data = { ...data, gpuAcquired: true, gpu };
    this.render();
  }
  finish(outcome: RunOutcome, elapsed: number): void { this.outcome = outcome; this.elapsed = elapsed; this.render(); }
  private text(selector: string, value: string): void { required(this.root, selector, HTMLElement).textContent = value; }
  private detail(selector: string, value: string | null): void {
    const field = required(this.root, selector, HTMLElement);
    const row = field.parentElement;
    if (!row) throw new Error(`Missing run detail row: ${selector}`);
    field.textContent = value ?? "";
    row.hidden = value === null;
  }
  private render(): void {
    const gpu = this.data?.gpu;
    const cpu = this.data?.cpu;
    this.text("[data-resource-device]", this.device === "webgpu" ? "GPU" : "CPU");
    this.text("[data-resource-state]", deviceState(this.outcome, this.device, this.data));
    this.text("[data-resource-time]", time(this.elapsed));
    this.text("[data-resource-memory]", this.device === "webgpu" ? gpu ? formatBytes(gpu.peakOwnedBufferBytes) : "Not measured" : cpu ? formatBytes(cpu.peakAllocationBytes) : "Not measured");
    const programTime = this.data?.programMilliseconds;
    this.detail("[data-resource-program]", programTime === null || programTime === undefined ? null : time(programTime));
    const adapter = gpu?.adapter;
    const name = adapter ? adapter.description.trim() || [adapter.vendor, adapter.architecture, adapter.device].filter(Boolean).join(" · ") || "Name not disclosed by the browser" : "—";
    const kind = adapter?.isFallbackAdapter === true ? "software" : adapter?.isFallbackAdapter === false ? "hardware, browser-reported" : "adapter type undisclosed";
    this.detail("[data-resource-adapter]", adapter ? `${name} (${kind})` : null);
    this.detail("[data-resource-dispatches]", gpu ? String(gpu.kernelCalls) : null);
    this.detail("[data-resource-remaining]", gpu ? `${formatBytes(gpu.ownedBufferBytes)} · ${gpu.pendingSubmissions} pending · ${formatBytes(gpu.unknownCompletionBytes)} completion unknown` : null);
    this.detail("[data-resource-transfer]", gpu ? `${formatBytes(gpu.uploadBytes)} / ${formatBytes(gpu.readbackBytes)}` : null);
    this.detail("[data-resource-wasm]", cpu ? formatBytes(cpu.wasmMemoryBytes) : null);
    this.text("[data-resource-note]", this.data
      ? "Measurements cover this run, not your whole device. On failed or stopped runs, recorded GPU work may be incomplete."
      : "Run the code to see available measurements from this playground’s session.");
  }
}
