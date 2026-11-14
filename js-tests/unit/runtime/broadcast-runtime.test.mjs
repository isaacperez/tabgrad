import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { checkBroadcastCases } from "../../browser/helpers/broadcast-cases.mjs";
import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";
import { createTestRuntimeSession } from "../../../dist/testing.js";
import { prepareRuntimeSession } from "../../../dist/runtime/runtime.js";
import { LinearMemoryAllocator } from "../../../dist/backends/cpu/linear-memory.js";
import { TabgradError } from "../../../dist/shared/errors.js";

const fixtures = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist", import.meta.url)));
const oracle = JSON.parse(await readFile(new URL("../../fixtures/python-tensor-oracle.json", import.meta.url), "utf8"));
let distributionUrl;
before(async () => { distributionUrl = await fixtures.start(); });
after(async () => { await fixtures.close(); });

for (const forceVariant of ["scalar", "simd128"]) test(`native broadcast words/shapes with delayed owners (${forceVariant})`, async () => {
  const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
  try {
    const result = await checkBroadcastCases(session, oracle.broadcastCases, "cpu", oracle.broadcastCompositions);
    assert.equal(result.cases, 46);
    assert.ok(result.comparedWords > 0);
    assert.equal(session.diagnostics().liveAllocationBytes, 0);
  } finally { await session.close(); }
});

for (const forceVariant of ["scalar", "simd128"]) for (const operation of ["add", "mul"]) {
  test(`broadcast ${operation} forward and receiving gradients (${forceVariant})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
    try {
      const left = session.tensor([2, 3], { shape: [2, 1], requiresGrad: true });
      const right = session.tensor([4, 5, 6], { shape: [1, 3], requiresGrad: true });
      const result = left[operation](right), seed = session.tensor(Array(6).fill(1), { shape: [2, 3] });
      assert.deepEqual(result.shape, [2, 3]);
      assert.deepEqual([...await result.toArray()], operation === "add" ? [6, 7, 8, 7, 8, 9] : [8, 10, 12, 12, 15, 18]);
      const gradients = session.grad(result, [left, right], seed);
      assert.deepEqual(gradients.map(value => value.shape), [[2, 1], [1, 3]]);
      assert.deepEqual([...await gradients[0].toArray()], operation === "add" ? [3, 3] : [15, 15]);
      assert.deepEqual([...await gradients[1].toArray()], operation === "add" ? [2, 2, 2] : [5, 5, 5]);
      for (const value of [...gradients, left, right, result, seed]) value.close();
      assert.equal(session.diagnostics().liveAllocationBytes, 0);
      assert.equal(session.diagnostics().liveSavedValues, 0);
    } finally { await session.close(); }
  });
}

test("broadcast output capacity is checked before recording or saving operands", async () => {
  const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl) });
  try {
    const left = session.tensor(new Float32Array(65536), { shape: [65536, 1], requiresGrad: true });
    const right = session.tensor(new Float32Array(65536), { shape: [1, 65536], requiresGrad: true });
    const before = session.diagnostics();
    for (const operation of ["add", "mul"]) {
      assert.throws(() => left[operation](right), { code: "RESOURCE_EXHAUSTED" });
      assert.deepEqual(session.diagnostics(), before);
    }
    left.close(); right.close();
  } finally { await session.close(); }
});

for (const operation of ["add", "mul"]) test(`${operation} keeps one kernel and only original input uploads for dense and broadcast domains`, async () => {
  for (const [leftShape, rightShape] of [[[2, 3], [2, 3]], [[2, 1], [3]], [[2, 1, 3, 1], [1, 4, 1, 5]]]) {
    const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl) });
    try {
      const size = shape => shape.reduce((count, dimension) => count * dimension, 1);
      const left = session.tensor(new Float32Array(size(leftShape)), { shape: leftShape });
      const right = session.tensor(new Float32Array(size(rightShape)), { shape: rightShape });
      const output = left[operation](right);
      assert.equal(session.diagnostics().kernelCalls, 0);
      assert.equal(session.diagnostics().liveOperationRecords, 1);
      await output.toArray();
      const diagnostics = session.diagnostics();
      assert.equal(diagnostics.kernelCalls, 1);
      assert.equal(diagnostics.hostToWasmCopies, 2);
      assert.equal(diagnostics.hostToWasmBytes, (size(leftShape) + size(rightShape)) * 4);
      for (const value of [left, right, output]) value.close();
      assert.equal(session.diagnostics().liveAllocationBytes, 0);
    } finally { await session.close(); }
  }
});

test("CPU packet allocation failure rolls back payloads without poisoning the context", async context => {
  const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl) });
  try {
    await prepareRuntimeSession(session);
    const left = session.tensor([2, 3], { shape: [2, 1] }), right = session.tensor([4, 5, 6], { shape: [1, 3] });
    const original = LinearMemoryAllocator.prototype.allocate;
    const injected = new TabgradError("RESOURCE_EXHAUSTED", "controlled parameter allocation failure");
    const override = context.mock.method(LinearMemoryAllocator.prototype, "allocate", function (bytes) {
      if (bytes === 52) throw injected; // Header5 + rank2*(three axis fields + one counter).
      return Reflect.apply(original, this, [bytes]);
    });
    const failed = left.mul(right);
    await assert.rejects(failed.toArray(), error => error.code === "RESOURCE_EXHAUSTED" && error.cause === injected);
    assert.equal(session.diagnostics().liveAllocationBytes, 0);
    override.mock.restore();
    const next = left.add(right);
    assert.deepEqual([...await next.toArray()], [6, 7, 8, 7, 8, 9]);
    for (const value of [left, right, failed, next]) value.close();
    assert.equal(session.diagnostics().liveAllocationBytes, 0);
  } finally { await session.close(); }
});

for (const forceVariant of ["scalar", "simd128"]) for (const kernelBehavior of ["status", "trap"]) {
  test(`CPU broadcast ${kernelBehavior} retires private packets (${forceVariant})`, async () => {
    const session = createTestRuntimeSession({ forceVariant,
      manifestUrl: fixtures.installFixture(`broadcast-${forceVariant}-${kernelBehavior}`, { kernelBehavior }) });
    try {
      const left = session.tensor([2, 3], { shape: [2, 1] }), right = session.tensor([4, 5, 6], { shape: [1, 3] });
      const result = left.add(right);
      await assert.rejects(result.toArray(), { code: kernelBehavior === "status" ? "BACKEND_STATUS_ERROR" : "BACKEND_TRAP" });
      assert.equal(session.diagnostics().liveAllocationBytes, 0);
      for (const value of [left, right, result]) value.close();
    } finally { await session.close(); }
  });
}
