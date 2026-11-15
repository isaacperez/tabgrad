import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebAssemblyCpuBackend } from "../../../dist/backends/cpu/cpu-backend.js";
import { CpuAllocation } from "../../../dist/backends/cpu/linear-memory.js";
import { ExecutableProgram } from "../../../dist/execution/executable-program.js";
import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";

const fixtures = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist/", import.meta.url)));
let manifestUrl;

before(async () => { manifestUrl = new URL("manifest.json", await fixtures.start()); });
after(async () => { await fixtures.close(); });

function bindingProgram() {
  return new ExecutableProgram([{
    slot: 0, storageSlot: 0, shape: [1], dtype: "float32", device: "cpu",
    layout: "contiguous", source: "binding",
    provenance: { operation: "tensor", source: "RuntimeSession.tensor" },
  }], [], 0);
}

for (const variant of ["scalar", "simd128"]) {
  test(`CPU physical identity validation preserves malformed-reference errors (${variant})`, async () => {
    const backend = new WebAssemblyCpuBackend(manifestUrl, variant);
    try {
      await backend.prepare();
      const before = backend.diagnostics();
      for (const invalid of [null, undefined, 42, "foreign", {}, Object.create(CpuAllocation.prototype)]) {
        assert.throws(() => backend.read(invalid, 1), { code: "BACKEND_STATUS_ERROR" });
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
      const own = backend.execute(program, new Map([[0, { hostData: new Float32Array([3]) }]]), [true]).get(0);
      const foreign = other.execute(program, new Map([[0, { hostData: new Float32Array([9]) }]]), [true]).get(0);
      assert.equal(own.generation, foreign.generation);
      const before = backend.diagnostics(), otherBefore = other.diagnostics();
      const invoke = operation === "read" ? () => backend.read(foreign, 1)
        : operation === "release" ? () => backend.release(foreign)
          : () => backend.execute(program, new Map([[0, { resident: foreign }]]), [true]);
      assert.throws(invoke, { code: "BACKEND_STATUS_ERROR" });
      assert.equal(foreign.released, false);
      assert.deepEqual(backend.diagnostics(), before);
      assert.deepEqual(other.diagnostics(), otherBefore);
      assert.deepEqual([...backend.read(own, 1)], [3]);
      assert.deepEqual([...other.read(foreign, 1)], [9]);
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
