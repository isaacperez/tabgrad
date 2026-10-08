import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";
import { createTestRuntimeSession, getTestRuntimeOwnership, getTestRuntimeSemanticOwnership } from "../../../dist/testing.js";

const fixtures = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist", import.meta.url)));
let distributionUrl;
before(async () => { distributionUrl = await fixtures.start(); });
after(async () => { await fixtures.close(); });
const createSession = (forceVariant = "scalar") => createTestRuntimeSession({
  manifestUrl: new URL("manifest.json", distributionUrl), forceVariant,
});

function snapshot(session) {
  return [session.diagnostics(), getTestRuntimeOwnership(session), getTestRuntimeSemanticOwnership(session)];
}

function assertRetired(session) {
  for (const value of Object.values(getTestRuntimeOwnership(session))) assert.equal(value, 0);
  for (const [name, value] of Object.entries(getTestRuntimeSemanticOwnership(session))) {
    if (!name.startsWith("collector")) assert.equal(value, 0, name);
  }
  for (const name of ["liveTensorHandles", "liveTensorValues", "liveDerivativeNodes", "liveSavedValues", "liveRequestLeases", "liveAllocationBytes"]) {
    assert.equal(session.diagnostics()[name], 0, name);
  }
}

for (const variant of ["scalar", "simd128"]) {
  for (const position of ["all", "first", "middle", "last"]) for (const explicit of [false, true]) {
    test(`functional sparse ${position} input rejects before history/seed admission (${variant}, explicit=${explicit})`, async () => {
      const session = createSession(variant);
      try {
        const x = session.tensor([2], { requiresGrad: true });
        const y = x.mul(x); const seed = session.tensor([1]);
        const inputs = position === "all" ? new Array(3) : [x, x, x];
        if (position !== "all") delete inputs[{ first: 0, middle: 1, last: 2 }[position]];
        const before = snapshot(session);
        assert.throws(() => {
          // Retire unexpected results too, so the red is the admission defect.
          const unexpected = explicit ? session.grad(y, inputs, seed) : session.grad(y, inputs);
          unexpected.forEach(value => value.close());
        }, { code: "INVALID_TENSOR" });
        assert.deepEqual(snapshot(session), before, "rejected metadata admitted no derivative or seed");
        assert.equal(session.diagnostics().kernelCalls, 0);
        assert.equal(session.diagnostics().backendLoads, 0);
        const [gradient] = explicit ? session.grad(y, [x], seed) : session.grad(y, [x]);
        assert.deepEqual(Array.from(await gradient.toArray()), [4]);
        gradient.close(); x.close(); y.close(); seed.close();
      } finally { await session.close(); }
      assertRetired(session);
    });
  }
}

test("dense invalid inputs and seed errors retain their validation phases and history", async () => {
  const session = createSession(); const other = createSession();
  try {
    const x = session.tensor([2], { requiresGrad: true }); const y = x.mul(x);
    const foreign = other.tensor([3], { requiresGrad: true });
    const closed = session.tensor([3], { requiresGrad: true }); closed.close();
    const plain = session.tensor([3]); const invalidSeed = session.tensor([1, 1]);
    const before = snapshot(session);
    for (const [invalid, code] of [[undefined, "INVALID_TENSOR"], [null, "INVALID_TENSOR"],
      [foreign, "DIFFERENT_SESSION"], [closed, "CLOSED_TENSOR"], [plain, "GRADIENT_NOT_TRACKED"]]) {
      assert.throws(() => session.grad(y, [x, invalid, x], invalidSeed), { code });
      assert.deepEqual(snapshot(session), before);
    }
    assert.throws(() => session.grad(y, new Array(1), invalidSeed), { code: "INVALID_TENSOR" });
    assert.deepEqual(snapshot(session), before);
    assert.throws(() => session.grad(y, [x], invalidSeed), { code: "SHAPE_MISMATCH" });
    assert.deepEqual(snapshot(session), before);
    const [gradient] = session.grad(y, [x]);
    assert.deepEqual(Array.from(await gradient.toArray()), [4]); gradient.close();
  } finally { await session.close(); await other.close(); }
  assertRetired(session); assertRetired(other);
});

test("functional indexed access validates each occurrence before the next getter", async () => {
  const session = createSession();
  try {
    const x = session.tensor([2], { requiresGrad: true }); const y = x.mul(x);
    const events = []; const original = new Error("requested input getter");
    const inputs = [x, x, x];
    Object.defineProperty(inputs, 1, { configurable: true, get() { events.push(1); throw original; } });
    Object.defineProperty(inputs, 2, { get() { events.push(2); return x; } });
    const before = snapshot(session);
    assert.throws(() => session.grad(null, inputs), { code: "INVALID_TENSOR" });
    assert.deepEqual(events, []);
    assert.throws(() => session.grad(y, inputs), error => error === original);
    assert.deepEqual(events, [1]); assert.deepEqual(snapshot(session), before);
    delete inputs[1]; events.length = 0;
    assert.throws(() => session.grad(y, inputs), { code: "INVALID_TENSOR" });
    assert.deepEqual(events, [], "missing earlier position rejects before a later getter");
    assert.deepEqual(snapshot(session), before);
    const [gradient] = session.grad(y, [x]);
    assert.deepEqual(Array.from(await gradient.toArray()), [4]); gradient.close();
  } finally { await session.close(); }
  assertRetired(session);
});

test("functional normalization captures length while reading current indexed values", async () => {
  for (const change of ["append", "shrink"]) {
    const session = createSession();
    try {
      const x = session.tensor([2], { requiresGrad: true }); const y = x.mul(x);
      const events = []; const inputs = change === "append" ? [x] : [x, x];
      Object.defineProperty(inputs, 0, { get() {
        events.push(0);
        if (change === "append") inputs.push(undefined);
        else inputs.length = 1;
        return x;
      } });
      const before = snapshot(session);
      if (change === "shrink") {
        assert.throws(() => session.grad(y, inputs), { code: "INVALID_TENSOR" });
        assert.deepEqual(snapshot(session), before);
      }
      const gradients = session.grad(y, change === "shrink" ? [x] : inputs);
      assert.equal(gradients.length, 1);
      assert.deepEqual(Array.from(await gradients[0].toArray()), [4]); gradients[0].close();
      assert.deepEqual(events, [0]);
    } finally { await session.close(); }
    assertRetired(session);
  }
});

for (const kind of ["fractional", "coercible", "bigint", "overflow", "infinite"]) {
  test(`functional proxy length retains one array length conversion (${kind})`, async () => {
    const session = createSession();
    try {
      const x = session.tensor([2], { requiresGrad: true }); const y = x.mul(x);
      const events = []; const original = new Error("overflow must precede indexed read");
      const length = kind === "fractional" ? 2.5 : kind === "bigint" ? 2n : kind === "overflow" ? 2 ** 32 : kind === "infinite" ? Infinity
        : { valueOf() { events.push("coerce"); return 2; } };
      const inputs = new Proxy([x, x], { get(target, key, receiver) {
        if (key === "length") { events.push("length"); return length; }
        if (key === "0" || key === "1" || key === "2") {
          events.push(key);
          if (kind === "overflow" || kind === "infinite") throw original;
        }
        return Reflect.get(target, key, receiver);
      } });
      const before = snapshot(session);
      if (kind === "bigint" || kind === "overflow" || kind === "infinite") {
        assert.throws(() => session.grad(y, inputs), kind === "bigint" ? TypeError : RangeError);
        assert.deepEqual(events, ["length", "length"]);
        assert.deepEqual(snapshot(session), before);
        const [gradient] = session.grad(y, [x]);
        assert.deepEqual(Array.from(await gradient.toArray()), [4]); gradient.close();
      } else {
        const [first, second] = session.grad(y, inputs);
        first.close(); assert.deepEqual(Array.from(await second.toArray()), [4]); second.close();
        assert.deepEqual(events, ["length", "length", ...(kind === "coercible" ? ["coerce"] : []), "0", "1"]);
      }
    } finally { await session.close(); }
    assertRetired(session);
  });
}

test("inherited requested indexes preserve ordered independently closeable repeats", async () => {
  const session = createSession();
  try {
    const x = session.tensor([2], { requiresGrad: true }); const q = session.tensor([3], { requiresGrad: true });
    const y = x.mul(x).add(q.mul(q)); const events = [];
    const prototype = Object.create(Array.prototype);
    Object.defineProperty(prototype, 1, { get() { events.push(1); return q; } });
    const inputs = [x, , x]; Object.setPrototypeOf(inputs, prototype);
    const [first, second, third] = session.grad(y, inputs);
    assert.deepEqual(events, [1]);
    assert.notEqual(first, third); first.close();
    assert.deepEqual(Array.from(await second.toArray()), [6]);
    assert.deepEqual(Array.from(await third.toArray()), [4]); second.close(); third.close();
  } finally { await session.close(); }
  assertRetired(session);
});

test("a repeated occurrence is revalidated after its indexed getter closes the handle", async () => {
  const session = createSession();
  try {
    const x = session.tensor([2], { requiresGrad: true }); const y = x.mul(x);
    const events = []; const inputs = [x, x, x];
    Object.defineProperty(inputs, 1, { get() { events.push(1); x.close(); return x; } });
    Object.defineProperty(inputs, 2, { get() { events.push(2); return x; } });
    const saves = session.diagnostics().liveSavedValues;
    assert.throws(() => session.grad(y, inputs), { code: "CLOSED_TENSOR" });
    assert.deepEqual(events, [1]);
    assert.equal(session.diagnostics().liveSavedValues, saves);
    assert.equal(session.diagnostics().kernelCalls, 0);
  } finally { await session.close(); }
  assertRetired(session);
});

test("requested handle reads precede output history and seed errors precede input history", async () => {
  const session = createSession();
  try {
    const x = session.tensor([2], { requiresGrad: true });
    const special = session.noGrad(() => x.view([1])); const y = x.mul(x);
    session.noGrad(() => x.copy_(x));
    const wrongSeed = session.tensor([1, 1]); const seed = session.tensor([1]);
    assert.throws(() => session.grad(special, [undefined]), { code: "INVALID_TENSOR" });
    assert.throws(() => session.grad(special, [x]), { code: "INPLACE_VIEW" });
    assert.throws(() => session.grad(y, [special], wrongSeed), { code: "SHAPE_MISMATCH" });
    assert.throws(() => session.grad(y, [special], seed), { code: "INPLACE_VIEW" });
  } finally { await session.close(); }
  assertRetired(session);
});

for (const kind of ["close", "replace", "throw", "missing"]) {
  test(`functional proxy presence precedes indexed reads and validation (${kind})`, async () => {
    const session = createSession();
    try {
      const x = session.tensor([2], { requiresGrad: true }); const q = session.tensor([3], { requiresGrad: true });
      const y = x.mul(x).add(q.mul(q)); const events = []; const original = new Error("requested input presence");
      const inputs = new Proxy([x], {
        has(target, key) {
          if (key === "0") {
            events.push("has:0");
            if (kind === "close") x.close();
            if (kind === "replace") target[0] = q;
            if (kind === "throw") throw original;
            if (kind === "missing") return false;
          }
          return Reflect.has(target, key);
        },
        get(target, key, receiver) {
          if (key === "0") { events.push("get:0"); if (kind === "missing") throw original; }
          return Reflect.get(target, key, receiver);
        },
      });
      const before = snapshot(session);
      if (kind === "replace") {
        const [gradient] = session.grad(y, inputs);
        assert.deepEqual(Array.from(await gradient.toArray()), [6]); gradient.close();
        assert.deepEqual(events, ["has:0", "get:0"]);
      } else {
        assert.throws(() => session.grad(y, inputs), kind === "throw" ? error => error === original
          : { code: kind === "close" ? "CLOSED_TENSOR" : "INVALID_TENSOR" });
        assert.deepEqual(events, kind === "close" ? ["has:0", "get:0"] : ["has:0"]);
        assert.equal(session.diagnostics().kernelCalls, 0);
        assert.equal(session.diagnostics().backendLoads, 0);
        if (kind !== "close") {
          assert.deepEqual(snapshot(session), before);
          const [gradient] = session.grad(y, [x]);
          assert.deepEqual(Array.from(await gradient.toArray()), [4]); gradient.close();
        } else {
          assert.equal(session.diagnostics().liveSavedValues, before[0].liveSavedValues);
        }
      }
    } finally { await session.close(); }
    assertRetired(session);
  });
}
