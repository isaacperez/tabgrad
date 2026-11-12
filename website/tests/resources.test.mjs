import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { deviceState, formatBytes, RunSummary } from "../src/playground/run-summary.ts";
import { exampleSource } from "../src/playground/presets.ts";

const cpu = { wasmMemoryBytes: 65536, peakAllocationBytes: 0, kernelCalls: 0 };
const gpu = { state: "closed", adapter: { vendor: "", architecture: "", device: "", description: "", isFallbackAdapter: false },
  ownedBufferBytes: 0, peakOwnedBufferBytes: 64, pendingSubmissions: 0, unknownCompletionBytes: 0, kernelCalls: 1, uploadBytes: 8, readbackBytes: 4 };
const data = { language: "javascript", device: "webgpu", gpuAcquired: true, programMilliseconds: 0, cpu, gpu };

/** Minimal fields for the actual renderer, with isolated DOM globals. */
function summaryFixture(context) {
  class Field { textContent = ""; parentElement = { hidden: false }; }
  const previous = globalThis.HTMLElement;
  globalThis.HTMLElement = Field;
  context.after(() => {
    if (previous === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = previous;
  });
  const fields = new Map();
  const root = { querySelector(selector) { if (!fields.has(selector)) fields.set(selector, new Field()); return fields.get(selector); } };
  return { summary: new RunSummary(root), fields };
}

test("measurement guidance distinguishes idle, preparing and unavailable runs", (context) => {
  const { summary, fields } = summaryFixture(context);
  for (const device of ["cpu", "webgpu"]) {
    summary.reset("python", device);
    assert.equal(fields.get("[data-resource-note]").textContent, "Run the code to see the available measurements.");
    summary.running();
    assert.equal(fields.get("[data-resource-note]").textContent, "Measurements are not available yet.");
    for (const outcome of ["error", "stopped"]) {
      summary.finish(outcome, 25);
      assert.equal(fields.get("[data-resource-time]").textContent, "25 ms", "page-owned elapsed time is still measured without runtime observations");
      assert.equal(fields.get("[data-resource-note]").textContent, "Only the elapsed time is available for this run.");
    }
  }
});

for (const language of ["javascript", "python"]) test(`${language} GPU completion requires a successful script, drain and encoded GPU work`, () => {
  const observed = { ...data, language, cpu: language === "python" ? null : cpu };
  assert.equal(deviceState("complete", "webgpu", observed), "GPU work completed");
  for (const change of [{ pendingSubmissions: 1 }, { unknownCompletionBytes: 4 }, { state: "ready" }]) {
    assert.equal(deviceState("complete", "webgpu", { ...observed, gpu: { ...gpu, ...change } }), "Completion unconfirmed");
  }
  assert.equal(deviceState("complete", "webgpu", { ...observed, gpu: { ...gpu, kernelCalls: 0 } }), "Enabled · no GPU calculations");
  assert.equal(deviceState("complete", "webgpu", { ...observed, gpu: { ...gpu, adapter: { ...gpu.adapter, isFallbackAdapter: true } } }), "Finished using software");
  assert.equal(deviceState("complete", "webgpu", { ...observed, gpu: { ...gpu, adapter: { ...gpu.adapter, isFallbackAdapter: null } } }), "Finished · GPU type not reported");
  assert.equal(deviceState("complete", "webgpu", { ...observed, gpu: null }), "Completion unconfirmed");
  assert.equal(deviceState("error", "webgpu", observed), "Run failed");
  assert.equal(deviceState("stopped", "webgpu", observed), "Stopped · cleanup unconfirmed");
  assert.equal(deviceState("running", "webgpu", observed), "Device ready");
  assert.equal(deviceState("running", "webgpu", null), "Preparing GPU");
});

test("resource sizes retain measured zero and identify their units", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1,023 B");
  assert.equal(formatBytes(1024), "1 KiB");
  assert.equal(formatBytes(1048576), "1 MiB");
});

test("unknown CPU memory stays unavailable while valid counters remain visible", (context) => {
  const { summary, fields } = summaryFixture(context);
  summary.reset("python", "cpu");
  const observation = { language: "python", device: "cpu", gpuAcquired: false, gpu: null, programMilliseconds: 12,
    cpu: { wasmMemoryBytes: null, peakAllocationBytes: null, kernelCalls: 3,
      hostToWasmBytes: 8, hostToWasmCopies: 1, wasmToHostBytes: 4, wasmToHostCopies: 1 } };
  summary.update(observation);
  summary.finish("error", 25);
  assert.equal(fields.get("[data-resource-memory]").textContent, "Unavailable");
  assert.equal(fields.get("[data-resource-wasm]").textContent, "Unavailable");
  assert.equal(fields.get("[data-resource-cpu-kernels]").textContent, "3");
  assert.equal(fields.get("[data-resource-cpu-transfer]").textContent, "8 B (1 copy) / 4 B (1 copy)");
  summary.update({ ...observation, cpu: { ...observation.cpu, wasmMemoryBytes: 65536, peakAllocationBytes: 0 } });
  assert.equal(fields.get("[data-resource-memory]").textContent, "0 B", "a measured zero remains distinct");
});

test("all curated programs explicitly place their tensors on the selected device", async () => {
  const catalog = JSON.parse(await readFile(new URL("../src/playground/examples.json", import.meta.url), "utf8"));
  for (const example of catalog) for (const language of ["python", "javascript"]) for (const device of ["cpu", "webgpu"]) {
    const source = exampleSource(example, language, device);
    assert.match(source, new RegExp(`device = "${device}"`));
    if (language === "python") {
      assert.ok(source.startsWith("import torch\n\n"));
      assert.equal((source.match(/torch.tensor\(/g) ?? []).length, (source.match(/device=device/g) ?? []).length);
    } else {
      assert.equal((source.match(/session.tensor\(/g) ?? []).length, (example.javascript.code.match(/\bdevice[, }]/g) ?? []).length);
    }
  }
});
