import assert from "node:assert/strict";
import { test } from "node:test";
import { TENSOR_DTYPES, alignedByteLength, checkedElementBytes, tensorByteLength, tensorDType } from "../../../dist/shared/tensor-dtype.js";
import { assertTensorPayload, copyTensorPayload, decodeTensorPayload, float32TensorPayload, hostTensorPayload } from "../../../dist/execution/tensor-payload.js";

test("dtype facts have one immutable identity and no inherited or unimplemented formats", () => {
  assert.equal(tensorDType("float32"), TENSOR_DTYPES.float32);
  assert(Object.isFrozen(TENSOR_DTYPES));
  assert(Object.isFrozen(tensorDType("float32")));
  assert.equal(tensorDType("float16"), TENSOR_DTYPES.float16);
  for (const dtype of ["bfloat16", "toString", "__proto__", undefined]) assert.throws(() => tensorDType(dtype), TypeError);
});

test("checked spans separate compact logical widths from physical alignment", () => {
  for (const [count, logical, physical] of [[0, 0, 0], [1, 2, 4], [3, 6, 8], [1048577, 2097154, 2097156]]) {
    assert.equal(checkedElementBytes(count, 2), logical);
    assert.equal(alignedByteLength(logical, 4), physical);
  }
  assert.equal(tensorByteLength("float32", 1048576), 4194304);
  assert.equal(alignedByteLength(Number.MAX_SAFE_INTEGER, 1), Number.MAX_SAFE_INTEGER);
  for (const [count, width] of [[-1, 4], [0.5, 4], [1, 0], [1, NaN], [Infinity, 4]]) {
    assert.throws(() => checkedElementBytes(count, width), TypeError);
  }
  assert.throws(() => checkedElementBytes(Number.MAX_SAFE_INTEGER, 2), RangeError);
  assert.throws(() => alignedByteLength(Number.MAX_SAFE_INTEGER, 4), RangeError);
  assert.throws(() => alignedByteLength(1, 0), TypeError);
});

test("wrapping and numeric decoding preserve the original bounded buffer without copying", () => {
  const buffer = new ArrayBuffer(32);
  const original = new Float32Array(buffer, 8, 3);
  original.set([-0, Infinity, 3.25]);
  const payload = float32TensorPayload(original);
  assert.equal(payload.bytes.buffer, buffer);
  assert.equal(payload.bytes.byteOffset, 8);
  assert.equal(payload.bytes.byteLength, 12);
  assert(Object.isFrozen(payload));
  const observed = decodeTensorPayload(payload, "float32", 3);
  assert.equal(observed.buffer, buffer);
  assert.equal(observed.byteOffset, 8);
  assert.deepEqual([...observed], [-0, Infinity, 3.25]);
});

test("an ownership copy excludes surrounding bytes and detaches subsequent mutations", () => {
  const backing = new Float32Array([99, 1, 2, 99]);
  const payload = float32TensorPayload(backing.subarray(1, 3));
  const copy = copyTensorPayload(payload);
  assert.notEqual(copy.bytes.buffer, backing.buffer);
  assert.equal(copy.bytes.buffer.byteLength, 8);
  const observed = decodeTensorPayload(copy, "float32", 2);
  assert.equal(observed.buffer, copy.bytes.buffer);
  observed[0] = 7;
  assert.deepEqual([...backing], [99, 1, 2, 99]);
  assert.deepEqual([...observed], [7, 2]);
  const independent = decodeTensorPayload(payload, "float32", 2, "copy");
  assert.notEqual(independent.buffer, backing.buffer);
  assert.equal(independent.buffer.byteLength, 8);
  independent[0] = 8;
  assert.deepEqual([...backing], [99, 1, 2, 99]);
});

test("structured-cloned payloads validate by format and extent rather than object identity", () => {
  const payload = float32TensorPayload(new Float32Array([1, 2]));
  const cloned = structuredClone(payload);
  assert(!Object.isFrozen(cloned));
  assertTensorPayload(cloned, "float32", 2);
  for (const bad of [
    { ...cloned, kind: "resident" }, { ...cloned, dtype: "float16" },
    { ...cloned, encoding: "unknown" }, { ...cloned, elements: 1 },
    { ...cloned, bytes: new Uint8Array(4) },
    { ...cloned, bytes: new Uint8Array(new ArrayBuffer(12), 1, 8) },
    { ...cloned, bytes: new Uint8Array(new SharedArrayBuffer(8)) },
  ]) assert.throws(() => assertTensorPayload(bad, "float32", 2), { code: "BACKEND_STATUS_ERROR" });
  assert.throws(() => decodeTensorPayload(cloned, "float32", 3), { code: "BACKEND_STATUS_ERROR" });
});

test("empty payloads decode without storage and detached empty buffers are rejected", () => {
  const bytes = new Uint8Array();
  const empty = hostTensorPayload("float32", 0, bytes);
  assert.equal(decodeTensorPayload(empty, "float32", 0).length, 0);
  structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
  assert.throws(() => assertTensorPayload(empty, "float32", 0), TypeError);
});
