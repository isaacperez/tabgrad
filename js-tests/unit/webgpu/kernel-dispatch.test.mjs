import assert from "node:assert/strict";
import { test } from "node:test";
import { selectPipeline } from "../../../dist/backends/webgpu/kernel-dispatch.js";

test("windowed kernels cannot receive a grid pipeline identity", () => {
  assert.equal(selectPipeline("reduce-f32", "linear").key, "reduce-f32/linear");
  assert.throws(() => selectPipeline("reduce-f32", "grid"), { code: "BACKEND_CAPABILITY_MISMATCH" });
});
