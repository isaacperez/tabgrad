import assert from "node:assert/strict";
import { WebAssemblyCpuBackend } from "../../dist/backends/cpu/cpu-backend.js";
import { WriterOutcomeLedger } from "../../dist/runtime/writer-outcome.js";

// Import the runtime only after the override: capturing originals there would
// incorrectly classify this ordinary external dispatch as canonical.
const [manifestUrl, forceVariant, kind] = process.argv.slice(2);
const object = kind === "cpu" ? WebAssemblyCpuBackend.prototype : WriterOutcomeLedger.prototype;
const name = kind === "cpu" ? "execute" : "retain";
const original = Object.getOwnPropertyDescriptor(object, name);
let calls = 0;
Object.defineProperty(object, name, { ...original, value: function (...args) {
  calls += 1;
  return Reflect.apply(original.value, this, args);
} });
const { createTestRuntimeSession, getTestRuntimeOwnership } = await import("../../dist/testing.js");
const { prepareRuntimeSession } = await import("../../dist/runtime/runtime.js");
const session = createTestRuntimeSession({ manifestUrl: new URL(manifestUrl), forceVariant, updateLimits: { owners: 965 } });
try {
  await prepareRuntimeSession(session);
  const leaves = Array.from({ length: 16 }, () => session.tensor([2], { requiresGrad: true }));
  let root = leaves[0];
  for (const leaf of leaves.slice(1)) {
    const next = root.add(leaf);
    if (root !== leaves[0]) root.close();
    root = next;
  }
  calls = 0;
  assert.throws(() => root.backward(), error => error.code === "RESOURCE_EXHAUSTED"
    && error.details.owners === 111 && error.details.additionalOwners === 13430);
  assert.equal(calls, 0);
  assert.ok(leaves.every(leaf => leaf.grad === null));
} finally {
  Object.defineProperty(object, name, original);
  await session.close();
}
assert.ok(Object.values(getTestRuntimeOwnership(session)).every(count => count === 0));
assert.equal(session.diagnostics().liveAllocationBytes, 0);
process.stdout.write("pre-import fallback passed\n");
