import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecutionProbe } from "../browser/execution-probe.mjs";

test("diagnostic spans preserve receiver, results, errors and inclusive nesting", () => {
  let now = 0;
  const probe = new ExecutionProbe(() => now);
  const failure = new Error("original failure");
  const owner = {
    inner(value) { now += 2; return this.bias + value; },
    outer(value) { now += 1; const result = this.inner(value); now += 3; return result; },
    fail() { now += 4; throw failure; },
    bias: 10,
  };
  const descriptor = Object.getOwnPropertyDescriptor(owner, "outer");
  probe.method(owner, "inner", "inner");
  probe.method(owner, "outer", "outer");
  probe.method(owner, "fail", "failure");
  try {
    assert.equal(owner.outer(5), 15);
    assert.throws(() => owner.fail(), (error) => error === failure);
    assert.deepEqual(probe.snapshot(), {
      outer: { calls: 1, failures: 0, milliseconds: 6 },
      inner: { calls: 1, failures: 0, milliseconds: 2 },
      failure: { calls: 1, failures: 1, milliseconds: 4 },
    });
    const snapshot = probe.snapshot();
    snapshot.outer.calls = 99;
    assert.equal(probe.snapshot().outer.calls, 1);
    probe.reset();
    assert.deepEqual(probe.snapshot(), {});
  } finally { probe.restore(); }
  probe.restore();
  assert.deepEqual(Object.getOwnPropertyDescriptor(owner, "outer"), descriptor);
  assert.equal(owner.outer(7), 17);
  assert.deepEqual(probe.snapshot(), {});
});

test("export observation preserves other modules and caches a native-call facade", () => {
  let now = 0;
  const probe = new ExecutionProbe(() => now);
  const failure = new Error("native trap");
  const native = Object.freeze({
    tabgrad_add_f32(left, right) { now += 1; if (left < 0) throw failure; return left + right; },
    tabgrad_abi_version: () => 1,
  });
  const unrelated = Object.freeze({ other: () => 2 });
  const prototype = { get exports() { return this.original; } };
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "exports");
  const instance = Object.assign(Object.create(prototype), { original: native });
  const other = Object.assign(Object.create(prototype), { original: unrelated });
  probe.kernelExports(prototype);
  try {
    assert.equal(other.exports, unrelated);
    assert.equal(instance.exports, instance.exports);
    assert.equal(instance.exports.tabgrad_abi_version, native.tabgrad_abi_version);
    assert.equal(instance.exports.tabgrad_add_f32(3, 4), 7);
    assert.throws(() => instance.exports.tabgrad_add_f32(-1, 4), (error) => error === failure);
    assert.deepEqual(probe.snapshot(), { kernel: { calls: 2, failures: 1, milliseconds: 2 } });
  } finally { probe.restore(); }
  assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, "exports"), descriptor);
  assert.equal(instance.exports, native);
});

test("unsupported instrumentation fails explicitly and earlier patches can be restored", () => {
  const probe = new ExecutionProbe();
  const owner = { first() {} };
  const original = owner.first;
  probe.method(owner, "first", "first");
  assert.throws(() => probe.method(owner, "missing", "missing"), /Cannot instrument/);
  assert.throws(() => probe.kernelExports({}), /Cannot instrument/);
  probe.restore();
  assert.equal(owner.first, original);
});
