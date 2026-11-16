import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { createRuntimeSession } from "../../../dist/index.js";

const MiB = 1024 * 1024;
const defaults = { cpuLinearMemoryBytes: 64 * MiB, updateBackingBytes: 64 * MiB };

test("memory limits distinguish immutable configuration from cold physical capacity", async () => {
  const session = createRuntimeSession();
  try {
    const cold = session.diagnostics();
    assert.deepEqual(cold.memoryLimits, defaults);
    assert.ok(Object.isFrozen(cold.memoryLimits));
    assert.equal(cold.cpuMemoryCapacity, null);
    assert.equal(cold.backendLoads, 0);
    assert.equal(cold.wasmMemoryBytes, 0);
  } finally { await session.close(); }
  assert.deepEqual(session.diagnostics().memoryLimits, defaults);
  assert.equal(session.diagnostics().cpuMemoryCapacity, null);
});

test("memory limits capture independent session budgets without retaining caller options", async () => {
  const limits = { cpuLinearMemoryBytes: 128 * MiB, updateBackingBytes: 4096 };
  const first = createRuntimeSession({ memoryLimits: limits });
  const second = createRuntimeSession({ memoryLimits: { cpuLinearMemoryBytes: 2 * MiB } });
  limits.cpuLinearMemoryBytes = 256 * MiB;
  limits.updateBackingBytes = 0;
  try {
    assert.deepEqual(first.diagnostics().memoryLimits, { cpuLinearMemoryBytes: 128 * MiB, updateBackingBytes: 4096 });
    assert.deepEqual(second.diagnostics().memoryLimits, { cpuLinearMemoryBytes: 2 * MiB, updateBackingBytes: 64 * MiB });
    assert.equal(first.diagnostics().backendLoads, 0);
    assert.equal(second.diagnostics().backendLoads, 0);
  } finally { await first.close(); await second.close(); }
});

for (const invalid of [null, [], 42, "64MiB", { unknown: 1 }, { [Symbol("unknown")]: 1 },
  Object.defineProperty({}, "cpuBytes", { value: 1024 }),
  { cpuLinearMemoryBytes: 2 * MiB - 65_536 }, { cpuLinearMemoryBytes: 2 * MiB + 1 },
  { cpuLinearMemoryBytes: 256 * MiB + 65_536 }, { cpuLinearMemoryBytes: NaN },
  { cpuLinearMemoryBytes: Infinity }, { cpuLinearMemoryBytes: "67108864" }, { cpuLinearMemoryBytes: null },
  { updateBackingBytes: -1 }, { updateBackingBytes: .5 }, { updateBackingBytes: 64 * MiB + 1 },
  { updateBackingBytes: NaN }, { updateBackingBytes: Infinity }, { updateBackingBytes: "1024" }, { updateBackingBytes: null }]) {
  test(`memory limits reject invalid configuration: ${inspect(invalid, { showHidden: true })}`, async () => {
    let unexpected;
    try { assert.throws(() => { unexpected = createRuntimeSession({ memoryLimits: invalid }); }, TypeError); }
    finally { await unexpected?.close(); }
  });
}
