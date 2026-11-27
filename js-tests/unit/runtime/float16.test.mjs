import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntimeSession } from "../../../dist/index.js";
import { hostTensorPayload, decodeTensorPayload, assertTensorPayload } from "../../../dist/execution/tensor-payload.js";
import { tensorByteLength } from "../../../dist/shared/tensor-dtype.js";
import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { getTestRuntimeOwnership, getTestTensorVersion } from "../../../dist/testing.js";

const oracle = JSON.parse(await readFile(new URL("../../fixtures/float16-oracle.json", import.meta.url)));
function numeric(bits) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >>> 10) & 31;
  const fraction = bits & 1023;
  return exponent === 31 ? (fraction ? NaN : sign * Infinity) : exponent === 0 ? sign * fraction * 2 ** -24
    : sign * (1024 + fraction) * 2 ** (exponent - 25);
}

const creation = [0, -0, 2 ** -25, 2 ** -24, 3 * 2 ** -25,
  2 ** -14 - 2 ** -24, 2 ** -14, 1 + 2 ** -11,
  1 + 2 ** -11 + 2 ** -30, 1 + 3 * 2 ** -11,
  65520 - 2 ** -10, 65520, Infinity, -Infinity, NaN];
const observed = [0, -0, 0, 2 ** -24, 2 ** -23,
  2 ** -14 - 2 ** -24, 2 ** -14, 1, 1 + 2 ** -10,
  1 + 2 ** -9, 65504, Infinity, Infinity, -Infinity, NaN];

test("float16 creation preserves original precision, IEEE classes and the float32 default", async () => {
  const session = createRuntimeSession();
  try {
    const half = session.tensor(creation, { dtype: "float16" });
    assert.equal(half.dtype, "float16");
    assert.deepEqual(half.shape, [creation.length]);
    assert.equal(half.requiresGrad, false);
    const values = await half.toArray();
    assert(values instanceof Float32Array);
    assert.deepEqual([...values], observed);
    assert.equal(tensorByteLength("float16", creation.length), 2 * creation.length);
    const normal = session.tensor([1 + 2 ** -11 + 2 ** -30]);
    assert.equal(normal.dtype, "float32");
    assert.deepEqual([...(await normal.toArray())], [Math.fround(creation[8])]);
    normal.close(); half.close();
  } finally { await session.close(); }
});

test("float16 payload observation covers every encoded value and excludes surrounding bytes", () => {
  const backing = new Uint16Array(65538);
  for (let bits = 0; bits < 65536; bits++) backing[bits + 1] = bits;
  const bytes = new Uint8Array(backing.buffer, 2, 65536 * 2);
  const payload = hostTensorPayload("float16", 65536, bytes);
  const values = decodeTensorPayload(payload, "float16", 65536);
  assert.equal(values.length, 65536);
  assert.equal(values.byteLength, 65536 * 4);
  for (let bits = 0; bits < 65536; bits++) {
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = (bits >>> 10) & 31;
    const fraction = bits & 1023;
    const expected = exponent === 31 ? (fraction ? NaN : sign * Infinity)
      : exponent === 0 ? sign * fraction * 2 ** -24
        : sign * (1024 + fraction) * 2 ** (exponent - 25);
    assert(Object.is(values[bits], expected), `binary16 ${bits.toString(16)}`);
  }
  assert.throws(() => assertTensorPayload({ ...payload, bytes: new Uint8Array(backing.buffer, 1, bytes.length) }, "float16", 65536), { code: "BACKEND_STATUS_ERROR" });
  assert.throws(() => decodeTensorPayload(payload, "float16", 65535), { code: "BACKEND_STATUS_ERROR" });
  assert.equal(decodeTensorPayload(hostTensorPayload("float16", 0, new Uint8Array()), "float16", 0).length, 0);
});

test("float16 views retain independent whole-storage lifetime and numeric imports are owned", async () => {
  const session = createRuntimeSession();
  try {
    const data = [1, -2, 3, 4, 5, -0];
    const source = session.tensor(data, { dtype: "float16", shape: [2, 3] });
    const view = source.view([3, 2]);
    data[0] = 99;
    source.close();
    assert.equal(view.dtype, "float16");
    assert.deepEqual([...(await view.toArray())], [1, -2, 3, 4, 5, -0]);
    view.close();
    assert.equal(session.diagnostics().liveTensorHandles, 0);
  } finally { await session.close(); }
});

test("float16 tracking eligibility rejects before reading data or creating state", async () => {
  const session = createRuntimeSession();
  let reads = 0;
  try {
    const data = { length: 1, get 0() { reads++; return 1; } };
    assert.throws(() => session.tensor(data, { dtype: "float16", requiresGrad: true }), { code: "UNSUPPORTED_GRADIENT" });
    assert.equal(reads, 0);
    const d = session.diagnostics();
    assert.equal(d.liveTensorHandles, 0);
    assert.equal(d.liveDerivativeNodes, 0);
    assert.equal(d.hostToWasmCopies, 0);
  } finally { await session.close(); }
});

test("float16 CPU channel scale and bias use stored half operations and common broadcasting", async () => {
  const server = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist/", import.meta.url)));
  const session = createRuntimeSession({ manifestUrl: new URL("manifest.json", await server.start()) });
  const handles = [];
  try {
    const input = session.tensor([1, -2, 3, 4, 5, -6], { dtype: "float16", shape: [2, 3] });
    const scale = session.tensor([0.5, 2, -1], { dtype: "float16" });
    const bias = session.tensor([1, 0.5, 2], { dtype: "float16" });
    handles.push(input, scale, bias);
    const product = input.mul(scale);
    const output = product.add(bias);
    handles.push(product, output);
    assert.equal(output.dtype, "float16");
    assert.deepEqual(output.shape, [2, 3]);
    assert.deepEqual([...(await output.toArray())], [1.5, -3.5, -1, 3, 10.5, 8]);
    assert.equal(session.diagnostics().hostToWasmBytes, 24);
    assert.equal(session.diagnostics().wasmToHostBytes, 12);
    const empty = session.tensor([], { dtype: "float16", shape: [0, 3] });
    const emptyOutput = empty.mul(scale);
    handles.push(empty, emptyOutput);
    assert.deepEqual([...(await emptyOutput.toArray())], []);
  } finally {
    for (const tensor of handles) tensor.close();
    await session.close(); await server.close();
  }
});

test("float16 construction and separate stored CPU operations match the pinned native corpus", async () => {
  assert.equal(oracle.reference.torch, "2.14.0");
  const server = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist/", import.meta.url)));
  const session = createRuntimeSession({ manifestUrl: new URL("manifest.json", await server.start()) });
  const handles = [];
  try {
    const source = session.tensor(oracle.construction.inputs.map(value => typeof value === "number" ? value
      : value === "nan" ? NaN : value === "inf" ? Infinity : value === "-inf" ? -Infinity : -0), { dtype: "float16" });
    handles.push(source);
    assert.deepEqual([...(await source.toArray())], oracle.construction.words.map(numeric));
    const { pointwise } = oracle;
    const left = session.tensor(pointwise.left.map(numeric), { dtype: "float16" });
    const right = session.tensor(pointwise.right.map(numeric), { dtype: "float16" });
    const product = left.mul(right), sum = left.add(right), composed = product.add(left);
    handles.push(left, right, product, sum, composed);
    for (const [tensor, expected] of [[product, pointwise.mul], [sum, pointwise.add], [composed, pointwise.mulThenAdd]]) {
      assert.deepEqual([...(await tensor.toArray())], expected.map(numeric));
    }
  } finally {
    for (const tensor of handles) tensor.close();
    await session.close(); await server.close();
  }
});

test("float16 CPU total sum keeps a distinct scalar resident across operations", async () => {
  const server = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist/", import.meta.url)));
  const session = createRuntimeSession({ manifestUrl: new URL("manifest.json", await server.start()) });
  try {
    const source = session.tensor([1, 2, 3], { dtype: "float16", shape: [1, 3] });
    const doubled = source.add(source);
    const sum = doubled.sum();
    assert.equal(sum.dtype, "float16");
    assert.deepEqual(sum.shape, []);
    assert.equal(sum.requiresGrad, false);
    const product = sum.mul(sum);
    source.close(); doubled.close(); sum.close();
    assert.deepEqual([...(await product.toArray())], [144]);
    const diagnostics = session.diagnostics();
    assert.equal(diagnostics.hostToWasmBytes, 6);
    assert.equal(diagnostics.wasmToHostBytes, 2);
    product.close();
    assert.equal(session.diagnostics().liveTensorHandles, 0);
  } finally { await session.close(); await server.close(); }
});

test("unsupported half gradients and mutation preserve owners, versions and existing float32 associations", async () => {
  const session = createRuntimeSession();
  const half = session.tensor([1], { dtype: "float16" });
  const normal = session.tensor([2], { requiresGrad: true });
  const gradient = session.tensor([3]);
  try {
    normal.grad = gradient;
    assert.equal(half.grad, null);
    half.grad = null;
    const owners = getTestRuntimeOwnership(session);
    const versions = [half, normal, gradient].map(getTestTensorVersion);
    for (const [operation, code] of [
      [() => { half.grad = normal; }, "UNSUPPORTED_GRADIENT"],
      [() => { normal.grad = half; }, "UNSUPPORTED_GRADIENT"],
      [() => half.backward(), "UNSUPPORTED_GRADIENT"],
      [() => session.grad(half, [half]), "UNSUPPORTED_GRADIENT"],
      [() => session.sgd([half], { lr: 0.1 }), "UNSUPPORTED_GRADIENT"],
      [() => half.copy_(half), "UNSUPPORTED_DTYPE"],
      [() => normal.copy_(half), "UNSUPPORTED_DTYPE"],
      [() => half.copy_(normal), "UNSUPPORTED_DTYPE"],
      [() => half.add(normal), "UNSUPPORTED_DTYPE"],
      [() => half.mul(normal), "UNSUPPORTED_DTYPE"],
      [() => half.matmul(half), "UNSUPPORTED_DTYPE"],
    ]) {
      assert.throws(operation, { code });
      assert.deepEqual(getTestRuntimeOwnership(session), owners);
      assert.deepEqual([half, normal, gradient].map(getTestTensorVersion), versions);
      assert.equal(normal.grad, gradient);
      assert.equal(half.grad, null);
      assert.equal(session.diagnostics().backendLoads, 0);
    }
    half.close();
    assert.throws(() => half.add({}), { code: "INVALID_TENSOR" });
    assert.throws(() => half.add(normal), { code: "CLOSED_TENSOR" });
  } finally {
    half.close(); normal.close(); gradient.close(); await session.close();
  }
});

test("whole-storage half views remain valid across CPU linear-memory growth", async () => {
  const server = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist/", import.meta.url)));
  const session = createRuntimeSession({ manifestUrl: new URL("manifest.json", await server.start()) });
  const handles = [];
  try {
    const small = session.tensor([1, 2, 3], { dtype: "float16" });
    const doubled = small.add(small), view = doubled.view([1, 3]);
    handles.push(small, doubled, view);
    assert.deepEqual([...(await view.toArray())], [2, 4, 6]);
    const before = session.diagnostics().wasmMemoryBytes;
    const data = Float32Array.from({ length: 1048577 }, (_, index) => 2 ** ((index % 4) - 1));
    const large = session.tensor(data, { dtype: "float16" }), squared = large.mul(large);
    handles.push(large, squared);
    const values = await squared.toArray();
    assert.equal(values.length, data.length);
    for (let index = 0; index < values.length; index++) assert.equal(values[index], data[index] ** 2);
    assert(session.diagnostics().wasmMemoryBytes > before);
    small.close(); doubled.close();
    assert.deepEqual([...(await view.toArray())], [2, 4, 6]);
  } finally {
    for (const value of handles) value.close();
    await session.close(); await server.close();
  }
});
