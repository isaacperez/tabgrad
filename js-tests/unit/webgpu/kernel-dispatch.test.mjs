import assert from "node:assert/strict";
import { test } from "node:test";
import { planKernelDispatch, selectPipeline } from "../../../dist/backends/webgpu/kernel-dispatch.js";
import { webGpuKernel } from "../../../dist/backends/webgpu/kernel-catalogue.js";

test("windowed kernels cannot receive a grid pipeline identity", () => {
  const { direct } = webGpuKernel("reduce-f32");
  assert.equal(selectPipeline(direct, "linear").key, "reduce-f32/linear");
  assert.equal(selectPipeline(direct, "linear"), selectPipeline(direct, "linear"));
  assert.throws(() => selectPipeline(direct, "grid"), { code: "BACKEND_CAPABILITY_MISMATCH" });
});

test("float16 sum stages size private partials independently of packed scalar storage", () => {
  const computation = { kind: "sum-f16", inputs: [0], output: 1 };
  const program = { values: [{ shape: [16385] }, { shape: [] }] };
  const limits = { maxBufferSize: 64 * 1024, maxStorageBufferBindingSize: 64 * 1024,
    maxComputeWorkgroupsPerDimension: 17 };
  const { path, stages } = planKernelDispatch(computation, program, limits);
  assert.equal(path, "sum");
  assert.deepEqual(stages.map(({ count, bytes, dispatch, partial, final }) => [count, bytes, dispatch.layout, partial, final]), [
    [16385, 2064, "grid", false, false],
    [129, 32, "linear", true, false],
    [2, 4, "linear", true, true],
  ]);
  assert.throws(() => planKernelDispatch(computation, program, { ...limits, maxStorageBufferBindingSize: 2060 }),
    { code: "RESOURCE_EXHAUSTED" });
});
