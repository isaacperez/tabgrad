import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";
import { createTestRuntimeSession, getTestRuntimeOwnership } from "../../../dist/testing.js";
import { DerivativeHistory } from "../../../dist/runtime/autograd/derivative-history.js";

const fixtures = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist", import.meta.url)));
let distributionUrl;
before(async () => { distributionUrl = await fixtures.start(); });
after(async () => { await fixtures.close(); });

async function closeSession(session) {
  await session.close();
  for (const count of Object.values(getTestRuntimeOwnership(session))) assert.equal(count, 0);
  assert.equal(session.diagnostics().liveAllocationBytes, 0);
}

for (const forceVariant of ["scalar", "simd128"]) {
  test(`backward validates a repeated handle after an indexed getter closes it (${forceVariant})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
    try {
      const x = session.tensor([2], { requiresGrad: true });
      const out = x.sum();
      const inputs = [x, x];
      let visits = 0;
      Object.defineProperty(inputs, "1", { get() { visits++; x.close(); return x; } });
      assert.throws(() => out.backward(undefined, { inputs }), { code: "CLOSED_TENSOR" });
      assert.equal(visits, 1);
    } finally { await closeSession(session); }
  });

  test(`backward closes an iterator on a late invalid input and keeps earlier retention (${forceVariant})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
    try {
      const x = session.tensor([2, 3], { requiresGrad: true });
      const mid = x.add(x), out = mid.sum();
      const events = [];
      const inputs = [mid];
      inputs[Symbol.iterator] = function* () {
        try {
          events.push("first"); yield mid;
          events.push("repeat"); yield mid;
          events.push("invalid"); yield 1;
          events.push("unreached");
        } finally { events.push("close"); }
      };
      assert.throws(() => out.backward(undefined, { inputs }), { code: "INVALID_TENSOR" });
      assert.deepEqual(events, ["first", "repeat", "invalid", "close"]);
      assert.equal(mid.grad, null);
      mid.sum().backward();
      assert.deepEqual([...await mid.grad.toArray()], [1, 1]);
      assert.deepEqual([...await x.grad.toArray()], [2, 2]);
    } finally { await closeSession(session); }
  });

  test(`backward preserves an iterator's original exception and prior retention (${forceVariant})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
    try {
      const x = session.tensor([2], { requiresGrad: true });
      const mid = x.add(x), out = mid.sum();
      const failure = new Error("input iterator failed");
      const inputs = [mid];
      inputs[Symbol.iterator] = function* () { yield mid; yield mid; throw failure; };
      assert.throws(() => out.backward(undefined, { inputs }), error => error === failure);
      mid.sum().backward();
      assert.deepEqual([...await mid.grad.toArray()], [1]);
      assert.deepEqual([...await x.grad.toArray()], [2]);
    } finally { await closeSession(session); }
  });

  test(`backward visits sparse holes and appended duplicate occurrences (${forceVariant})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
    try {
      const x = session.tensor([2], { requiresGrad: true });
      const out = x.sum();
      assert.throws(() => out.backward(undefined, { inputs: [x, , x] }), { code: "INVALID_TENSOR" });
      let visits = 0;
      const inputs = [x];
      Object.defineProperty(inputs, "0", { get() {
        visits++;
        inputs.push(x);
        Object.defineProperty(inputs, "1", { get() { visits++; return x; } });
        return x;
      } });
      out.backward(undefined, { inputs });
      assert.equal(visits, 2);
      assert.deepEqual([...await x.grad.toArray()], [1]);
    } finally { await closeSession(session); }
  });

  test(`backward preserves option reads and a changing inputs property (${forceVariant})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
    try {
      const x = session.tensor([2], { requiresGrad: true });
      const unused = session.tensor([3], { requiresGrad: true });
      const out = x.sum();
      let reads = 0;
      const options = { get inputs() { reads++; return reads === 5 ? [unused, unused] : [x]; } };
      out.backward(undefined, options);
      assert.equal(reads, 6);
      assert.equal(x.grad, null);
      assert.equal(unused.grad, null);
    } finally { await closeSession(session); }
  });

  test(`backward keeps distinct alias identities in first-occurrence order (${forceVariant})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
    const original = DerivativeHistory.prototype.plan;
    const selections = [];
    try {
      const x = session.tensor([2], { requiresGrad: true });
      const a = x.view([1]), b = x.view([1]);
      const unrelated = session.tensor([3], { requiresGrad: true });
      DerivativeHistory.prototype.plan = function (output, requested, ...rest) {
        selections.push([...requested]);
        return Reflect.apply(original, this, [output, requested, ...rest]);
      };
      unrelated.backward(undefined, { inputs: [a] });
      unrelated.backward(undefined, { inputs: [b] });
      a.add(b).sum().backward(undefined, { inputs: [b, a, b] });
      assert.notEqual(selections[0][0], selections[1][0]);
      assert.deepEqual(selections[2], [selections[1][0], selections[0][0]]);
      assert.deepEqual([...await a.grad.toArray()], [1]);
      assert.deepEqual([...await b.grad.toArray()], [1]);
      assert.equal(x.grad, null);
    } finally { DerivativeHistory.prototype.plan = original; await closeSession(session); }
  });
}
