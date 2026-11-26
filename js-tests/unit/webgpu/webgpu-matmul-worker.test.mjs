import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { test } from "node:test";
import { captureTensorData, float32TensorPayload } from "../../../dist/execution/tensor-payload.js";
import { ConnectedWebGpuBackend } from "../../../dist/backends/webgpu/webgpu-connected-backend.js";
import { ExecutableProgram } from "../../../dist/execution/executable-program.js";
import { WEBGPU_PAYLOAD_PROTOCOL_VERSION, GPU_CONTROL_LENGTH, GPU_METRIC_LENGTH } from "../../../dist/backends/webgpu/webgpu-connection.js";

function matrixProgram(flags = 0, empty = false) {
  const provenance = { operation: "matmul", source: "Tensor.matmul" };
  const m = empty ? 0 : 2, k = 3, n = 4;
  const shapes = [flags & 1 ? [k, m] : [m, k], flags & 2 ? [n, k] : [k, n], [m, n]];
  const values = shapes.map((shape, slot) => ({ slot, storageSlot: slot, shape, dtype: "float32",
    device: "webgpu", layout: "contiguous", source: slot === 2 ? "computed" : "binding", provenance }));
  return new ExecutableProgram(values, [{ kind: "matmul-f32", matrixFlags: flags, inputs: [0, 1], output: 2, provenance }], 2);
}

test("actual GPU worker checks resident formats and reconstructs matrix packets", async () => {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL("./helpers/physical-worker.mjs", import.meta.url),
    { workerData: { gate: gate.buffer, mode: "success" } });
  const physical = new MessageChannel(), supervision = new MessageChannel();
  const control = new SharedArrayBuffer(GPU_CONTROL_LENGTH * 4), metrics = new SharedArrayBuffer(GPU_METRIC_LENGTH * 8);
  const ready = Promise.withResolvers(), closed = Promise.withResolvers(), inspection = Promise.withResolvers();
  const post = physical.port1.postMessage.bind(physical.port1);
  let corruptProgram;
  let executions = 0;
  physical.port1.postMessage = (message, transfer) => {
    if (message.kind === "execute") {
      executions += 1;
      if (corruptProgram !== undefined) {
        const program = structuredClone(message.program);
        corruptProgram(program);
        message = { ...message, program };
      }
    }
    return post(message, transfer);
  };
  worker.on("message", message => {
    if (message.kind === "ready") ready.resolve(message);
    if (message.kind === "closed") closed.resolve();
    if (message.kind === "inspection") inspection.resolve(message);
  });
  worker.on("error", error => { ready.reject(error); closed.reject(error); });
  let backend;
  try {
    worker.postMessage({ kind: "initialize", protocolVersion: WEBGPU_PAYLOAD_PROTOCOL_VERSION, port: physical.port2, control, metrics }, [physical.port2]);
    const advertised = await ready.promise;
    backend = new ConnectedWebGpuBackend({ connectionType: "tabgrad-webgpu", protocolVersion: WEBGPU_PAYLOAD_PROTOCOL_VERSION,
      port: physical.port1, supervision: supervision.port1, control, metrics,
      capabilities: advertised.capabilities, diagnostics: advertised.diagnostics });
    assert.ok(advertised.capabilities.computations.includes("matmul-f32"));
    const unsupported = structuredClone(matrixProgram());
    unsupported.values[0].dtype = "invalid";
    assert.throws(() => backend.execute(unsupported, new Map(), [false, false, false]), TypeError);
    assert.equal(executions, 0, "host type rejection precedes the physical request");
    const input = new ExecutableProgram([{
      ...matrixProgram().values[0], shape: [1],
    }], [], 0);
    const initial = backend.execute(input, new Map([[0, {
      hostData: captureTensorData([7], "float32"),
    }]]), [true]);
    const allocation = (await initial.result).get(0);
    await initial.drained;
    const beforeMismatch = backend.diagnostics();
    const wrongRead = backend.read(allocation, 2, "float16");
    await assert.rejects(wrongRead.result, { code: "BACKEND_STATUS_ERROR" });
    await wrongRead.drained;

    // The logical request is well formed, but its borrowed physical identity
    // uses float32. Put the resident after a valid host binding.
    const host = { ...input.values[0], dtype: "float16", shape: [2] };
    const wrongProgram = new ExecutableProgram([
      host, { ...host, slot: 1, storageSlot: 1 }, { ...host, slot: 2, storageSlot: 2, source: "computed" },
    ], [{ kind: "add-f16", inputs: [0, 1], output: 2, provenance: host.provenance }], 2);
    const wrongBinding = backend.execute(wrongProgram, new Map([
      [0, { hostData: captureTensorData([1, 2], "float16") }], [1, { resident: allocation }],
    ]), [true, true, true]);
    await assert.rejects(wrongBinding.result, { code: "BACKEND_STATUS_ERROR" });
    await wrongBinding.drained;
    assert.deepEqual(backend.diagnostics(), beforeMismatch);
    const original = backend.read(allocation, 1, "float32");
    assert.deepEqual([...new Float32Array((await original.result).bytes.buffer)], [7]);
    await original.drained;
    backend.release(allocation);

    for (const empty of [false, true]) {
      const mutations = [
        ...[undefined, -1, 0.5, NaN, 4, "0"].map(flags => p => { p.computations[0].matrixFlags = flags; }),
        ...["dtype", "layout", "device", "slot", "storageSlot"].map(field => p => { p.values[0][field] = "invalid"; }),
        p => { p.values[2].shape = [4, empty ? 0 : 2]; },
        p => { p.computations[0].inputs = [0]; },
        p => { p.computations[0].inputs = [0, 99]; },
      ];
      for (const mutate of mutations) {
        // Corrupt the serialized packet after host admission, preserving the
        // physical worker's independent untrusted reconstruction boundary.
        corruptProgram = mutate;
        const ticket = backend.execute(matrixProgram(0, empty), new Map(), [false, false, false]);
        await assert.rejects(ticket.result, error => error.code === "BACKEND_STATUS_ERROR" && error.cause.name === "TypeError");
        await ticket.drained;
        assert.equal(backend.diagnostics().ownedBufferBytes, 0);
        assert.equal(backend.diagnostics().kernelCalls, 0);
      }
    }
    corruptProgram = undefined;
    for (const flags of [0, 1, 2, 3]) {
      const program = matrixProgram(flags);
      const bindings = new Map([[0, { hostData: float32TensorPayload(new Float32Array(6)) }], [1, { hostData: float32TensorPayload(new Float32Array(12)) }]]);
      const ticket = backend.execute(program, bindings, [false, false, false]);
      const allocations = await ticket.result; await ticket.drained;
      for (const allocation of allocations.values()) backend.release(allocation);
    }
    await backend.close();
    worker.postMessage({ kind: "inspect" }); const result = await inspection.promise;
    assert.equal(result.shaderCount, 1);
    assert.deepEqual(result.coefficientPackets, [0, 1, 2, 3].map(flags => [2, 4, 3, flags]));
    assert.deepEqual(result.dispatches, [1, 1, 1, 1]);
    assert.equal(result.liveRequests, 0); assert.equal(result.buffersDestroyed, true);
  } finally {
    if (backend) await backend.close(); else worker.postMessage({ kind: "close" });
    await closed.promise; await worker.terminate();
    physical.port1.close(); supervision.port1.close(); supervision.port2.close();
  }
});
