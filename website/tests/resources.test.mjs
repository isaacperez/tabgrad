import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { deviceState, formatBytes } from "../src/playground/run-summary.ts";
import { exampleSource } from "../src/playground/presets.ts";

const cpu = { wasmMemoryBytes: 65536, peakAllocationBytes: 0, kernelCalls: 0 };
const gpu = { state: "closed", adapter: { vendor: "", architecture: "", device: "", description: "", isFallbackAdapter: false },
  ownedBufferBytes: 0, peakOwnedBufferBytes: 64, pendingSubmissions: 0, unknownCompletionBytes: 0, kernelCalls: 1, uploadBytes: 8, readbackBytes: 4 };
const data = { language: "javascript", device: "webgpu", gpuAcquired: true, programMilliseconds: 0, cpu, gpu };

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
