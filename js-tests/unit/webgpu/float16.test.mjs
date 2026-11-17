import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecutableProgram } from "../../../dist/execution/executable-program.js";
import { ExecutionTicket } from "../../../dist/execution/execution-ticket.js";
import { hostTensorPayload, decodeTensorPayload } from "../../../dist/execution/tensor-payload.js";
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
  const p = program([[1048577], [1048577], [1048577]]);
  const plan = planKernelDispatch(p.computations[0], p, { ...limits, maxComputeWorkgroupsPerDimension: 100 });
  assert.equal(plan.pipeline.layout, "grid");
  assert.equal(plan.dispatch.workgroups, Math.ceil(1048577 / 128));
});
