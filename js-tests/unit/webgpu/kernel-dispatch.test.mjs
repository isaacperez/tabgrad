import assert from "node:assert/strict";
import { test } from "node:test";
import { selectPipeline } from "../../../dist/backends/webgpu/kernel-dispatch.js";
import { webGpuKernel } from "../../../dist/backends/webgpu/kernel-catalogue.js";

test("windowed kernels cannot receive a grid pipeline identity", () => {
  const { direct } = webGpuKernel("reduce-f32");
  assert.equal(selectPipeline(direct, "linear").key, "reduce-f32/linear");
  assert.throws(() => selectPipeline(direct, "grid"), { code: "BACKEND_CAPABILITY_MISMATCH" });
});
