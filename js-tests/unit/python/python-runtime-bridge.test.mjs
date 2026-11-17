import assert from "node:assert/strict";
import { test } from "node:test";
import { RuntimeSession } from "../../../dist/index.js";
import { PythonRuntimeBridge } from "../../../dist/frontends/python/python-runtime-bridge.js";

function bufferLoan(overrides = {}) {
  let releases = 0;
  const view = {
    data: new Float32Array([99, 1, 2, 88]), offset: 1, format: "f",
    itemsize: 4, ndim: 1, shape: [2], c_contiguous: true,
    release() { releases += 1; },
    ...overrides,
  };
  return {
    getBuffer(type) { assert.equal(type, "f32"); return view; },
    get releases() { return releases; },
  };
}

test("buffer import checks bounds without clamping or escaping the borrowed view", async () => {
  const session = new RuntimeSession();
  const bridge = new PythonRuntimeBridge(session);
  try {
    for (const overrides of [
      { offset: -1 }, { offset: 0.5 }, { offset: 5 }, { offset: NaN },
      { shape: [-1] }, { shape: [5] }, { shape: [0.5] }, { shape: [Infinity] },
      { shape: [] }, { shape: [1, 2] }, { ndim: 2 }, { itemsize: 8 },
      { format: "i" }, { c_contiguous: false }, { data: new Uint32Array(4) },
    ]) {
      const loan = bufferLoan(overrides);
      assert.throws(() => bridge.tensorFromBuffer(loan), { code: "INVALID_DATA" });
      assert.equal(loan.releases, 1);
    }
    const good = bufferLoan();
    const handle = bridge.tensorFromBuffer(good);
    try {
      assert.equal(good.releases, 1);
      assert.deepEqual(handle.shape, [2]);
    } finally {
      handle.close();
    }
    assert.equal(session.diagnostics().liveTensorHandles, 0);
    assert.equal(session.diagnostics().backendLoads, 0);
  } finally {
    await session.close();
  }
});

test("failure to acquire a view propagates unchanged and does not invent a release", async () => {
  const session = new RuntimeSession();
  const bridge = new PythonRuntimeBridge(session);
  const failure = new Error("cannot borrow");
  try {
    assert.throws(() => bridge.tensorFromBuffer({ getBuffer() { throw failure; } }),
      (error) => error === failure);
  } finally {
    await session.close();
  }
});

test("logical shape is independent of the borrowed flat buffer and rejection releases the loan", async () => {
  const session = new RuntimeSession();
  const bridge = new PythonRuntimeBridge(session);
  try {
    const good = bufferLoan();
    const shape = [1, 2];
    const handle = bridge.tensorFromBuffer(good, shape);
    shape[0] = 99;
    assert.deepEqual(handle.shape, [1, 2]);
    assert.equal(good.releases, 1);
    handle.close();
    for (const shape of [[], [2, 2], [0, -1]]) {
      const bad = bufferLoan();
      assert.throws(() => bridge.tensorFromBuffer(bad, shape), { code: "INVALID_SHAPE" });
      assert.equal(bad.releases, 1);
      assert.equal(session.diagnostics().liveTensorHandles, 0);
      assert.equal(session.diagnostics().liveTensorValues, 0);
    }
  } finally {
    await session.close();
  }
});

test("half imports borrow original binary64 precision and release on success and rejection", async () => {
  const session = new RuntimeSession();
  const bridge = new PythonRuntimeBridge(session);
  let releases = 0;
  const values = new Float64Array([99, 1 + 2 ** -11 + 2 ** -30, 65520 - 2 ** -10, 88]);
  const loan = { getBuffer(type) {
    assert.equal(type, "f64");
    return { data: values, offset: 1, format: "d", itemsize: 8, ndim: 1, shape: [2], c_contiguous: true,
      release() { releases++; } };
  } };
  try {
    const tensor = bridge.tensorFromBuffer(loan, [2], false, "cpu", "float16");
    assert.equal(releases, 1);
    values.fill(0);
    assert.equal(tensor.dtype, "float16");
    assert.deepEqual([...(await tensor.toArray())], [1 + 2 ** -10, 65504]);
    tensor.close();
    assert.throws(() => bridge.tensorFromBuffer(loan, [2], true, "cpu", "float16"), { code: "UNSUPPORTED_GRADIENT" });
    assert.equal(releases, 2);
    assert.equal(session.diagnostics().liveTensorHandles, 0);
  } finally { await session.close(); }
});
