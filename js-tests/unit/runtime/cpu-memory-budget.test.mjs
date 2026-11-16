import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";
import { createTestRuntimeSession, getTestRuntimeOwnership } from "../../../dist/testing.js";
import { prepareRuntimeSession } from "../../../dist/runtime/runtime.js";

const MiB = 1024 * 1024;
const fixtures = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist/", import.meta.url)));
let manifestUrl;
before(async () => { manifestUrl = new URL("manifest.json", await fixtures.start()); });
after(async () => { await fixtures.close(); });

for (const forceVariant of ["scalar", "simd128"]) {
  test(`CPU prepared capacity separates artifact, session and arena (${forceVariant})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl, forceVariant,
      memoryLimits: { cpuLinearMemoryBytes: 128 * MiB } });
    let retained;
    try {
      await prepareRuntimeSession(session);
      const ready = session.diagnostics();
      retained = ready.cpuMemoryCapacity;
      assert.ok(retained);
      assert.ok(Object.isFrozen(retained));
      assert.equal(retained.artifactMaximumBytes, 256 * MiB);
      assert.equal(retained.linearMemoryLimitBytes, 128 * MiB);
      assert.equal(retained.arenaBaseBytes, MiB);
      assert.equal(retained.arenaCapacityBytes, 127 * MiB);
      assert.equal(ready.wasmMemoryBytes, 2 * MiB, "a maximum does not preallocate the arena");
      assert.equal(ready.liveAllocationBytes, 0);
      assert.equal(ready.kernelCalls, 0);
    } finally { await session.close(); }
    assert.equal(session.diagnostics().cpuMemoryCapacity, null);
    assert.equal(retained.linearMemoryLimitBytes, 128 * MiB);
  });

  test(`CPU session ceiling rejects output without corrupting borrowed input (${forceVariant})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl, forceVariant,
      memoryLimits: { cpuLinearMemoryBytes: 2 * MiB } });
    try {
      const input = session.tensor(new Float32Array(262136).fill(1));
      assert.ok((await input.toArray()).every(value => value === 1));
      const before = session.diagnostics(), owners = getTestRuntimeOwnership(session);
      const tooLarge = input.add(input);
      await assert.rejects(tooLarge.toArray(), error => {
        assert.equal(error.code, "RESOURCE_EXHAUSTED");
        assert.equal(error.details.capacityDomain, "cpu-linear-memory");
        assert.equal(error.details.maximumBytes, 2 * MiB);
        assert.ok(error.details.requiredBytes > 2 * MiB);
        return true;
      });
      assert.equal(session.diagnostics().liveAllocationBytes, before.liveAllocationBytes);
      assert.equal(session.diagnostics().reservedAllocationBytes, before.reservedAllocationBytes);
      assert.ok((await input.toArray()).every(value => value === 1));
      tooLarge.close();
      assert.deepEqual(getTestRuntimeOwnership(session), owners);
      const small = session.tensor([2]), result = small.add(small);
      assert.deepEqual(Array.from(await result.toArray()), [4]);
      result.close(); small.close(); input.close();
    } finally { await session.close(); }
    assert.ok(Object.values(getTestRuntimeOwnership(session)).every(value => value === 0));
  });
}

test("CPU larger arena admits the studied 4M forward working set only by explicit request", async () => {
  const a = new Float32Array(4194304).fill(1), b = new Float32Array(4194304).fill(2);
  for (const cpuLinearMemoryBytes of [64 * MiB, 128 * MiB]) {
    const session = createTestRuntimeSession({ manifestUrl, forceVariant: "simd128",
      memoryLimits: { cpuLinearMemoryBytes } });
    try {
      const x = session.tensor(a), y = session.tensor(b), added = x.add(y), product = added.mul(x);
      if (cpuLinearMemoryBytes === 64 * MiB) {
        await assert.rejects(product.toArray(), { code: "RESOURCE_EXHAUSTED" });
      } else {
        const values = await product.toArray();
        assert.equal(values.length, a.length);
        assert.ok(values.every(value => value === 3));
        assert.ok(session.diagnostics().wasmMemoryBytes > 64 * MiB);
        assert.ok(session.diagnostics().wasmMemoryBytes <= cpuLinearMemoryBytes);
      }
    } finally { await session.close(); }
    assert.ok(Object.values(getTestRuntimeOwnership(session)).every(value => value === 0));
  }
});

test("a larger CPU arena does not enlarge logical update admission or consume rejected history", async () => {
  const session = createTestRuntimeSession({ manifestUrl, forceVariant: "scalar",
    memoryLimits: { cpuLinearMemoryBytes: 128 * MiB, updateBackingBytes: 0 } });
  try {
    const x = session.tensor([2], { requiresGrad: true }), output = x.mul(x).sum();
    const before = session.diagnostics(), ownership = getTestRuntimeOwnership(session);
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.throws(() => output.backward(), error => {
        assert.equal(error.code, "RESOURCE_EXHAUSTED");
        assert.equal(error.details.capacityDomain, "update-backing");
        assert.equal(error.details.maximumBackingBytes, 0);
        return true;
      });
      assert.equal(x.grad, null);
      assert.equal(session.diagnostics().liveDerivativeNodes, before.liveDerivativeNodes);
      assert.deepEqual(getTestRuntimeOwnership(session), ownership);
    }
    const [gradient] = session.grad(output, [x]);
    assert.deepEqual(Array.from(await gradient.toArray()), [4], "pure functional reservation omission remains valid");
    gradient.close();
  } finally { await session.close(); }
});

test("CPU numerical and update caps do not reinterpret host-only copies as arena allocations", async () => {
  const session = createTestRuntimeSession({ manifestUrl, forceVariant: "scalar",
    memoryLimits: { cpuLinearMemoryBytes: 2 * MiB, updateBackingBytes: 0 } });
  try {
    const source = new Float32Array(524288).fill(7), tensor = session.tensor(source);
    source[0] = 99;
    const copy = await tensor.toArray();
    assert.equal(copy[0], 7);
    assert.equal(copy.length, 524288);
    assert.equal(session.diagnostics().backendLoads, 0);
    assert.equal(session.diagnostics().wasmMemoryBytes, 0);
    copy[1] = 42;
    assert.equal((await tensor.toArray())[1], 7);
    tensor.close();
  } finally { await session.close(); }
});
