import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";

// Capture actual state without a production test API. Native registration and
// cleanup still run; Node isolates this module from the other test files.
const states = new WeakMap();
const NativeFinalizationRegistry = globalThis.FinalizationRegistry;
globalThis.FinalizationRegistry = class extends NativeFinalizationRegistry {
  register(target, state, token) {
    states.set(target, state);
    return super.register(target, state, token);
  }
};
let testing;
try {
  testing = await import("../../../dist/testing.js");
} finally { globalThis.FinalizationRegistry = NativeFinalizationRegistry; }
const { createTestRuntimeSession, getTestRuntimeOwnership, getTestRuntimeSemanticOwnership } = testing;
const { completeRuntimeSession } = await import("../../../dist/runtime/runtime.js");
const resetCopyCases = JSON.parse(await readFile(new URL("../../fixtures/python-tensor-oracle.json", import.meta.url), "utf8"))
  .copyCases.filter(fixture => fixture.name.startsWith("reset-view:"));

const fixtures = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist", import.meta.url)));
let distributionUrl;
before(async () => { distributionUrl = await fixtures.start(); });
after(async () => { await fixtures.close(); });

function createSession(forceVariant, options = {}) {
  return createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant, ...options });
}

function plainChain(session, depth, length = 1) {
  const base = session.tensor(new Float32Array(length).fill(1));
  let deep = base;
  const identities = [states.get(base).identity];
  for (let index = 0; index < depth; index++) {
    const next = deep.view([length]);
    if (deep !== base) deep.close();
    deep = next;
    identities.push(states.get(deep).identity);
  }
  return { base, deep, identities };
}

function countTrackingReads(identities) {
  const counters = { reads: 0, writes: 0 };
  const originals = identities.map(identity => [identity, Object.getOwnPropertyDescriptor(identity, "requiresGrad")]);
  for (const [identity, descriptor] of originals) {
    Object.defineProperty(identity, "requiresGrad", {
      configurable: true, enumerable: descriptor.enumerable,
      get() { counters.reads += 1; return descriptor.value; },
      set(value) { counters.writes += 1; descriptor.value = value; },
    });
  }
  return { counters, restore() {
    for (const [identity, descriptor] of originals) Object.defineProperty(identity, "requiresGrad", descriptor);
  } };
}

function assertRetired(session) {
  for (const [key, count] of Object.entries(getTestRuntimeOwnership(session))) assert.equal(count, 0, key);
  for (const [key, count] of Object.entries(getTestRuntimeSemanticOwnership(session))) {
    if (!key.startsWith("collector")) assert.equal(count, 0, key);
  }
}

for (const forceVariant of ["scalar", "simd128"]) {
  for (const length of [1, 8]) for (const tracked of [false, true]) {
    for (const noGrad of [false, true]) for (const promoted of [false, true]) {
      test(`reset-view copy eligibility (${forceVariant}, length=${length}, source=${tracked}, no-grad=${noGrad}, promoted=${promoted})`, async () => {
        const name = `reset-view:length=${length}:source=${tracked ? "True" : "False"}:no-grad=${noGrad ? "True" : "False"}:promoted=${promoted ? "True" : "False"}`;
        const expected = resetCopyCases.find(fixture => fixture.name === name)?.expected;
        assert.notEqual(expected, undefined, "the pinned native case must exist");
        let publications = 0;
        const session = createSession(forceVariant, { beforeCopyPublication() { publications += 1; } });
        try {
          const parameter = session.tensor(new Float32Array(length).fill(2), { requiresGrad: true });
          const input = session.tensor(new Float32Array(length).fill(3), { requiresGrad: true });
          const base = input.mul(input), destination = base.view([length]);
          parameter.grad = base;
          const optimizer = session.sgd([parameter]);
          optimizer.zeroGrad(false); optimizer.close();
          if (promoted) base.copy_(session.tensor(new Float32Array(length).fill(4), { requiresGrad: true }));
          const source = session.tensor(new Float32Array(length).fill(5), { requiresGrad: tracked });
          const mismatch = !noGrad && !promoted ? session.tensor(new Float32Array(length + 1)) : undefined;
          const before = [base.requiresGrad, destination.requiresGrad, [...await destination.toArray()]];
          await completeRuntimeSession(session);
          const state = states.get(destination), root = states.get(base);
          const entry = state.viewHistory, rootEntry = root.viewHistory, epoch = state.historyVersion;
          const version = state.family.version, priorPublications = publications;
          const owners = getTestRuntimeOwnership(session), semanticOwners = getTestRuntimeSemanticOwnership(session);
          let result;
          if (!noGrad && !promoted) {
            assert.throws(() => destination.copy_(source), { code: "INPLACE_GRADIENT" });
            // A mismatched source must still encounter the native guard first.
            assert.throws(() => destination.copy_(mismatch), { code: "INPLACE_GRADIENT" });
            assert.equal(state.viewHistory, entry);
            assert.equal(root.viewHistory, rootEntry);
            assert.equal(state.historyVersion, epoch);
            assert.equal(state.family.version, version);
            assert.equal(publications, priorPublications);
            assert.deepEqual(getTestRuntimeOwnership(session), owners);
            assert.deepEqual(getTestRuntimeSemanticOwnership(session), semanticOwners);
            result = ["RuntimeError"];
          } else {
            const returned = noGrad ? session.noGrad(() => destination.copy_(source)) : destination.copy_(source);
            result = ["ok", returned === destination];
            await completeRuntimeSession(session);
            assert.equal(state.family.version, version + 1);
            assert.equal(publications, priorPublications + 1);
          }
          const actual = [before, result, [...await base.toArray()], [...await destination.toArray()], base.requiresGrad, destination.requiresGrad];
          assert.deepEqual(actual, expected);
        } finally { await session.close(); }
        assertRetired(session);
      });
    }
  }

  for (const operation of ["query", "add", "mul", "sum"]) {
    for (const depth of [1, 32, 512]) for (const calls of [1, 8]) {
      test(`negative tracking bounds repeated ancestry reads (${forceVariant}, ${operation}, D${depth}/C${calls})`, async () => {
        const session = createSession(forceVariant);
        try {
          const { base, deep, identities } = plainChain(session, depth);
          const source = session.tensor([2]);
          session.noGrad(() => base.copy_(source));
          const state = states.get(deep), entry = state.viewHistory, epoch = state.historyVersion;
          const counted = countTrackingReads(identities), counts = [], outputs = [];
          try {
            for (let index = 0; index < calls; index++) {
              const previous = counted.counters.reads;
              if (operation === "query") assert.equal(deep.requiresGrad, false);
              else {
                const output = operation === "sum" ? deep.sum() : deep[operation](source);
                assert.equal(output.requiresGrad, false);
                outputs.push(output);
              }
              counts.push(counted.counters.reads - previous);
            }
          } finally { counted.restore(); }
          assert.equal(counted.counters.writes, 0);
          assert.equal(state.viewHistory, entry);
          assert.equal(state.historyVersion, epoch, "queries/admission must not resolve dirty history");
          assert.deepEqual(counts, [depth + 2, ...new Array(calls - 1).fill(2)], "first proof walks; later checks read own tracking and the live root");
          for (const output of outputs) {
            assert.deepEqual([...await output.toArray()], [operation === "sum" ? 2 : 4]);
            output.close();
          }
          deep.close(); base.close(); source.close();
        } finally { await session.close(); }
        assertRetired(session);
      });
    }
  }

  for (const length of [0, 1, 32]) for (const repetitions of [2, 8]) {
    test(`negative proof survives numeric writes (${forceVariant}, payload${length}/R${repetitions})`, async () => {
      const session = createSession(forceVariant);
      try {
        const { base, deep, identities } = plainChain(session, 32, length);
        const source = session.tensor(new Float32Array(length).fill(2));
        const counts = [];
        for (let index = 0; index < repetitions; index++) {
          session.noGrad(() => base.copy_(source));
          const counted = countTrackingReads(identities);
          try { for (let call = 0; call < 8; call++) assert.equal(deep.requiresGrad, false); }
          finally { counted.restore(); }
          assert.equal(counted.counters.writes, 0);
          counts.push(counted.counters.reads);
        }
        assert.deepEqual(counts, [48, ...new Array(repetitions - 1).fill(16)]);
        assert.deepEqual([...await deep.toArray()], new Array(length).fill(2));
        deep.close(); base.close(); source.close();
      } finally { await session.close(); }
      assertRetired(session);
    });
  }

  test(`tracking fast paths preserve work and history (${forceVariant})`, async () => {
    const session = createSession(forceVariant);
    try {
      const plain = session.tensor([1]), tracked = session.tensor([1], { requiresGrad: true });
      const clean = plain.view([1]), trackedView = tracked.view([1]), source = session.tensor([2]);
      for (const [handle, expected] of [[plain, false], [tracked, true], [clean, false], [trackedView, true]]) {
        const state = states.get(handle), counted = countTrackingReads([state.identity]);
        try { for (let index = 0; index < 8; index++) assert.equal(handle.requiresGrad, expected); }
        finally { counted.restore(); }
        assert.equal(counted.counters.reads, 8);
      }
      session.noGrad(() => plain.copy_(source));
      assert.equal(clean.requiresGrad, false);
      // Resolve by a real ordinary-view write; this clean path stays one read.
      clean.copy_(source);
      const counted = countTrackingReads([states.get(clean).identity]);
      try { for (let index = 0; index < 8; index++) assert.equal(clean.requiresGrad, false); }
      finally { counted.restore(); }
      assert.equal(counted.counters.reads, 8);
      for (const handle of [plain, tracked, clean, trackedView, source]) handle.close();
    } finally { await session.close(); }
    assertRetired(session);
  });

  test(`negative proof observes root promotion and preserves gradients (${forceVariant})`, async () => {
    const session = createSession(forceVariant);
    try {
      const { base, deep } = plainChain(session, 32), source = session.tensor([2]);
      session.noGrad(() => base.copy_(source));
      assert.equal(deep.requiresGrad, false);
      const tracked = session.tensor([3], { requiresGrad: true });
      base.copy_(tracked);
      assert.equal(deep.requiresGrad, true);
      const output = deep.sum(), [gradient] = session.grad(output, [tracked]);
      assert.deepEqual([...await gradient.toArray()], [1]);
      for (const handle of [base, deep, source, tracked, output, gradient]) handle.close();
    } finally { await session.close(); }
    assertRetired(session);
  });

  test(`tracking reads a root changed before numeric commit (${forceVariant})`, async () => {
    const session = createSession(forceVariant);
    try {
      const { base, deep } = plainChain(session, 8), source = session.tensor([2]);
      session.noGrad(() => base.copy_(source));
      assert.equal(deep.requiresGrad, false);
      const identity = states.get(base).identity, version = identity.family.version;
      // Simulate the actual copy metadata prefix; this is not an OOM reproduction.
      identity.requiresGrad = true;
      try {
        assert.equal(identity.family.version, version);
        assert.equal(deep.requiresGrad, true);
      } finally { identity.requiresGrad = false; }
      assert.equal(deep.requiresGrad, false);
      base.close(); deep.close(); source.close();
    } finally { await session.close(); }
    assertRetired(session);
  });

  test(`failed reset deactivates a live root without advancing its epoch (${forceVariant})`, async () => {
    let armed = false;
    const fault = new Error("controlled publication failure");
    const session = createSession(forceVariant, { beforeCopyPublication() { if (armed) throw fault; } });
    let optimizer;
    try {
      const { base, deep } = plainChain(session, 8);
      const source = session.tensor([2]), tracked = session.tensor([3], { requiresGrad: true });
      const parameter = session.tensor([1]), bad = session.tensor([9]);
      session.noGrad(() => base.copy_(source));
      assert.equal(deep.requiresGrad, false);
      base.copy_(tracked);
      await base.toArray();
      assert.equal(deep.requiresGrad, true);
      parameter.grad = base; optimizer = session.sgd([parameter]);
      armed = true;
      session.noGrad(() => bad.copy_(source));
      await assert.rejects(bad.toArray(), error => error.code === "BACKEND_STATUS_ERROR" && error.cause === fault);
      armed = false;
      const state = states.get(base), version = state.family.version;
      assert.throws(() => optimizer.zeroGrad(false), { code: "MUTATION_FAILED" });
      assert.equal(base.requiresGrad, false);
      assert.equal(state.family.version, version);
      assert.equal(deep.requiresGrad, false);
      assert.equal(parameter.grad, base);
      assert.deepEqual([...await base.toArray()], [3]);
      optimizer.close();
      for (const handle of [base, deep, source, tracked, parameter, bad]) handle.close();
    } finally { optimizer?.close(); await session.close(); }
    assertRetired(session);
  });

  test(`a false root does not hide a tracked intermediate or special provenance (${forceVariant})`, async () => {
    const session = createSession(forceVariant);
    let optimizer;
    try {
      const base = session.tensor([1], { requiresGrad: true }), middle = base.view([1]);
      const deep = session.noGrad(() => middle.view([1])), holder = session.tensor([9]);
      holder.grad = deep; optimizer = session.sgd([holder]);
      session.noGrad(() => optimizer.zeroGrad(false));
      assert.equal(states.get(deep).identity.requiresGrad, false);
      holder.grad = base;
      session.noGrad(() => optimizer.zeroGrad(false));
      assert.equal(base.requiresGrad, false);
      assert.equal(middle.requiresGrad, true);
      const state = states.get(deep), epoch = state.historyVersion;
      for (let index = 0; index < 8; index++) assert.equal(deep.requiresGrad, true);
      assert.equal(state.historyVersion, epoch);
      assert.throws(() => deep.add(holder), { code: "INPLACE_VIEW" });
      assert.deepEqual([...await deep.toArray()], [0]);
      optimizer.close();
      for (const handle of [base, middle, deep, holder]) handle.close();
    } finally { optimizer?.close(); await session.close(); }
    assertRetired(session);
  });
}
