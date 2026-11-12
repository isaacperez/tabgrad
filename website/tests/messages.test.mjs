import assert from "node:assert/strict";
import test from "node:test";
import { isHostMessage } from "../src/playground/messages.ts";

test("only recognized text messages and acknowledged success enter the UI", () => {
  for (const message of [
    { kind: "stage", text: "Loading" }, { kind: "failure", text: "Failed" },
    { kind: "output-limit", text: "Truncated" }, { kind: "output", stream: "log", text: "42" },
    { kind: "done", cleanup: "acknowledged" },
  ]) assert.equal(isHostMessage(structuredClone(message)), true);
  for (const message of [null, 1, "done", {}, { kind: "done" }, { kind: "done", cleanup: "unconfirmed" },
    { kind: "output", text: "42" }, { kind: "failure", text: 42 }, { kind: "stage", text: undefined },
    { kind: new String("stage"), text: "not a string discriminator" },
  ]) assert.equal(isHostMessage(structuredClone(message)), false);
});

test("scoped run resources accept real local Python CPU data and distinguish unavailable observations", () => {
  const cpu = { wasmMemoryBytes: 65536, peakAllocationBytes: 0, kernelCalls: 0, hostToWasmBytes: 0, hostToWasmCopies: 0, wasmToHostBytes: 0, wasmToHostCopies: 0 };
  const data = { language: "javascript", device: "cpu", gpuAcquired: false, programMilliseconds: 0, cpu, gpu: null };
  assert.equal(isHostMessage({ kind: "resources", data }), true);
  assert.equal(isHostMessage({ kind: "resources", data: { ...data, language: "python", device: "webgpu", gpuAcquired: true, cpu: null } }), true);
  assert.equal(isHostMessage({ kind: "resources", data: { ...data, language: "python" } }), true);
  for (const language of ["python", "javascript"]) assert.equal(isHostMessage({ kind: "resources", data: {
    ...data, language, cpu: { ...cpu, wasmMemoryBytes: null, peakAllocationBytes: null },
  } }), true);
  for (const invalid of [
    { ...data, programMilliseconds: NaN }, { ...data, programMilliseconds: -1 },
    { ...data, cpu: { ...cpu, wasmMemoryBytes: -1 } },
    { ...data, cpu: { ...cpu, kernelCalls: null } },
    { ...data, language: "python", cpu: { ...cpu, hostToWasmCopies: NaN } },
    { ...data, language: "python", cpu: { ...cpu, wasmToHostBytes: -1 } },
    { ...data, language: "python", device: "cpu", gpuAcquired: true }, { ...data, device: "cuda" },
    { ...data, language: new String("javascript") },
    { ...data, gpu: { state: "ready", ownedBufferBytes: 0 } },
  ]) assert.equal(isHostMessage({ kind: "resources", data: invalid }), false);
});
