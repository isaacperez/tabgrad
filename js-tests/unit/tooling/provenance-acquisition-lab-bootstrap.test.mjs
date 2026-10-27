import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createLabBootstrap } from "../../../scripts/provenance-acquisition-lab-bootstrap.mjs";
import { NativeLabIO } from "../../../scripts/provenance-acquisition-lab-io.mjs";
import { labNativePorts } from "../../fixtures/provenance-acquisition-lab.mjs";
import { inputModel } from "../../fixtures/provenance-acquisition-lab-input.mjs";
import { deferred } from "../../fixtures/provenance-acquisition-host.mjs";

test("input observation composes with actual prepare/retire owners without a fabricated profile or new origin", async () => {
  const m = await inputModel(); let ports; let copied;
  try {
    const owner = createLabBootstrap(m.plan, { inputIo: m.port, clock: () => 100n, labIo(p, checks) {
      assert([...m.handles.values()].every(h => h.closed)); copied = p;
      ports = labNativePorts(p); return new NativeLabIO(p, checks, ports);
    } });
    assert.deepEqual(m.calls, []); assert.equal(ports, undefined);
    const work = owner.run(); assert.equal(owner.run(), work); const result = await work;
    assert(result.locallyComplete); assert(result.lab.retirementObserved); assert(result.input.locallyComplete);
    assert.equal(copied.context.t0MonotonicNs, result.input.originNs); assert.equal(result.input.originNs, "100");
    assert.equal(result.lab.clockAdmission, "unqualified"); assert.equal(result.releaseAdmission, "unqualified");
    assert.equal(ports.calls.filter(c => c[0] === "command" && c[1] === "systemdRun").length, 1);
    assert.equal(ports.calls.filter(c => c[0] === "effect" && c[1] === "unit.kill").length, 1);
    assert.deepEqual(await owner.close(), result);
  } finally { await m.close(); }
});

test("failed observation never selects the native laboratory factory", async () => {
  const m = await inputModel(); let selected = 0;
  try {
    m.port.platform = "darwin";
    const owner = createLabBootstrap(m.plan, { inputIo: m.port, clock: () => 100n, labIo() { selected++; assert.fail(); } });
    const result = await owner.run(); assert.equal(result.firstFailure, "LAB_PLATFORM");
    assert.equal(result.lab, null); assert.equal(selected, 0); assert(!result.locallyComplete);
  } finally { await m.close(); }
});

test("reentrant stop during laboratory selection revokes the newly constructed owner before preparation", async () => {
  const m = await inputModel(); let owner; let ports;
  try {
    owner = createLabBootstrap(m.plan, { inputIo: m.port, clock: () => 100n, labIo(p, checks) {
      owner.stop(); ports = labNativePorts(p); return new NativeLabIO(p, checks, ports);
    } });
    const result = await owner.run(); assert.equal(result.firstFailure, "LAB_STOPPED");
    assert(result.stopped); assert(!result.locallyComplete); assert(!result.lab.ready);
    assert(!ports.calls.some(c => c[0] === "command" || c[0] === "effect"));
    assert([...m.handles.values()].every(h => h.closed));
  } finally { await m.close(); }
});

test("time spent observing inputs consumes preparation, instead of resetting the laboratory clock", async () => {
  const m = await inputModel(); let now = 100n; let ports;
  try {
    const owner = createLabBootstrap(m.plan, { inputIo: m.port, clock: () => now, labIo(p, checks) {
      now += BigInt(p.limits.prepareMs) * 1000000n; ports = labNativePorts(p); return new NativeLabIO(p, checks, ports);
    } });
    const result = await owner.run(); assert(result.input.locallyComplete);
    assert.equal(result.firstFailure, "LAB_DEADLINE"); assert(!result.locallyComplete);
    assert(!ports.calls.some(c => c[0] === "command" || c[0] === "effect"));
  } finally { await m.close(); }
});

test("stop during a late input opening blocks the next stage and preserves late handle ownership", async () => {
  const enter = deferred(); const hold = deferred(); const closing = deferred(); let selected = 0;
  const m = await inputModel({ async beforeOpen() { enter.resolve(); await hold.promise; }, beforeClose() { closing.resolve(); } });
  try {
    m.plan.limits.retireMs = 20;
    const owner = createLabBootstrap(m.plan, { inputIo: m.port, clock: () => 100n, labIo() { selected++; assert.fail(); } });
    const run = owner.run(); await enter.promise; owner.stop(); const result = await run;
    assert.equal(result.firstFailure, "LAB_STOPPED"); assert.equal(result.cleanupError, "LAB_CLEANUP");
    assert(result.input.workPending); assert.equal(selected, 0); assert.equal(result.lab, null);
    hold.resolve(); await closing.promise; await setImmediate();
    assert.equal(owner.snapshot().input.handles.retained, 0); assert.equal(selected, 0);
  } finally { hold.resolve(); await m.close(); }
});

test("stop before run remains inert; malformed inputs fail before selecting either I/O stage", async () => {
  const m = await inputModel(); let selected = 0;
  try {
    const options = { inputIo: m.port, clock: () => 100n, labIo() { selected++; assert.fail(); } };
    const owner = createLabBootstrap(m.plan, options); await owner.close(); const result = await owner.run();
    assert.equal(result.firstFailure, "LAB_STOPPED"); assert(!result.locallyComplete); assert.equal(selected, 0);
    assert.deepEqual(m.calls, []);
    m.plan.context.t0MonotonicNs = "0"; assert.throws(() => createLabBootstrap(m.plan, options), { code: "LAB_INPUT" });
    assert.deepEqual(m.calls, []);
  } finally { await m.close(); }
});
