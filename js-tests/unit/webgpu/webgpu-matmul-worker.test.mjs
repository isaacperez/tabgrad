import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { test } from "node:test";
import { ConnectedWebGpuBackend } from "../../../dist/backends/webgpu/webgpu-connected-backend.js";
import { ExecutableProgram } from "../../../dist/execution/executable-program.js";
import { GPU_CONTROL_LENGTH, GPU_METRIC_LENGTH } from "../../../dist/backends/webgpu/webgpu-connection.js";

function matrixProgram(flags = 0, empty = false) {
  const provenance = { operation: "matmul", source: "Tensor.matmul" };
  const m = empty ? 0 : 2, k = 3, n = 4;
  const shapes = [flags & 1 ? [k, m] : [m, k], flags & 2 ? [n, k] : [k, n], [m, n]];
  const values = shapes.map((shape, slot) => ({ slot, storageSlot: slot, shape, dtype: "float32",
    device: "webgpu", layout: "contiguous", source: slot === 2 ? "computed" : "binding", provenance }));
  return new ExecutableProgram(values, [{ kind: "matmul-f32", matrixFlags: flags, inputs: [0, 1], output: 2, provenance }], 2);
}

test("actual GPU worker reconstructs matrix packets and rejects malformed empty and nonempty metadata", async () => {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL("./helpers/physical-worker.mjs", import.meta.url),
    { workerData: { gate: gate.buffer, mode: "success" } });
  const physical = new MessageChannel(), supervision = new MessageChannel();
  const control = new SharedArrayBuffer(GPU_CONTROL_LENGTH * 4), metrics = new SharedArrayBuffer(GPU_METRIC_LENGTH * 8);
  const ready = Promise.withResolvers(), closed = Promise.withResolvers(), inspection = Promise.withResolvers();
  worker.on("message", message => {
    if (message.kind === "ready") ready.resolve(message);
    if (message.kind === "closed") closed.resolve();
    if (message.kind === "inspection") inspection.resolve(message);
  });
  worker.on("error", error => { ready.reject(error); closed.reject(error); });
  let backend;
  try {
    worker.postMessage({ kind: "initialize", port: physical.port2, control, metrics }, [physical.port2]);
    const advertised = await ready.promise;
    backend = new ConnectedWebGpuBackend({ connectionType: "tabgrad-webgpu", protocolVersion: 1,
      port: physical.port1, supervision: supervision.port1, control, metrics,
      capabilities: advertised.capabilities, diagnostics: advertised.diagnostics });
    assert.ok(advertised.capabilities.computations.includes("matmul-f32"));
    for (const empty of [false, true]) {
      const mutations = [
        ...[undefined, -1, 0.5, NaN, 4, "0"].map(flags => p => { p.computations[0].matrixFlags = flags; }),
        ...["dtype", "layout", "device", "slot", "storageSlot"].map(field => p => { p.values[0][field] = "invalid"; }),
        p => { p.values[2].shape = [4, empty ? 0 : 2]; },
        p => { p.computations[0].inputs = [0]; },
        p => { p.computations[0].inputs = [0, 99]; },
      ];
      for (const mutate of mutations) {
        const packet = structuredClone(matrixProgram(0, empty)); mutate(packet);
        const ticket = backend.execute(packet, new Map(), [false, false, false]);
        await assert.rejects(ticket.result, error => error.code === "BACKEND_STATUS_ERROR" && error.cause.name === "TypeError");
        await ticket.drained;
        assert.equal(backend.diagnostics().ownedBufferBytes, 0);
        assert.equal(backend.diagnostics().kernelCalls, 0);
      }
    }
    for (const flags of [0, 1, 2, 3]) {
      const program = matrixProgram(flags);
      const bindings = new Map([[0, { hostData: new Float32Array(6) }], [1, { hostData: new Float32Array(12) }]]);
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
