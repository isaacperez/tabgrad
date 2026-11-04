import catalog from "./examples.json";
import { isHostMessage, type HostMessage, type Device, type Language } from "./messages";
import { SyntaxEditor } from "./editor";

import { required } from "./dom";
import { exampleSource } from "./presets";
import { RunSummary } from "./run-summary";
import { GpuLease } from "./gpu-lease";
type Example = typeof catalog[number];
const examples = new Map(catalog.map((example) => [example.id, example]));
const sourceKey = "tabgrad-playground-handoff";

class Runner {
  private language: Language = "python";
  private device: Device = "cpu";
  private example: Example;
  private summary: RunSummary;
  private lease: GpuLease | null = null;
  private busy = false;
  private finishing = false;
  private started = 0;
  private edits = new Map<string, string>();
  private worker: Worker | null = null;
  private port: MessagePort | null = null;
  private generation = 0;
  private editor: HTMLTextAreaElement;
  private syntax: SyntaxEditor;
  private output: HTMLPreElement;
  private status: HTMLParagraphElement;
  private runButton: HTMLButtonElement;
  private stopButton: HTMLButtonElement;
  private restoreButton: HTMLButtonElement;
  private details: HTMLParagraphElement;

  constructor(private root: HTMLElement) {
    const initial = catalog[0];
    if (!initial) throw new Error("The playground example catalog is empty.");
    this.example = initial;
    this.editor = required(root, "textarea", HTMLTextAreaElement);
    this.syntax = new SyntaxEditor(this.editor, required(root, "[data-syntax-layer]", HTMLPreElement), required(root, "[data-syntax-notice]", HTMLParagraphElement));
    this.output = required(root, ".run-output", HTMLPreElement);
    this.status = required(root, ".run-status", HTMLParagraphElement);
    this.details = required(root, ".run-details", HTMLParagraphElement);
    this.runButton = required(root, "[data-run]", HTMLButtonElement);
    this.stopButton = required(root, "[data-stop]", HTMLButtonElement);
    this.restoreButton = required(root, "[data-restore]", HTMLButtonElement);
    this.summary = new RunSummary(required(root, "[data-run-summary]", HTMLElement));
    this.bind();
    if (!root.classList.contains("compact-runner")) {
      const query = new URL(location.href).searchParams;
      this.example = examples.get(query.get("example") ?? "") ?? initial;
      this.language = query.get("language") === "javascript" ? "javascript" : "python";
      this.device = query.get("device") === "webgpu" ? "webgpu" : "cpu";
      try {
        const raw: unknown = JSON.parse(sessionStorage.getItem(sourceKey) ?? "null");
        sessionStorage.removeItem(sourceKey);
        if (typeof raw === "object" && raw !== null && "example" in raw && raw.example === this.example.id
            && "language" in raw && raw.language === this.language && "device" in raw && raw.device === this.device && "source" in raw && typeof raw.source === "string") this.edits.set(this.key(), raw.source);
      } catch { /* Optional same-tab draft transfer; presets remain available. */ }
    }
    this.render();
    this.runButton.disabled = false;
  }

  private key(): string { return `${this.example.id}:${this.language}:${this.device}`; }

  private bind(): void {
    this.runButton.addEventListener("click", () => { void this.run(); });
    this.stopButton.addEventListener("click", () => this.stop());
    this.restoreButton.addEventListener("click", () => { this.edits.delete(this.key()); this.render(); this.editor.focus(); });
    this.editor.addEventListener("input", () => { this.edits.set(this.key(), this.editor.value); this.syntax.paint(this.language); });
    this.editor.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); this.run(); } });
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("button[data-run-language]")) {
      button.addEventListener("click", () => { this.language = button.dataset.runLanguage === "javascript" ? "javascript" : "python"; this.render(); });
      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        this.language = event.key === "Home" ? "python" : event.key === "End" ? "javascript" : this.language === "python" ? "javascript" : "python";
        this.render(); this.root.querySelector<HTMLButtonElement>(`[data-run-language="${this.language}"]`)?.focus();
      });
    }
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("button[data-run-device]")) {
      button.addEventListener("click", () => { this.device = button.dataset.runDevice === "webgpu" ? "webgpu" : "cpu"; this.render(); });
    }
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("button[data-example]")) {
      button.addEventListener("click", () => { const example = examples.get(button.dataset.example ?? ""); if (example) { this.example = example; this.render(); } });
    }
    required(this.root, "[data-copy-editor]", HTMLButtonElement).addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(this.editor.value); this.status.textContent = "Code copied."; }
      catch { this.status.textContent = "Copy unavailable. Select the code to copy it."; }
    });
    this.root.querySelector<HTMLAnchorElement>("[data-open-playground]")?.addEventListener("click", (event) => {
      if (!(event.currentTarget instanceof HTMLAnchorElement)) return;
      const url = new URL("/playground/", location.origin); url.searchParams.set("example", this.example.id); url.searchParams.set("language", this.language); url.searchParams.set("device", this.device);
      event.currentTarget.href = url.href;
      try { sessionStorage.setItem(sourceKey, JSON.stringify({ example: this.example.id, language: this.language, device: this.device, source: this.editor.value })); }
      catch { event.preventDefault(); this.status.textContent = "Edits could not transfer. Copy the code, then open Playground from the navigation."; }
    });
    addEventListener("pagehide", () => this.stop(false));
    addEventListener("resize", () => this.syntax.resize());
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.root.dataset.busy = String(busy);
    this.runButton.disabled = busy; this.stopButton.disabled = !busy; this.restoreButton.disabled = busy;
    this.editor.readOnly = busy;
    for (const control of this.root.querySelectorAll<HTMLButtonElement>("button[data-run-language],button[data-run-device],button[data-example],button[data-copy-editor]")) control.disabled = busy;
    this.root.querySelector("[role=tabpanel]")?.setAttribute("aria-busy", String(busy));
  }

  private render(): void {
    this.editor.value = this.edits.get(this.key()) ?? exampleSource(this.example, this.language, this.device);
    this.editor.setAttribute("aria-label", `${this.language === "python" ? "Python" : "JavaScript"} code`);
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("button[data-run-language]")) {
      const active = button.dataset.runLanguage === this.language;
      button.setAttribute("aria-selected", String(active)); button.tabIndex = active ? 0 : -1;
      if (active) this.root.querySelector("[role=tabpanel]")?.setAttribute("aria-labelledby", button.id);
    }
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("button[data-run-device]")) button.setAttribute("aria-pressed", String(button.dataset.runDevice === this.device));
    this.summary.reset(this.language, this.device);
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("button[data-example]")) button.setAttribute("aria-pressed", String(button.dataset.example === this.example.id));
    const title = this.root.querySelector("[data-example-title]"); if (title) title.textContent = this.example.title;
    const description = this.root.querySelector("[data-example-description]"); if (description) description.textContent = this.example.description;
    const expected = this.root.querySelector("[data-expected-output]"); if (expected) expected.textContent = this.example[this.language].expected;
    for (const diagram of this.root.querySelectorAll<HTMLElement>("[data-example-diagram]")) diagram.hidden = diagram.dataset.exampleDiagram !== this.example.id;
    required(this.root, ".run-context", HTMLParagraphElement).textContent = this.language === "python"
      ? "import torch uses Tabgrad’s supported Python API."
      : "The playground provides session for this JavaScript example.";
    const reference = this.root.querySelector<HTMLAnchorElement>("[data-example-reference]");
    if (reference) reference.href = "/" + this.example.reference.replace(/\.md$/, "/");
    this.output.textContent = ""; this.details.textContent = "";
    this.status.textContent = "Ready to run."; this.root.dataset.state = "idle"; this.syntax.paint(this.language);
  }

  private retire(): void {
    if (this.port) { this.port.onmessage = null; this.port.onmessageerror = null; this.port.close(); this.port = null; }
    if (this.worker) { this.worker.onerror = null; this.worker.onmessageerror = null; this.worker.terminate(); this.worker = null; }
    this.setBusy(false);
  }

  private stop(announce = true): void {
    if (!this.busy) return;
    const generation = ++this.generation;
    const lease = this.lease; this.lease = null;
    this.retire(); this.root.dataset.state = "stopped";
    this.summary.finish("stopped", performance.now() - this.started);
    this.details.textContent = "The running environment was discarded; completion of interrupted work is unconfirmed.";
    if (announce) this.status.textContent = "Stopped. The next run starts in a new environment.";
    if (lease) {
      this.setBusy(true); this.stopButton.disabled = true;
      void lease.close().then(() => {
        if (generation === this.generation) { this.summary.updateGpu(lease.diagnostics()); this.setBusy(false); }
      }, (error: unknown) => {
        if (generation === this.generation) {
          this.summary.updateGpu(lease.diagnostics());
          this.output.append(document.createTextNode("GPU cleanup failed: " + String(error)));
          this.setBusy(false);
        }
      });
    }
  }

  private message(data: HostMessage): void {
    if (this.finishing) return;
    if (data.kind === "stage") { this.status.textContent = data.text; return; }
    if (data.kind === "resources") {
      if (data.data.language !== this.language || data.data.device !== this.device) {
        void this.finish({ kind: "failure", text: "Mismatched playground observations." }); return;
      }
      const gpu = this.lease?.diagnostics();
      this.summary.update(gpu ? { ...data.data, gpuAcquired: true, gpu } : data.data); return;
    }
    if (data.kind === "output" || data.kind === "output-limit") {
      const line = document.createElement("span"); line.textContent = data.text + "\n";
      if (data.kind === "output-limit" || ["stderr", "error", "warn"].includes(data.stream)) line.className = "output-warning";
      this.output.append(line); return;
    }
    void this.finish(data);
  }

  private async finish(data: Extract<HostMessage, { kind: "done" | "failure" }>): Promise<void> {
    if (this.finishing) return;
    this.finishing = true;
    const generation = this.generation;
    let failure = data.kind === "failure" ? data.text : null;
    try { await this.lease?.close(); }
    catch (error) { failure = (failure ? failure + "\n" : "") + "GPU cleanup failed: " + String(error); }
    if (generation !== this.generation) return;
    if (this.lease) this.summary.updateGpu(this.lease.diagnostics());
    this.lease = null;
    this.root.dataset.state = failure === null ? "complete" : "error";
    this.summary.finish(failure === null ? "complete" : "error", performance.now() - this.started);
    this.status.textContent = failure === null ? "Finished." : "Could not finish. Check the output.";
    this.details.textContent = failure === null ? "" : "The run failed. A numerical result above does not mean the whole run succeeded.";
    if (failure !== null) {
      const error = document.createElement("span"); error.className = "output-error"; error.textContent = failure; this.output.append(error);
    }
    this.retire();
  }

  private async run(): Promise<void> {
    if (this.busy) return;
    const generation = ++this.generation;
    this.finishing = false; this.started = performance.now();
    this.summary.reset(this.language, this.device); this.summary.running();
    this.output.textContent = ""; this.details.textContent = ""; this.root.dataset.state = "loading";
    this.status.textContent = "Starting a fresh environment…"; this.setBusy(true);
    let pendingPort: MessagePort | null = null;
    try {
      if (!this.root.dataset.workerUrl) throw new Error("The playground worker URL is missing.");
      if (this.device === "webgpu" && (!isSecureContext || !("gpu" in navigator))) throw new Error("GPU support is unavailable in this browser. Choose CPU to run here.");
      let controller;
      if (this.device === "webgpu" && this.language === "python") {
        if (!crossOriginIsolated || typeof SharedArrayBuffer === "undefined") throw new Error("Python GPU mode needs extra browser security settings. Open the playground directly or choose CPU.");
        this.status.textContent = "Preparing GPU…";
        this.lease = new GpuLease();
        controller = await this.lease.acquire(this.root.dataset.runtimeBase ?? "");
        if (generation !== this.generation) return;
        this.summary.updateGpu(controller.diagnostics());
      }
      const worker = new Worker(this.root.dataset.workerUrl, { type: "module", name: "Tabgrad playground" }); this.worker = worker;
      const channel = new MessageChannel(); this.port = channel.port1; pendingPort = channel.port2;
      this.port.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (generation !== this.generation || this.worker !== worker) return;
        if (!isHostMessage(data)) { void this.finish({ kind: "failure", text: "Invalid playground response." }); return; }
        this.message(data);
      };
      worker.onerror = (event) => { if (generation === this.generation) { event.preventDefault(); void this.finish({ kind: "failure", text: event.message || "Worker failed to load." }); } };
      this.port.onmessageerror = () => { if (generation === this.generation) void this.finish({ kind: "failure", text: "Could not read the worker response." }); };
      worker.postMessage({ language: this.language, device: this.device, source: this.editor.value, port: pendingPort,
        runtimeBase: this.root.dataset.runtimeBase, pyodideBase: this.root.dataset.pyodideBase,
        ...(controller ? { webgpu: controller.connection } : {}),
      }, [pendingPort, ...(controller?.transferables ?? [])]);
      pendingPort = null;
    } catch (error) {
      pendingPort?.close();
      if (generation === this.generation) await this.finish({ kind: "failure", text: String(error) });
    }
  }
}

for (const root of document.querySelectorAll<HTMLElement>("[data-runner]")) {
  try { new Runner(root); }
  catch (error) { const status = root.querySelector(".run-status"); if (status) status.textContent = `Playground could not initialize: ${String(error)}`; }
}
