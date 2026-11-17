import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecutableProgram } from "../../../dist/execution/executable-program.js";
import { ExecutionTicket } from "../../../dist/execution/execution-ticket.js";
import { float32TensorPayload, decodeTensorPayload } from "../../../dist/execution/tensor-payload.js";
import { WebGpuBackend } from "../../../dist/backends/webgpu/webgpu-backend.js";
import { ConnectedWebGpuBackend, consumeWebGpuConnection } from "../../../dist/backends/webgpu/webgpu-connected-backend.js";
import { GPU_ACCOUNTED, GPU_CONTROL_LENGTH, GPU_METRIC_LENGTH, WEBGPU_PAYLOAD_PROTOCOL_VERSION } from "../../../dist/backends/webgpu/webgpu-connection.js";
import { publishSharedGpuSuccess } from "../../../dist/backends/webgpu/webgpu-shared-completion.js";
import { executionDevice } from "./helpers/webgpu-device.mjs";

function bindingProgram(length) {
  return new ExecutableProgram([{ slot: 0, storageSlot: 0, shape: [length], dtype: "float32", device: "webgpu",
    layout: "contiguous", source: "binding", provenance: { operation: "tensor", source: "test" } }], [], 0);
}

async function completed(value) {
  if (!(value instanceof ExecutionTicket)) return value;
  const result = await value.result;
  await value.drained;
  return result;
}

for (const count of [0, 1, 3]) {
  test(`direct GPU raw I/O preserves bounded ${count}-element bytes and observation ownership`, async () => {
    const device = executionDevice();
    const backend = new WebGpuBackend(device);
    const input = new Float32Array([99, -0, 1.25, Infinity, 99]).subarray(1, 1 + count);
    const payload = float32TensorPayload(input);
    let writes = 0;
    const write = device.queue.writeBuffer;
    device.queue.writeBuffer = (buffer, offset, data) => {
      writes++;
      assert.equal(data, payload.bytes, "upload uses the original bounded view without another host copy");
      write(buffer, offset, data);
    };
    try {
      const program = bindingProgram(count);
      await backend.prepare(program);
      const allocations = await completed(backend.execute(program, new Map([[0, { hostData: payload }]]), [true]));
      const allocation = allocations.get(0);
      const result = await completed(backend.read(allocation, count, "float32"));
      const numeric = decodeTensorPayload(result, "float32", count);
      assert.equal(numeric.buffer, result.bytes.buffer);
      assert.equal(result.bytes.buffer.byteLength, count * 4);
      assert.deepEqual([...numeric], [...input]);
      if (count) numeric[0] = 7;
      assert.deepEqual([...decodeTensorPayload(await completed(backend.read(allocation, count, "float32")), "float32", count)], [...input]);
      assert.equal(writes, count ? 1 : 0);
      assert.equal(backend.diagnostics().uploadBytes, count * 4);
      assert.equal(backend.diagnostics().readbackBytes, count * 8);
      backend.release(allocation);
      assert.equal(backend.diagnostics().ownedBufferBytes, 0);
    } finally { await backend.close(); }
    assert(device.buffers.every(buffer => buffer.destroyed));
  });
}

test("connected GPU transfers one bounded owned clone and escapes shared readback storage", async () => {
  const physical = new MessageChannel(), supervision = new MessageChannel();
  const control = new Int32Array(new SharedArrayBuffer(GPU_CONTROL_LENGTH * 4));
  const connection = { connectionType: "tabgrad-webgpu", protocolVersion: WEBGPU_PAYLOAD_PROTOCOL_VERSION,
    port: physical.port1, supervision: supervision.port1, control: control.buffer,
    metrics: new SharedArrayBuffer(GPU_METRIC_LENGTH * 8),
    capabilities: { device: "webgpu", computations: [], gradients: false, maximumTensorBytes: 1048576 },
    diagnostics: { state: "ready" } };
  for (const protocolVersion of [undefined, 1, 3]) {
    assert.throws(() => consumeWebGpuConnection({ ...connection, protocolVersion }), { code: "BACKEND_LOAD_FAILED" });
  }
  consumeWebGpuConnection(connection);
  const input = new Float32Array([99, 1, 2, 99]);
  let readCompletion;
  physical.port1.postMessage = (message, transferables) => {
    const packet = structuredClone(message, { transfer: transferables ?? [] });
    if (packet.kind === "execute") {
      assert.equal(transferables.length, 1);
      assert.equal(transferables[0].byteLength, 0, "only the transport's private clone is detached");
      const payload = packet.bindings[0].hostData;
      assert.equal(payload.bytes.buffer.byteLength, 8);
      assert.deepEqual([...decodeTensorPayload(payload, "float32", 2)], [1, 2]);
      publishSharedGpuSuccess(packet.completion, control, new Uint8Array(new Float64Array([0, 1]).buffer));
    } else if (packet.kind === "read") {
      assert.equal(packet.dtype, "float32");
      readCompletion = packet.completion;
      publishSharedGpuSuccess(packet.completion, control, new Uint8Array(new Float32Array([1, 2]).buffer));
    } else if (packet.kind === "close") Atomics.store(control, GPU_ACCOUNTED, 1);
    else publishSharedGpuSuccess(packet.completion, control, new Uint8Array());
  };
  const backend = new ConnectedWebGpuBackend(connection);
  try {
    const allocations = await completed(backend.execute(bindingProgram(2), new Map([[0, {
      hostData: float32TensorPayload(input.subarray(1, 3)),
    }]]), [true]));
    assert.equal(input.buffer.byteLength, 16);
    assert.deepEqual([...input], [99, 1, 2, 99]);
    const result = await completed(backend.read(allocations.get(0), 2, "float32"));
    assert.notEqual(result.bytes.buffer, readCompletion);
    const numeric = decodeTensorPayload(result, "float32", 2);
    assert.equal(numeric.buffer, result.bytes.buffer);
    new Uint8Array(readCompletion).fill(0);
    assert.deepEqual([...numeric], [1, 2]);
    backend.release(allocations.get(0));
  } finally {
    Atomics.store(control, GPU_ACCOUNTED, 1);
    await backend.close(); physical.port2.close(); supervision.port2.close();
  }
});
