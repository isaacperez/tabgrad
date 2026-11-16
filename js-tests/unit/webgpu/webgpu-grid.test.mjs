import assert from "node:assert/strict";
import { test } from "node:test";
import { WebGpuBackend } from "../../../dist/backends/webgpu/webgpu-backend.js";
import { createConnectedRuntimeSession } from "../../../dist/runtime/runtime.js";
import { executionDevice } from "./helpers/webgpu-device.mjs";

function controlledSession(axis = 7) {
  const device = executionDevice();
  device.limits.maxComputeWorkgroupsPerDimension = axis;
  return { device, session: createConnectedRuntimeSession(new WebGpuBackend(device)) };
}

for (const order of [[1, 449, 65, 1025, 1], [1025, 1, 449, 65, 1025]]) {
  test(`GPU storage admission and bounded pipeline identity survive size order ${order.join("/")}`, async () => {
    const { device, session } = controlledSession();
    try {
      for (const count of order) {
        const input = session.tensor(new Float32Array(count), { device: "webgpu" });
        const result = input.add(input);
        await result.toArray();
        input.close(); result.close();
      }
      assert.equal(device.shaderSources.length, 2, "one original and one grid pipeline, independent of shape");
      assert.ok(device.dispatchGrids.some(([, y]) => y > 1));
      assert.ok(device.dispatchGrids.every(([x, y, z]) => x <= 7 && y <= 7 && z === 1));
      for (let index = 0; index < order.length; index++) {
        assert.equal(device.dispatchedSources[index].includes("@builtin(num_workgroups)"), order[index] > 448);
      }
    } finally { await session.close(); }
    assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
    assert.ok(device.buffers.every(buffer => buffer.destroyed));
  });
}

test("GPU cooperative sum prepares both layouts and uniformly guards padded workgroups", async () => {
  const { device, session } = controlledSession();
  try {
    const input = session.tensor(new Float32Array(2053), { device: "webgpu" }), total = input.sum();
    await total.toArray();
    assert.deepEqual(device.dispatchGrids, [[6, 3, 1], [1, 1, 1]]);
    assert.equal(device.shaderSources.length, 2);
    const grid = device.dispatchedSources[0];
    const entry = grid.slice(grid.lastIndexOf("fn main("));
    assert.ok(entry.indexOf("return;") >= 0 && entry.indexOf("return;") < entry.indexOf("workgroupBarrier();"));
    assert.ok(grid.includes("@builtin(num_workgroups)"));
    assert.ok(!device.dispatchedSources[1].includes("@builtin(num_workgroups)"));
    input.close(); total.close();
  } finally { await session.close(); }
});

test("impossible dispatch is rejected before shader preparation or queued input writes", async () => {
  const { device, session } = controlledSession(1);
  try {
    const input = session.tensor(new Float32Array(65), { device: "webgpu" }), output = input.add(input);
    await assert.rejects(output.toArray(), { code: "RESOURCE_EXHAUSTED" });
    assert.equal(device.buffers.length, 0);
    assert.equal(device.shaderSources.length, 0);
    assert.equal(session.diagnostics().webgpu.uploadBytes, 0);
    input.close(); output.close();
  } finally { await session.close(); }
});

function familyProgram(kind, count, flags = 0) {
  const provenance = { operation: kind, source: "test" };
  const inputShapes = kind === "expand-f32" ? [[]]
    : kind === "matmul-f32" ? [[...(flags & 1 ? [1, count] : [count, 1])], [1, 1]]
    : [[count], [count]];
  const outputShape = kind === "matmul-f32" ? [count, 1] : [count];
  const values = [...inputShapes, outputShape].map((shape, slot) => ({ slot, storageSlot: slot, shape,
    device: "webgpu", dtype: "float32", layout: "contiguous", source: slot === inputShapes.length ? "computed" : "binding", provenance }));
  return { values, computation: { kind, inputs: inputShapes.map((_, slot) => slot), output: inputShapes.length,
    ...(kind === "add-alpha-f32" ? { alphaBits: 0xbe800000 } : {}),
    ...(kind === "matmul-f32" ? { matrixFlags: flags } : {}), provenance } };
}

for (const kind of ["add-f32", "mul-f32", "add-alpha-f32", "expand-f32", "matmul-f32"]) {
  test(`GPU ${kind} uses the shared invocation grid and retains default source for small work`, async () => {
    const { ExecutableProgram } = await import("../../../dist/execution/executable-program.js");
    const device = executionDevice(); device.limits.maxComputeWorkgroupsPerDimension = 7;
    const backend = new WebGpuBackend(device);
    try {
      for (const count of [449, 1, 1025, 65]) for (const flags of kind === "matmul-f32" ? [0, 1, 2, 3] : [0]) {
        const { values, computation } = familyProgram(kind, count, flags);
        const program = new ExecutableProgram(values, [computation], computation.output);
        await backend.prepare(program);
        const bindings = new Map(values.filter(value => value.source === "binding").map(value => [value.slot,
          { hostData: new Float32Array(value.shape.reduce((a, b) => a * b, 1)) }]));
        const ticket = backend.execute(program, bindings, values.map(value => value.slot === computation.output));
        const outputs = await ticket.result; await ticket.drained;
        backend.release(outputs.get(computation.output));
        const [x, y, z] = device.dispatchGrids.at(-1);
        assert.ok(x <= 7 && y <= 7 && z === 1);
        assert.equal(device.dispatchedSources.at(-1).includes("@builtin(num_workgroups)"), count > 448);
      }
      assert.equal(device.shaderSources.length, 2);
    } finally { await backend.close(); }
    assert.equal(backend.diagnostics().ownedBufferBytes, 0);
  });
}

for (const columns of [4, 5]) {
  test(`GPU broadcast width ${columns === 4 ? 4 : 1} has independent checked grid coverage`, async () => {
    const { device, session } = controlledSession();
    try {
      const left = session.tensor(new Float32Array(513), { shape: [513, 1], device: "webgpu" });
      const right = session.tensor(new Float32Array(columns), { shape: [1, columns], device: "webgpu" });
      const result = left.mul(right); await result.toArray();
      assert.ok(device.dispatchGrids[0][1] > 1);
      assert.ok(device.dispatchedSources[0].includes("@builtin(num_workgroups)"));
      for (const value of [left, right, result]) value.close();
    } finally { await session.close(); }
    assert.equal(session.diagnostics().webgpu.ownedBufferBytes, 0);
  });
}

test("GPU inferred output admission uses the signed completion ceiling independently of dispatch", async () => {
  const device = executionDevice();
  device.limits.maxBufferSize = 2 ** 34;
  device.limits.maxStorageBufferBindingSize = 2 ** 34;
  const backend = new WebGpuBackend(device), session = createConnectedRuntimeSession(backend);
  try {
    assert.equal(backend.capabilities.maximumTensorBytes, 2147483644);
    const left = session.tensor([], { shape: [32768, 0], device: "webgpu" });
    const right = session.tensor([], { shape: [0, 16384], device: "webgpu" });
    const before = session.diagnostics();
    assert.throws(() => left.matmul(right), error => error.code === "RESOURCE_EXHAUSTED"
      && error.details.byteLength === 2147483648 && error.details.maximumTensorBytes === 2147483644);
    assert.deepEqual(session.diagnostics(), before);
    assert.equal(device.buffers.length, 0, "boundary evidence allocates no large buffer");
    left.close(); right.close();
  } finally { await session.close(); }
});

test("failed grid preparation retains the current requester without poisoning the linear layout", async () => {
  const { ExecutableProgram } = await import("../../../dist/execution/executable-program.js");
  const device = executionDevice(); device.limits.maxComputeWorkgroupsPerDimension = 7;
  const nativeCompile = device.createComputePipelineAsync;
  const injected = new Error("controlled grid compilation failure");
  device.createComputePipelineAsync = options => options.compute.module.code.includes("@builtin(num_workgroups)")
    ? Promise.reject(injected) : nativeCompile(options);
  const backend = new WebGpuBackend(device);
  const make = (count, shift) => {
    const { values, computation } = familyProgram("add-f32", count);
    const extra = Array.from({ length: shift }, (_, slot) => ({ ...values[0], slot, storageSlot: slot, shape: [] }));
    return new ExecutableProgram([...extra, ...values.map(value => ({ ...value, slot: value.slot + shift, storageSlot: value.slot + shift }))],
      [{ ...computation, inputs: computation.inputs.map(slot => slot + shift), output: computation.output + shift }], computation.output + shift);
  };
  try {
    await backend.prepare(make(1, 0));
    for (const shift of [0, 3]) await assert.rejects(backend.prepare(make(449, shift)), error =>
      error.code === "BACKEND_STATUS_ERROR" && error.details.phase === "preparation"
      && error.details.programValueSlot === shift + 2 && error.cause === injected);
    await backend.prepare(make(1, 0));
    assert.equal(device.shaderSources.length, 2, "failed grid preparation is cached separately from usable linear preparation");
    assert.equal(device.buffers.length, 0);
  } finally { await backend.close(); }
});
