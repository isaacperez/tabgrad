import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { RuntimeSession, inspectRuntimeOwnershipForTesting } from "../../dist/runtime/runtime.js";
import { TensorValue } from "../../dist/runtime/tensor-value.js";
import { TensorFamily } from "../../dist/runtime/tensor-family.js";

globalThis.fetch = async url => {
  try { return new Response(await readFile(url)); }
  catch { return new Response(null, { status: 404 }); }
};
const OriginalWeakRef = globalThis.WeakRef;

async function closedProjection(length, occurrences) {
  const observed = [];
  globalThis.WeakRef = new Proxy(OriginalWeakRef, {
    construct(target, args) {
      if (args[0] instanceof TensorValue || args[0] instanceof TensorFamily) observed.push(new OriginalWeakRef(args[0]));
      return Reflect.construct(target, args);
    },
  });
  const session = new RuntimeSession();
  try {
    const seed = session.tensor([3], { shape: [] });
    const input = session.tensor(new Float32Array(length), { requiresGrad: true }), loss = input.sum();
    const results = session.grad(loss, Array(occurrences).fill(input), seed);
    await results[0].toArray();
    const captured = results[0].add(results[0]), replacement = session.tensor([4], { shape: [] });
    seed.copy_(replacement); replacement.close();
    assert.deepEqual([...await captured.toArray()], Array(length).fill(6));
    captured.close();
    for (const result of results) result.close();
    for (const value of [seed, input, loss]) value.close();
    await session.close();
    assert.ok(Object.values(inspectRuntimeOwnershipForTesting(session)).every(value => value === 0));
    return { session, observed };
  } finally { globalThis.WeakRef = OriginalWeakRef; }
}

let known = { payload: 17 };
const calibration = new OriginalWeakRef(known);
global.gc(); assert.ok(calibration.deref());
known = null;
await new Promise(resolve => setImmediate(resolve));
global.gc(); assert.equal(calibration.deref(), undefined);
const rows = [];
for (const length of [0, 65]) for (const occurrences of [1, 16]) {
  const { session, observed } = await closedProjection(length, occurrences);
  assert.ok(observed.length > 0, "the control must observe actual projection eligibility objects");
  let remaining, turns = 0;
  do {
    await new Promise(resolve => setImmediate(resolve));
    global.gc();
    remaining = observed.filter(reference => reference.deref() !== undefined).length;
  } while (remaining > 0 && ++turns < 32);
  assert.equal(remaining, 0, "closed session retains scalar projection metadata/family");
  assert.equal(session.diagnostics().liveTensorValues, 0);
  rows.push({ length, occurrences, remaining });
}
process.stdout.write(JSON.stringify(rows));
