import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { queryObjects } from "node:v8";
import { createTestRuntimeSession, getTestRuntimeSemanticOwnership } from "../../dist/testing.js";
import { registerOptimizerLease } from "../../dist/runtime/runtime.js";
import { TensorState, TensorIdentity } from "../../dist/runtime/tensor-family.js";
import { WebAssemblyCpuBackend } from "../../dist/backends/cpu/cpu-backend.js";

assert.equal(typeof globalThis.gc, "function");
globalThis.fetch = async url => new Response(await readFile(url));
const rows = [];

/** Count only our descriptors, after the allocating frame and host job return. */
async function census() {
  await new Promise(resolve => setImmediate(resolve));
  globalThis.gc();
  await new Promise(resolve => setImmediate(resolve));
  return { states: queryObjects(TensorState), identities: queryObjects(TensorIdentity) };
}

/** Return only opaque leases/callbacks; public parameter arrays never escape. */
async function parameters(session, groups, count, repetitions, retirement, callbackOnly) {
  const held = [];
  for (let repeat = 0; repeat < repetitions; repeat += 1) {
    const members = Array.from({ length: groups }, () =>
      Array.from({ length: count }, () => session.tensor([2])));
    const lease = registerOptimizerLease(session, members);
    if (retirement === "failure") {
      const parameter = members[0][0];
      const computed = parameter.add(parameter);
      session.noGrad(() => parameter.copy_(computed));
      await parameter.toArray();
      computed.close();
    }
    for (const group of members) for (const parameter of group) parameter.close();
    const fault = new Error("controlled retired optimizer release failure");
    const release = WebAssemblyCpuBackend.prototype.release;
    if (retirement === "failure") {
      WebAssemblyCpuBackend.prototype.release = function (allocation) {
        Reflect.apply(release, this, [allocation]);
        throw fault;
      };
    }
    try {
      if (retirement === "close") lease.close();
      else if (retirement === "finalize") lease.finalize();
      else if (retirement === "failure") assert.throws(() => lease.close(), error => error === fault);
      if (retirement !== "live" && retirement !== "session") {
        assert.throws(() => lease.assertOpen(), { code: "CLOSED_OPTIMIZER" });
        lease.close(); lease.finalize();
      }
    } finally { WebAssemblyCpuBackend.prototype.release = release; }
    held.push(callbackOnly ? lease.finalize : lease);
  }
  return held;
}

for (const forceVariant of ["scalar", "simd128"]) {
  // A live private owner remains sensitive even after its public handles close.
  const control = createTestRuntimeSession({ forceVariant });
  let live = await parameters(control, 2, 4, 1, "live", false);
  assert.deepEqual(await census(), { states: 8, identities: 8 });
  for (const lease of live) lease.close();
  live = null;
  await control.close();
  assert.deepEqual(await census(), { states: 0, identities: 0 });

  for (const retirement of ["close", "finalize", "session", "failure"]) {
    for (const callbackOnly of [false, true]) {
      for (const [groups, count, repetitions] of [[1, 1, 1], [1, 4, 1], [4, 1, 1], [1, 1, 4], [2, 4, 4]]) {
        const session = createTestRuntimeSession({ forceVariant });
        const held = await parameters(session, groups, count, repetitions, retirement, callbackOnly);
        if (retirement === "session") await session.close();
        const owners = getTestRuntimeSemanticOwnership(session);
        assert.ok(Object.entries(owners).filter(([key]) => !key.startsWith("collector")).every(([, value]) => value === 0));
        assert.deepEqual(await census(), { states: 0, identities: 0 },
          `${forceVariant} ${retirement} callbackOnly=${callbackOnly} groups=${groups} count=${count} repetitions=${repetitions}`);
        // Keep the opaque references live across the census; repeat retirement.
        for (const owner of held) {
          if (callbackOnly) owner();
          else { owner.close(); owner.finalize(); }
        }
        await session.close();
        rows.push({ forceVariant, retirement, callbackOnly, groups, count, repetitions });
      }
    }
  }
}
console.log(JSON.stringify(rows));
