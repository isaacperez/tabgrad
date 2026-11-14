import assert from "node:assert/strict";
import { test } from "node:test";
import { WebGpuBackend } from "../../../dist/backends/webgpu/webgpu-backend.js";
import { createConnectedRuntimeSession } from "../../../dist/runtime/runtime.js";
import { executionDevice } from "./helpers/webgpu-device.mjs";
import { ExecutableProgram } from "../../../dist/execution/executable-program.js";
import { receivingGeometry, pointwiseGeometry } from "../../../dist/execution/broadcast-geometry.js";
import { receivingStages, pointwiseParameters } from "../../../dist/backends/webgpu/broadcast-dispatch.js";

function mixedProgram(kind, shift = 0) {
  const provenance = { operation: kind, source: "test" }, shapes = [
    ...Array.from({ length: shift }, () => []), [2, 3], [2, 3], [2, 3], [3], [2, 3],
  ];
  const values = shapes.map((shape, slot) => ({ slot, storageSlot: slot, shape, dtype: "float32", device: "webgpu", layout: "contiguous",
    source: slot === shift + 2 || slot === shift + 4 ? "computed" : "binding", provenance }));
  return new ExecutableProgram(values, [
    { kind, inputs: [shift, shift + 1], output: shift + 2, provenance },
    { kind, inputs: [shift + 2, shift + 3], output: shift + 4, provenance },
  ], shift + 4);
}

for (const kind of ["add-f32", "mul-f32"]) {
  test(`${kind} preparation rejects the actual broadcast requester before starting compilation`, async () => {
    const acquired = executionDevice(); acquired.limits.maxStorageBuffersPerShaderStage = 3;
    const backend = new WebGpuBackend(acquired);
    try {
      assert.throws(() => backend.prepare(mixedProgram(kind)), error => error.code === "BACKEND_CAPABILITY_MISMATCH"
        && error.details.phase === "preparation" && error.details.programValueSlot === 4);
      assert.equal(acquired.shaderSources.length, 0);
    } finally { await backend.close(); }
  });
  test(`${kind} failed broadcast compilation and its cached rejection retain the current requester slot`, async () => {
    const acquired = executionDevice(), injected = new Error("broadcast compilation failed");
    let compilations = 0;
    acquired.createComputePipelineAsync = async () => {
      if (++compilations === 2) throw injected;
      return { getBindGroupLayout() { return {}; } };
    };
    const backend = new WebGpuBackend(acquired);
    try {
      for (const shift of [0, 2]) await assert.rejects(async () => await backend.prepare(mixedProgram(kind, shift)), error =>
        error.code === "BACKEND_STATUS_ERROR" && error.details.phase === "preparation"
        && error.details.programValueSlot === shift + 4 && error.cause === injected);
      assert.equal(compilations, 2);
    } finally { await backend.close(); }
  });
}

test("GPU broadcast forward uses a fixed-kind aligned-four pipeline and immutable parameters", async () => {
  const acquired = executionDevice(), session = createConnectedRuntimeSession(new WebGpuBackend(acquired));
  try {
    const left = session.tensor([2, 3], { shape: [2, 1], device: "webgpu" });
    const right = session.tensor(new Float32Array(128).fill(2), { shape: [1, 128], device: "webgpu" });
    const result = left.mul(right);
    await result.toArray();
    assert.deepEqual(acquired.dispatches, [1]);
    assert.equal(acquired.bindingGroups[0].length, 4);
    const words = new Uint32Array(acquired.bindingGroups[0][3].resource.buffer.data);
    assert.deepEqual([...words].slice(0, 3), [2, 256, 4]);
    assert.equal(session.diagnostics().webgpu.uploadBytes, (2 + 128) * 4);
    left.close(); right.close(); result.close();
  } finally { await session.close(); }
  assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
  assert.ok(acquired.buffers.every(buffer => buffer.destroyed));
});

test("GPU shape and rank variations do not create new pipeline identities", async () => {
  const acquired = executionDevice(), session = createConnectedRuntimeSession(new WebGpuBackend(acquired));
  try {
    for (const [leftShape, rightShape] of [[[2, 1], [3]], [[4, 1], [7]], [[2, 1, 3, 1], [1, 4, 1, 5]]]) {
      const size = shape => shape.reduce((count, dimension) => count * dimension, 1);
      const left = session.tensor(new Float32Array(size(leftShape)), { shape: leftShape, device: "webgpu" });
      const right = session.tensor(new Float32Array(size(rightShape)), { shape: rightShape, device: "webgpu" });
      const output = left.mul(right);
      await output.toArray();
      for (const value of [left, right, output]) value.close();
    }
    assert.equal(acquired.shaderSources.length, 1);
  } finally { await session.close(); }
  assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
});

test("GPU parameters and receiving partial products have independent checked limits", () => {
  const limits = { maxBufferSize: 8192, maxStorageBufferBindingSize: 8192, maxComputeWorkgroupsPerDimension: 3 };
  const geometry = pointwiseGeometry([[257, 5], [5]]), receiver = receivingGeometry(geometry, 1);
  assert.ok(receivingStages(receiver, limits).some(stage => stage.workgroups > limits.maxComputeWorkgroupsPerDimension), "supported work is windowed, not rejected by one dispatch axis");
  assert.throws(() => receivingStages(receiver, { ...limits, maxStorageBufferBindingSize: 64 }), { code: "RESOURCE_EXHAUSTED" });
  assert.throws(() => receivingStages({ ...receiver, groups: 0xffff_ffff, terms: 2 }, limits), { code: "RESOURCE_EXHAUSTED" });
  assert.throws(() => pointwiseParameters(geometry, { ...limits, maxStorageBufferBindingSize: 16 }), { code: "RESOURCE_EXHAUSTED" });
});

test("GPU receiving windows cover groups beyond one dispatch axis without expanded payloads", async () => {
  const acquired = executionDevice(), session = createConnectedRuntimeSession(new WebGpuBackend(acquired));
  try {
    const left = session.tensor(new Float32Array(2 * 65536), { shape: [2, 65536], device: "webgpu" });
    const bias = session.tensor(new Float32Array(65536), { device: "webgpu", requiresGrad: true });
    const result = left.add(bias), loss = result.sum(), [gradient] = session.grad(loss, [bias]);
    await gradient.toArray();
    const windows = acquired.bindingGroups.filter(entries => entries.length === 4 && entries[3].resource.buffer.data.byteLength === 32);
    assert.equal(windows.length, 2);
    assert.deepEqual(windows.map(entries => new Uint32Array(entries[3].resource.buffer.data)[6]), [0, 65535]);
    assert.ok(acquired.dispatches.every(count => count <= 65535));
    for (const value of [left, bias, result, loss, gradient]) value.close();
  } finally { await session.close(); }
  assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
});

for (const receiving of [false, true]) for (const phase of ["allocation", "parameter-write", "submit", "readback", "completion"]) {
  test(`GPU ${receiving ? "receiving partials" : "broadcast parameters"} retire after ${phase} failure`, async () => {
    const injected = new Error(`controlled ${phase} failure`);
    const acquired = executionDevice({ mapError: phase === "readback" ? injected : undefined,
      completion: phase === "completion" ? () => Promise.reject(injected) : undefined });
    if (phase === "allocation") {
      const original = acquired.createBuffer; let calls = 0;
      acquired.createBuffer = function (descriptor) {
        if (++calls === 4) throw injected;
        return original.call(this, descriptor);
      };
    }
    if (phase === "parameter-write") {
      const original = acquired.queue.writeBuffer; let calls = 0;
      acquired.queue.writeBuffer = function (...args) {
        if (++calls === (receiving ? 2 : 3)) throw injected;
        return original.apply(this, args);
      };
    }
    if (phase === "submit") acquired.queue.submit = () => { throw injected; };
    const session = createConnectedRuntimeSession(new WebGpuBackend(acquired)), owned = [];
    try {
      const left = session.tensor(new Float32Array(257 * 5), { shape: [257, 5], device: "webgpu" }); owned.push(left);
      const right = session.tensor(new Float32Array(5), { device: "webgpu", requiresGrad: receiving }); owned.push(right);
      const output = left.add(right); owned.push(output);
      let demanded = output;
      if (receiving) {
        const seed = session.tensor(new Float32Array(257 * 5), { shape: output.shape, device: "webgpu" }); owned.push(seed);
        [demanded] = session.grad(output, [right], seed); owned.push(demanded);
      }
      await assert.rejects(demanded.toArray(), error => error.code === "BACKEND_STATUS_ERROR");
      for (const value of owned) value.close();
    } finally { await session.close(); }
    assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
    assert.ok(acquired.buffers.every(buffer => buffer.destroyed));
    if (phase === "completion") assert.ok(session.diagnostics().webgpu.unknownCompletionBytes > 0);
    else assert.equal(session.diagnostics().webgpu.unknownCompletionBytes, 0);
  });
}
