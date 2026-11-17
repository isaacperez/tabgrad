import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { decodeTensorPayload, float32TensorPayload } from "../../../dist/execution/tensor-payload.js";
import { WebAssemblyCpuBackend } from "../../../dist/backends/cpu/cpu-backend.js";
import { CpuArtifactLoader } from "../../../dist/backends/cpu/artifact-loader.js";
import { CpuAllocation } from "../../../dist/backends/cpu/linear-memory.js";
import { ExecutableProgram } from "../../../dist/execution/executable-program.js";
import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";

const fixtures = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist/", import.meta.url)));
let manifestUrl;

before(async () => { manifestUrl = new URL("manifest.json", await fixtures.start()); });
after(async () => { await fixtures.close(); });

function bindingProgram(length = 1) {
  return new ExecutableProgram([{
    slot: 0, storageSlot: 0, shape: [length], dtype: "float32", device: "cpu",
    layout: "contiguous", source: "binding",
    provenance: { operation: "tensor", source: "RuntimeSession.tensor" },
  }], [], 0);
}

for (const variant of ["scalar", "simd128"]) {
  test(`CPU raw I/O copies bounded spans once and survives later memory growth (${variant})`, async () => {
    const backend = new WebAssemblyCpuBackend(manifestUrl, variant);
    try {
      await backend.prepare();
      const source = new Float32Array([99, -0, 1.25, Infinity, 99]);
      const bounded = float32TensorPayload(source.subarray(1, 4));
      const allocation = backend.execute(bindingProgram(3), new Map([[0, { hostData: bounded }]]), [true]).get(0);
      const initial = backend.diagnostics();
      assert.equal(initial.hostToWasmCopies, 1);
      assert.equal(initial.hostToWasmBytes, 12);
      const first = backend.read(allocation, 3, "float32");
      assert.equal(first.bytes.buffer.byteLength, 12);
      assert.notEqual(first.bytes.buffer, source.buffer);
      const numeric = decodeTensorPayload(first, "float32", 3);
      assert.equal(numeric.buffer, first.bytes.buffer);
      assert.deepEqual([...numeric], [-0, 1.25, Infinity]);
      numeric[1] = 77;
      const largeData = float32TensorPayload(new Float32Array(524289));
      const large = backend.execute(bindingProgram(largeData.elements), new Map([[0, { hostData: largeData }]]), [true]).get(0);
      assert(backend.diagnostics().wasmMemoryBytes > initial.wasmMemoryBytes);
      assert.deepEqual([...decodeTensorPayload(backend.read(allocation, 3, "float32"), "float32", 3)], [-0, 1.25, Infinity]);
      assert.equal(backend.diagnostics().wasmToHostCopies, 2);
      assert.equal(backend.diagnostics().wasmToHostBytes, 24);
      const empty = backend.execute(bindingProgram(0), new Map([[0, { hostData: float32TensorPayload(new Float32Array()) }]]), [true]).get(0);
      assert.equal(backend.read(empty, 0, "float32").bytes.byteLength, 0);
      for (const value of [allocation, large, empty]) backend.release(value);
      assert.equal(backend.diagnostics().liveAllocationBytes, 0);
    } finally { await backend.close(); }
  });
}

for (const variant of ["scalar", "simd128"]) {
  test(`CPU physical identity validation preserves malformed-reference errors (${variant})`, async () => {
    const backend = new WebAssemblyCpuBackend(manifestUrl, variant);
    try {
      await backend.prepare();
      const before = backend.diagnostics();
      for (const invalid of [null, undefined, 42, "foreign", {}, Object.create(CpuAllocation.prototype)]) {
        assert.throws(() => backend.read(invalid, 1, "float32"), { code: "BACKEND_STATUS_ERROR" });
        assert.throws(() => backend.release(invalid), { code: "BACKEND_STATUS_ERROR" });
      }
      assert.deepEqual(backend.diagnostics(), before);
    } finally { await backend.close(); }
  });
}

for (const variant of ["scalar", "simd128"]) for (const operation of ["read", "execute", "release"]) {
  test(`CPU ${operation} rejects a live allocation from an equal-generation context (${variant})`, async () => {
    const backend = new WebAssemblyCpuBackend(manifestUrl, variant);
    const other = new WebAssemblyCpuBackend(manifestUrl, variant);
    const program = bindingProgram();
    try {
      await backend.prepare();
      await other.prepare();
      const own = backend.execute(program, new Map([[0, { hostData: float32TensorPayload(new Float32Array([3])) }]]), [true]).get(0);
      const foreign = other.execute(program, new Map([[0, { hostData: float32TensorPayload(new Float32Array([9])) }]]), [true]).get(0);
      assert.equal(own.generation, foreign.generation);
      const before = backend.diagnostics(), otherBefore = other.diagnostics();
      const invoke = operation === "read" ? () => backend.read(foreign, 1, "float32")
        : operation === "release" ? () => backend.release(foreign)
          : () => backend.execute(program, new Map([[0, { resident: foreign }]]), [true]);
      assert.throws(invoke, { code: "BACKEND_STATUS_ERROR" });
      assert.equal(foreign.released, false);
      assert.deepEqual(backend.diagnostics(), before);
      assert.deepEqual(other.diagnostics(), otherBefore);
      assert.deepEqual([...decodeTensorPayload(backend.read(own, 1, "float32"), "float32", 1)], [3]);
      assert.deepEqual([...decodeTensorPayload(other.read(foreign, 1, "float32"), "float32", 1)], [9]);
      const borrowed = backend.execute(program, new Map([[0, { resident: own }]]), [true]);
      assert.equal(borrowed.get(0), own);
      backend.release(own);
      backend.release(own);
      other.release(foreign);
      backend.release(foreign);
      assert.equal(backend.diagnostics().liveAllocationBytes, 0);
      assert.equal(other.diagnostics().liveAllocationBytes, 0);
    } finally {
      await backend.close();
      await other.close();
    }
  });
}

for (const variant of ["scalar", "simd128"]) {
  test(`CPU loader applies the session maximum to the imported memory itself (${variant})`, async () => {
    const timings = { manifestFetchMilliseconds: 0, moduleFetchMilliseconds: 0,
      integrityCheckMilliseconds: 0, compilationMilliseconds: 0, instantiationMilliseconds: 0 };
    const artifact = await new CpuArtifactLoader(manifestUrl, variant, timings, 2 * 1024 * 1024).load();
    assert.equal(artifact.memory.buffer.byteLength, 2 * 1024 * 1024);
    assert.throws(() => artifact.memory.grow(1), RangeError);
    assert.equal(artifact.memory.buffer.byteLength, 2 * 1024 * 1024);
    assert.equal(artifact.capacity.artifactMaximumBytes, 256 * 1024 * 1024);
    assert.equal(artifact.capacity.linearMemoryLimitBytes, 2 * 1024 * 1024);
  });
}
