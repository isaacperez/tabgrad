import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecutableProgram } from "../../../dist/execution/executable-program.js";
import { ExecutionTicket } from "../../../dist/execution/execution-ticket.js";
import { hostTensorPayload, decodeTensorPayload } from "../../../dist/execution/tensor-payload.js";
import { createConnectedRuntimeSession } from "../../../dist/runtime/runtime.js";
import { WebGpuBackend } from "../../../dist/backends/webgpu/webgpu-backend.js";
import { planKernelDispatch, pipelineSource } from "../../../dist/backends/webgpu/kernel-dispatch.js";
import { executionDevice } from "./helpers/webgpu-device.mjs";

async function completed(value) {
  if (!(value instanceof ExecutionTicket)) return value;
  const result = await value.result; await value.drained; return result;
}
const provenance = { operation: "half-test", source: "test" };
function program(shapes, kind = "add-f16") {
  const values = shapes.map((shape, slot) => ({ slot, storageSlot: slot, shape, dtype: "float16", device: "webgpu",
    layout: "contiguous", source: slot === 2 ? "computed" : "binding", provenance }));
  return new ExecutableProgram(values, shapes.length === 1 ? [] : [{ kind, inputs: [0, 1], output: 2, provenance }], shapes.length - 1);
}

for (const [limit, value] of [["maxBufferSize", 8], ["maxStorageBufferBindingSize", 8], ["maxStorageBuffersPerShaderStage", 3]]) {
  test(`packed kernels are unavailable before device work when ${limit} is too small`, async () => {
    const device = executionDevice();
    device.limits[limit] = value;
    const backend = new WebGpuBackend(device);
    try {
      for (const kind of ["add-f16", "mul-f16"]) {
        assert(!backend.capabilities.computations.includes(kind));
        assert.throws(() => backend.prepare(program([[1], [1], [1]], kind)),
          { code: "BACKEND_CAPABILITY_MISMATCH" });
      }
      assert.equal(device.buffers.length, 0);
      assert.equal(device.shaderSources.length, 0);
    } finally { await backend.close(); }
  });
}
test("a GPU can create and observe float16 without offering float16 arithmetic", async () => {
  const device = executionDevice();
  device.limits.maxStorageBuffersPerShaderStage = 3;
  const backend = new WebGpuBackend(device);
  const session = createConnectedRuntimeSession(backend);
  const input = session.tensor([1, 2], { dtype: "float16", device: "webgpu" });
  const view = input.view([1, 2]);
  try {
    assert.ok(backend.capabilities.storageEncodings.includes("ieee754-binary16-native"));
    assert.throws(() => view.add(view), { code: "BACKEND_CAPABILITY_MISMATCH" });
    assert.deepEqual([...await view.toArray()], [1, 2]);
    assert.deepEqual([...await input.toArray()], [1, 2]);
    assert.equal(backend.diagnostics().uploadBytes, 4, "the alias borrows the same resident tensor");
    assert.equal(backend.diagnostics().kernelCalls, 0);
  } finally {
    view.close();
    input.close();
    await session.close();
  }
});

for (const count of [0, 1, 2, 3, 5]) {
  test(`half GPU ${count}-element bounded transfers align physical bytes without exposing padding`, async () => {
    const device = executionDevice();
    let writes = 0, copiedBytes = 0;
    const write = device.queue.writeBuffer;
    device.queue.writeBuffer = (buffer, offset, data) => {
      assert.equal(offset % 4, 0);
      assert.equal(data.byteLength % 4, 0, "GPU upload requires whole words");
      writes++; write(buffer, offset, data);
    };
    const encoder = device.createCommandEncoder;
    device.createCommandEncoder = () => {
      const result = encoder(); const copy = result.copyBufferToBuffer;
      result.copyBufferToBuffer = (...args) => { assert.equal(args[4] % 4, 0); copiedBytes += args[4]; copy(...args); };
      return result;
    };
    const backend = new WebGpuBackend(device);
    const input = new Uint16Array([0xffff, 0x8000, 0x3d00, 0x7c00, 1, 0x7bff, 0xffff]);
    const payload = hostTensorPayload("float16", count, new Uint8Array(input.buffer, 2, count * 2));
    try {
      const p = program([[count]]);
      const allocations = await completed(backend.execute(p, new Map([[0, { hostData: payload }]]), [true]));
      const allocation = allocations.get(0);
      const observed = await completed(backend.read(allocation, count, "float16"));
      assert.equal(observed.bytes.byteLength, count * 2);
      assert.equal(observed.bytes.buffer.byteLength, count * 2);
      assert.deepEqual([...new Uint16Array(observed.bytes.buffer)], [...input.subarray(1, count + 1)]);
      assert.equal(decodeTensorPayload(observed, "float16", count).length, count);
      assert.equal(copiedBytes, Math.ceil(count / 2) * 4);
      assert.equal(writes, count === 0 ? 0 : count % 2 && count > 1 ? 2 : 1);
      backend.release(allocation);
      assert.equal(backend.diagnostics().ownedBufferBytes, 0);
    } finally { await backend.close(); }
    assert(device.buffers.every(buffer => buffer.destroyed));
  });
}

test("half GPU dispatch owns complete output words and projects both broadcast lanes independently", () => {
  const limits = { maxBufferSize: 128 * 1024 ** 2, maxStorageBufferBindingSize: 128 * 1024 ** 2, maxComputeWorkgroupsPerDimension: 65535 };
  for (const shapes of [[[3], [3], [3]], [[2, 3], [3], [2, 3]], [[3, 1], [1, 3], [3, 3]]]) {
    for (const kind of ["add-f16", "mul-f16"]) {
      const p = program(shapes, kind);
      const plan = planKernelDispatch(p.computations[0], p, limits);
      assert.equal(plan.path, "pointwise");
      assert.equal(plan.words[2], 2);
      assert.equal(plan.dispatch.workgroups, 1);
      const source = pipelineSource(plan.pipeline);
      assert.match(source, /first \+ lane/);
      assert.match(source, /index < geometry\[1\]/);
      assert.match(source, /output\[word_index\] = packed/);
      assert(!source.includes("enable f16"));
    }
  }
  for (const shapes of [[[2181], [2181], [2181]], [[727, 1], [1, 3], [727, 3]]]) {
    const p = program(shapes);
    const plan = planKernelDispatch(p.computations[0], p, { ...limits, maxComputeWorkgroupsPerDimension: 17 });
    assert.equal(plan.pipeline.layout, "grid");
    assert.equal(plan.dispatch.workgroups, Math.ceil(2181 / 128));
    assert.equal(plan.words[1], 2181);
  }
});

test("packed pipelines stay bounded across distinct dense and broadcast shapes", async () => {
  const device = executionDevice();
  device.limits.maxComputeWorkgroupsPerDimension = 17;
  const backend = new WebGpuBackend(device);
  try {
    assert.deepEqual(backend.capabilities.computations, [
      "add-f32", "add-alpha-f32", "matmul-f32", "mul-f32", "add-f16", "mul-f16", "sum-f32", "reduce-f32", "expand-f32", "sum-f16", "matmul-f16", "add-bf16", "mul-bf16", "gt-f32", "where-f32", "where-then-gradient-f32", "where-else-gradient-f32", "sum-bf16", "matmul-bf16",
    ]);
    for (const rows of [729, 3, 727, 1, 727]) {
      for (const shapes of [[[rows, 3], [rows, 3], [rows, 3]], [[rows, 1], [1, 3], [rows, 3]]]) {
        for (const kind of ["add-f16", "mul-f16"]) await backend.prepare(program(shapes, kind));
      }
    }
    assert.equal(device.shaderSources.length, 8, "one pipeline per kernel, access pattern and index layout");
    assert.equal(device.buffers.length, 0);
  } finally { await backend.close(); }
});
