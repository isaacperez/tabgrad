import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { test } from "node:test";
import { ConnectedWebGpuBackend } from "../../../dist/backends/webgpu/webgpu-connected-backend.js";
import { ExecutableProgram } from "../../../dist/execution/executable-program.js";
import { GPU_CONTROL_LENGTH, GPU_METRIC_LENGTH } from "../../../dist/backends/webgpu/webgpu-connection.js";

function program(length, alphaBits) {
  const provenance = { operation: "add", source: "SGD.step" };
  const values = [0, 1, 2].map(slot => ({ slot, storageSlot: slot, shape: [length], dtype: "float32",
    device: "webgpu", layout: "contiguous", source: slot === 2 ? "computed" : "binding", provenance }));
  return new ExecutableProgram(values, [{ kind: "add-alpha-f32", alphaBits, inputs: [0, 1], output: 2, provenance }], 2);
}

test("packaged physical worker validates empty coefficient metadata and preserves immutable packets", async () => {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL("./helpers/physical-worker.mjs", import.meta.url),
    { workerData: { gate: gate.buffer, mode: "success" } });
  const physical = new MessageChannel(), supervision = new MessageChannel();
  const control = new Int32Array(new SharedArrayBuffer(GPU_CONTROL_LENGTH * 4));
  const metrics = new SharedArrayBuffer(GPU_METRIC_LENGTH * 8);
  const ready = Promise.withResolvers(), closed = Promise.withResolvers(), inspection = Promise.withResolvers();
  worker.on("message", message => {
    if (message.kind === "ready") ready.resolve(message);
    if (message.kind === "closed") closed.resolve();
    if (message.kind === "inspection") inspection.resolve(message);
  });
  worker.on("error", error => { ready.reject(error); closed.reject(error); });
  let backend;
  try {
    worker.postMessage({ kind: "initialize", port: physical.port2, control: control.buffer, metrics }, [physical.port2]);
    const advertised = await ready.promise;
    backend = new ConnectedWebGpuBackend({ connectionType: "tabgrad-webgpu", protocolVersion: 1,
      port: physical.port1, supervision: supervision.port1, control: control.buffer, metrics,
      capabilities: advertised.capabilities, diagnostics: advertised.diagnostics });
    for (const alpha of [undefined, -1, 0.5, NaN, 0x100000000, "0"]) {
      const definition = structuredClone(program(0, 0));
      definition.computations[0].alphaBits = alpha;
      const ticket = backend.execute(definition, new Map([[0, { hostData: new Float32Array() }],
        [1, { hostData: new Float32Array() }]]), [false, false, false]);
      await assert.rejects(ticket.result, error => {
        assert.equal(error.code, "BACKEND_STATUS_ERROR");
        assert.equal(error.cause.name, "TypeError");
        assert.equal(error.cause.message, "Coefficient addition requires captured binary32 bits.");
        return true;
      });
      await ticket.drained;
      assert.equal(backend.diagnostics().ownedBufferBytes, 0);
      assert.equal(backend.diagnostics().kernelCalls, 0);
    }
    const alphas = [0, 1, 0x80000000, 0xbdcccccd, 0x3f000000, 0x7fc00000];
    for (const alpha of alphas) {
      const ticket = backend.execute(program(1, alpha), new Map([[0, { hostData: new Float32Array([2]) }],
        [1, { hostData: new Float32Array([3]) }]]), [false, false, false]);
      const retained = await ticket.result; await ticket.drained;
      for (const allocation of retained.values()) backend.release(allocation);
    }
    await backend.close();
    worker.postMessage({ kind: "inspect" }); const result = await inspection.promise;
    assert.equal(result.shaderCount, 1);
    assert.deepEqual(result.coefficientPackets, alphas.map(alpha => [alpha, 0, 0, 0]));
    assert.deepEqual(result.dispatches, alphas.map(() => 1));
    assert.equal(result.liveRequests, 0);
    assert.equal(result.buffersDestroyed, true);
  } finally {
    if (backend) await backend.close(); else worker.postMessage({ kind: "close" });
    await closed.promise; await worker.terminate();
    physical.port1.close(); supervision.port1.close(); supervision.port2.close();
  }
});
