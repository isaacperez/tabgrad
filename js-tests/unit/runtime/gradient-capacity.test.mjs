import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";
import { Tensor, RuntimeSession, prepareRuntimeSession } from "../../../dist/runtime/runtime.js";
import { WebAssemblyCpuBackend } from "../../../dist/backends/cpu/cpu-backend.js";
import { WriterOutcomeLedger } from "../../../dist/runtime/writer-outcome.js";
import { createTestRuntimeSession, getTestRuntimeOwnership, getTestTensorVersion } from "../../../dist/testing.js";

const fixtures = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist", import.meta.url)));
const runFile = promisify(execFile);
let distributionUrl;
before(async () => { distributionUrl = await fixtures.start(); });
after(async () => { await fixtures.close(); });

function chain(session, count) {
  const leaves = Array.from({ length: count }, () => session.tensor([2], { requiresGrad: true }));
  let root = leaves[0];
  for (const leaf of leaves.slice(1)) {
    const next = root.add(leaf);
    if (root !== leaves[0]) root.close();
    root = next;
  }
  return { root, leaves };
}

function assertRetired(session) {
  for (const [name, count] of Object.entries(getTestRuntimeOwnership(session))) assert.equal(count, 0, name);
  assert.equal(session.diagnostics().liveAllocationBytes, 0);
}

function replaceDescriptor(object, name, descriptor) {
  const previous = Object.getOwnPropertyDescriptor(object, name);
  Object.defineProperty(object, name, { configurable: true, ...descriptor });
  return () => {
    if (previous === undefined) delete object[name];
    else Object.defineProperty(object, name, previous);
  };
}

function captureOwners(session) {
  let backend, ledger;
  const assertAvailable = WebAssemblyCpuBackend.prototype.assertAvailable;
  const retain = WriterOutcomeLedger.prototype.retain;
  const restoreBackend = replaceDescriptor(WebAssemblyCpuBackend.prototype, "assertAvailable", {
    value: function () { backend = this; return assertAvailable.call(this); },
  });
  const restoreLedger = replaceDescriptor(WriterOutcomeLedger.prototype, "retain", {
    value: function (outcome) { ledger = this; return retain.call(this, outcome); },
  });
  try {
    const source = session.tensor([1]);
    const destination = session.tensor([0]);
    destination.copy_(source);
    source.close(); destination.close();
  } finally { restoreBackend(); restoreLedger(); }
  assert.notEqual(backend, undefined); assert.notEqual(ledger, undefined);
  return { backend, ledger };
}

const dispatchGuards = [
  "add", "mul", "view", "close", "session-noGrad", "session-tensor",
  "own-noGrad", "own-tensor", "tensor-then", "object-then", "proxy-parent",
  "cpu-ready", "cpu-prepare", "cpu-execute", "cpu-release", "cpu-assertAvailable",
  "own-cpu-ready", "own-cpu-prepare", "own-cpu-execute", "own-cpu-release", "own-cpu-assertAvailable",
  "cpu-capabilities", "cpu-synchronousObservation",
  "ledger-create", "ledger-retain", "ledger-release", "own-ledger-create", "own-ledger-retain", "own-ledger-release",
  "formation-hook", "publication-hook", "normalizer-mutation",
];

for (const forceVariant of ["scalar", "simd128"]) {
  for (const kind of dispatchGuards) {
    test(`gradient capacity preserves dispatch fallback (${forceVariant}, ${kind})`, async () => {
      let calls = 0, traps = 0, reads = 0;
      const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant,
        updateLimits: { owners: 965 },
        ...(kind === "formation-hook" ? { onProgramFormed() { calls += 1; } } : {}),
        ...(kind === "publication-hook" ? { beforeCopyPublication() { calls += 1; } } : {}),
      });
      let restore = () => {};
      try {
        const owners = kind.startsWith("own-cpu-") || kind.startsWith("own-ledger-")
          || kind === "cpu-capabilities" || kind === "cpu-synchronousObservation" ? captureOwners(session) : undefined;
        await prepareRuntimeSession(session);
        const { root, leaves } = chain(session, 16);
        calls = 0;
        if (["add", "mul", "view", "close"].includes(kind)) {
          const method = Tensor.prototype[kind];
          restore = replaceDescriptor(Tensor.prototype, kind, { value: function (...args) {
            calls += 1; return Reflect.apply(method, this, args);
          } });
        } else if (kind.startsWith("session-")) {
          const name = kind.slice(8), method = RuntimeSession.prototype[name];
          restore = replaceDescriptor(RuntimeSession.prototype, name, { value: function (...args) {
            calls += 1; return Reflect.apply(method, this, args);
          } });
        } else if (kind === "own-noGrad" || kind === "own-tensor") {
          restore = replaceDescriptor(session, kind.slice(4), { get() { calls += 1; return undefined; } });
        } else if (kind === "tensor-then" || kind === "object-then") {
          restore = replaceDescriptor(kind === "tensor-then" ? Tensor.prototype : Object.prototype,
            "then", { get() { calls += 1; return undefined; } });
        } else if (kind === "proxy-parent") {
          const parent = Object.getPrototypeOf(Tensor.prototype);
          Object.setPrototypeOf(Tensor.prototype, new Proxy(parent, {
            get() { traps += 1; throw Error("unexpected proxy Get"); },
            getOwnPropertyDescriptor() { traps += 1; throw Error("unexpected proxy descriptor"); },
            getPrototypeOf() { traps += 1; throw Error("unexpected proxy parent"); },
          }));
          restore = () => Object.setPrototypeOf(Tensor.prototype, parent);
        } else if (kind.startsWith("cpu-") || kind.startsWith("own-cpu-")) {
          const name = kind.replace(/^(own-)?cpu-/, "");
          const object = kind.startsWith("own-") || ["capabilities", "synchronousObservation"].includes(name)
            ? owners.backend : WebAssemblyCpuBackend.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(object, name)
            ?? Object.getOwnPropertyDescriptor(WebAssemblyCpuBackend.prototype, name);
          restore = replaceDescriptor(object, name, descriptor.get !== undefined || typeof descriptor.value !== "function"
            ? { get() { calls += 1; return descriptor.get?.call(this) ?? descriptor.value; } }
            : { value: function (...args) { calls += 1; return Reflect.apply(descriptor.value, this, args); } });
        } else if (kind.startsWith("ledger-") || kind.startsWith("own-ledger-")) {
          const name = kind.replace(/^(own-)?ledger-/, "");
          const method = WriterOutcomeLedger.prototype[name];
          restore = replaceDescriptor(kind.startsWith("own-") ? owners.ledger : WriterOutcomeLedger.prototype,
            name, { value: function (...args) { calls += 1; return Reflect.apply(method, this, args); } });
        }
        let options;
        if (kind === "normalizer-mutation") {
          const inputs = leaves.slice();
          Object.defineProperty(inputs, 0, { get() {
            reads += 1;
            restore = replaceDescriptor(Tensor.prototype, "view", { value() { calls += 1; } });
            return leaves[0];
          } });
          options = { inputs };
        }
        const before = getTestRuntimeOwnership(session);
        assert.throws(() => root.backward(undefined, options), error => {
          assert.equal(error.code, "RESOURCE_EXHAUSTED");
          assert.equal(error.details.additionalOwners, 13430, "same original reservation");
          assert.equal(error.details.owners, 111);
          return true;
        });
        assert.equal(calls, kind.endsWith("assertAvailable") || kind === "cpu-capabilities" ? 1 : 0);
        assert.equal(traps, 0); assert.equal(reads, kind === "normalizer-mutation" ? 1 : 0);
        assert.deepEqual(getTestRuntimeOwnership(session), before);
        assert.ok(leaves.every(leaf => leaf.grad === null));
        restore(); restore = () => {};
        if (!kind.endsWith("-hook")) {
          root.backward(); // Rejection did not consume history or publish gradients.
          assert.deepEqual([...await leaves[0].grad.toArray()], [1]);
        }
      } finally { restore(); await session.close(); }
      assertRetired(session);
    });
  }
}

for (const forceVariant of ["scalar", "simd128"]) {
  for (const count of [36, 128]) {
    for (const explicit of [false, true]) {
      test(`rescued saved-version failure preserves partial progress (${forceVariant}, leaves=${count}, explicit=${explicit})`, async () => {
        const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
        try {
          await prepareRuntimeSession(session);
          const leaves = Array.from({ length: count }, () => session.tensor([2], { requiresGrad: true }));
          const bad = leaves[0].mul(leaves[0]);
          let good = leaves[1].mul(leaves[1]);
          for (const leaf of leaves.slice(2)) { const next = good.add(leaf); good.close(); good = next; }
          const root = bad.add(good); bad.close(); good.close();
          const replacement = session.tensor([7]);
          session.noGrad(() => leaves[0].copy_(replacement)); replacement.close();
          const seed = explicit ? session.tensor([2]) : undefined, scale = explicit ? 2 : 1;
          assert.throws(() => root.backward(seed), { code: "SAVED_VERSION_MISMATCH" });
          assert.equal(leaves[0].grad, null);
          const gradients = leaves.slice(1).map(leaf => leaf.grad);
          for (const [index, gradient] of gradients.entries()) {
            assert.equal(leaves[index + 1].grad, gradient);
            assert.deepEqual([...await gradient.toArray()], [(index === 0 ? 4 : 1) * scale]);
            assert.equal(getTestTensorVersion(gradient), 1);
          }
          assert.throws(() => root.backward(seed), { code: "CONSUMED_HISTORY" });
          for (const [index, gradient] of gradients.entries()) {
            assert.equal(leaves[index + 1].grad, gradient);
            assert.deepEqual([...await gradient.toArray()], [(index === 0 ? 4 : 2) * scale]);
            assert.equal(getTestTensorVersion(gradient), index === 0 ? 1 : 2);
          }
          assert.equal(leaves[0].grad, null);
          if (seed !== undefined) assert.deepEqual([...await seed.toArray()], [2]);
        } finally { await session.close(); }
        assertRetired(session);
      });
    }
  }

  for (const prepared of [false, true]) {
    for (const explicit of [false, true]) {
      test(`rescued functional gradients preserve retained replacements (${forceVariant}, prepared=${prepared}, explicit=${explicit})`, async () => {
        const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
        try {
          if (prepared) await prepareRuntimeSession(session);
          const leaves = Array.from({ length: 128 }, () => session.tensor([2], { requiresGrad: true })), retained = [];
          let root = leaves[0];
          for (const leaf of leaves.slice(1)) { root = root.add(leaf); retained.push(root); }
          const plain = session.tensor([0]);
          assert.throws(() => root.backward(undefined, { inputs: [...retained, plain] }), { code: "GRADIENT_NOT_TRACKED" });
          plain.close();
          const seed = explicit ? session.tensor([2]) : undefined, scale = explicit ? 2 : 1;
          const fetches = [...fixtures.requestCounts];
          const first = session.grad(root, leaves, seed);
          assert.deepEqual([...fixtures.requestCounts], fetches);
          assert.ok(leaves.every(leaf => leaf.grad === null));
          const old = retained.map(value => value.grad);
          for (const gradient of [...first, ...old]) {
            assert.deepEqual([...await gradient.toArray()], [scale]);
            assert.equal(getTestTensorVersion(gradient), 0);
          }
          await prepareRuntimeSession(session); // The next plan has prior gradients and needs prepared CPU.
          const second = session.grad(root, leaves, seed);
          assert.ok(leaves.every(leaf => leaf.grad === null));
          for (const gradient of second) assert.deepEqual([...await gradient.toArray()], [scale]);
          for (const [index, value] of retained.entries()) {
            assert.notEqual(value.grad, old[index]);
            assert.equal(value.grad, value.grad);
            assert.equal(getTestTensorVersion(value.grad), 0);
            assert.deepEqual([...await value.grad.toArray()], [2 * scale]);
            assert.deepEqual([...await old[index].toArray()], [scale]);
          }
          if (seed !== undefined) assert.deepEqual([...await seed.toArray()], [2]);
        } finally { await session.close(); }
        assertRetired(session);
      });
    }
  }

  test(`reentrant backward keeps conservative admission and callback order (${forceVariant})`, async () => {
    let root, leaves, calls = 0;
    const events = [];
    const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant,
      onProgramFormed() {
        calls += 1; events.push("formation");
        assert.throws(() => root.backward(), error => error.code === "RESOURCE_EXHAUSTED"
          && error.details.additionalOwners === 66230);
        assert.ok(leaves.every(leaf => leaf.grad === null));
        events.push("rejected");
      },
    });
    try {
      await prepareRuntimeSession(session);
      ({ root, leaves } = chain(session, 36));
      const base = session.tensor([1]), outer = base.add(base);
      assert.deepEqual([...await outer.toArray()], [2]);
      assert.equal(calls, 1); assert.deepEqual(events, ["formation", "rejected"]);
      const gradients = session.grad(root, leaves);
      assert.equal(calls, 1, "functional construction admits no observation request");
      for (const gradient of gradients) { assert.deepEqual([...await gradient.toArray()], [1]); gradient.close(); }
      assert.equal(calls, 37, "each explicit observation forms its own program and reentry still rejects");
    } finally { await session.close(); }
    assertRetired(session);
  });

  test(`already-admitted differentiation does not inspect dispatch (${forceVariant})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
    const original = Object.getOwnPropertyDescriptor;
    let inspections = 0;
    try {
      const { root } = chain(session, 16);
      // Observational counter for the eligibility inspection, not a supported
      // replacement of global intrinsics. Execution itself is unchanged.
      Object.getOwnPropertyDescriptor = function (object, name) {
        if ([Tensor.prototype, RuntimeSession.prototype, WebAssemblyCpuBackend.prototype,
          WriterOutcomeLedger.prototype].includes(object)) inspections += 1;
        return original(object, name);
      };
      try { root.backward(); }
      finally { Object.getOwnPropertyDescriptor = original; }
      assert.equal(inspections, 0);
    } finally { Object.getOwnPropertyDescriptor = original; await session.close(); }
    assertRetired(session);
  });

  for (const observed of [false, true]) {
    test(`rescued functional admission preserves old failed controls (${forceVariant}, delivered=${observed})`, async () => {
      const manifestUrl = fixtures.installFixture(`gradient-capacity-failure-${forceVariant}-${observed}`, { kernelBehavior: "trap" });
      const session = createTestRuntimeSession({ manifestUrl, forceVariant });
      let cause;
      try {
        await prepareRuntimeSession(session);
        const leaves = Array.from({ length: 128 }, () => session.tensor([2], { requiresGrad: true }));
        const source = leaves[0].add(leaves[0]);
        session.noGrad(() => leaves[0].copy_(source));
        source.close();
        assert.equal(getTestRuntimeOwnership(session).pendingCopies, 0);
        assert.equal(getTestRuntimeOwnership(session).undeliveredEffects, 1);
        if (observed) await assert.rejects(leaves[0].toArray(), { code: "BACKEND_TRAP" });
        const retained = [];
        let root = leaves[0];
        for (const leaf of leaves.slice(1)) { root = root.add(leaf); retained.push(root); }
        const plain = session.tensor([0]);
        assert.throws(() => root.backward(undefined, { inputs: [...retained, plain] }), { code: "GRADIENT_NOT_TRACKED" });
        plain.close();
        assert.throws(() => session.grad(root, leaves), error => {
          assert.equal(error.code, "MUTATION_FAILED");
          assert.equal(error.cause.code, "BACKEND_TRAP");
          cause = error.cause;
          return true;
        });
        assert.ok(leaves.every(leaf => leaf.grad === null));
        assert.ok(retained.every(value => value.grad === null));
        assert.equal(getTestRuntimeOwnership(session).undeliveredEffects, observed ? 0 : 1);
      } finally {
        if (observed || cause === undefined) await session.close();
        else await assert.rejects(session.close(), error => error === cause);
      }
      assertRetired(session);
    });
  }

  for (const limit of ["owners", "backingBytes", "pendingCopies"]) {
    test(`gradient reservation keeps the independent ${limit} limit (${forceVariant})`, async () => {
      const updateLimits = { owners: 965, ...(limit === "owners" ? { owners: 964 }
        : limit === "backingBytes" ? { backingBytes: 747 } : { pendingCopies: 15 }) };
      const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant, updateLimits });
      try {
        const { root, leaves } = chain(session, 16);
        const before = getTestRuntimeOwnership(session);
        assert.throws(() => root.backward(), error => {
          assert.equal(error.code, "RESOURCE_EXHAUSTED");
          if (limit === "pendingCopies") assert.equal(error.message, "Differentiation exceeds pending-effect capacity.");
          else {
            assert.equal(error.details.additionalOwners, 13430);
            assert.equal(error.details.additionalBytes, 624);
            assert.equal(error.details.backingBytes, 124);
          }
          return true;
        });
        assert.deepEqual(getTestRuntimeOwnership(session), before);
        assert.ok(leaves.every(leaf => leaf.grad === null));
        const gradients = session.grad(root, leaves);
        for (const gradient of gradients) { assert.deepEqual([...await gradient.toArray()], [1]); gradient.close(); }
        assert.ok(leaves.every(leaf => leaf.grad === null));
      } finally { await session.close(); }
      assertRetired(session);
    });
  }

  for (const kind of ["view", "host-copy", "host-overwrite", "host-copy-slices", "explicit-host-view",
    "explicit-lazy", "combine", "mul", "sum", "prior", "queued-copy"]) {
    test(`cold gradient plan eligibility (${forceVariant}, ${kind})`, async () => {
      const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant,
        updateLimits: { owners: 4000 } });
      try {
        const leaves = Array.from({ length: 16 }, () => session.tensor([2], { requiresGrad: true }));
        let root = leaves[0], seed, first = 1;
        if (kind.startsWith("host-")) {
          const destination = session.tensor([0]);
          destination.copy_(leaves[0]);
          root = destination;
          if (kind === "host-overwrite") { destination.copy_(leaves[1]); first = 2; }
          if (kind === "host-copy-slices") {
            const view = destination.view([1]); view.copy_(leaves[1]); view.close(); first = 2;
          }
        }
        for (const leaf of leaves.slice(first)) {
          const next = root.add(leaf);
          if (root !== leaves[0]) root.close();
          root = next;
        }
        if (kind === "view") { const view = root.view([1]); root.close(); root = view; }
        if (kind === "explicit-host-view") { const base = session.tensor([1]); seed = base.view([1]); base.close(); }
        if (kind === "explicit-lazy") { const base = session.tensor([1]); seed = base.add(base); base.close(); }
        if (kind === "combine") { const next = root.add(leaves[0]); root.close(); root = next; }
        if (kind === "mul") { const factor = session.tensor([1]), next = root.mul(factor); factor.close(); root.close(); root = next; }
        if (kind === "sum") { const next = root.sum(); root.close(); root = next; }
        if (kind === "prior") { const prior = session.tensor([5]); leaves[0].grad = prior; prior.close(); }
        if (kind === "queued-copy") { const destination = session.tensor([0]); destination.copy_(root); root.close(); root = destination; }
        const accepted = ["view", "host-copy", "host-overwrite", "host-copy-slices", "explicit-host-view"].includes(kind);
        const before = getTestRuntimeOwnership(session), fetches = [...fixtures.requestCounts];
        if (accepted) {
          root.backward(seed);
          assert.deepEqual([...fixtures.requestCounts], fetches);
          for (const [index, leaf] of leaves.entries()) {
            assert.deepEqual([...await leaf.grad.toArray()],
              [(kind === "host-overwrite" || kind === "host-copy-slices") && index === 0 ? 0 : 1]);
          }
        } else {
          assert.throws(() => root.backward(seed), { code: "RESOURCE_EXHAUSTED" });
          assert.deepEqual(getTestRuntimeOwnership(session), before);
          assert.deepEqual([...fixtures.requestCounts], fetches);
          assert.ok(leaves.slice(kind === "prior" ? 1 : 0).every(leaf => leaf.grad === null));
        }
      } finally { await session.close(); }
      assertRetired(session);
    });
  }

  for (const kind of ["cpu", "ledger"]) {
    test(`pre-import gradient dispatch override (${forceVariant}, ${kind})`, async () => {
      const { stdout } = await runFile(process.execPath, [
        fileURLToPath(new URL("../../fixtures/gradient-capacity-child.mjs", import.meta.url)),
        new URL("manifest.json", distributionUrl).href, forceVariant, kind,
      ]);
      assert.equal(stdout, "pre-import fallback passed\n");
    });
  }

  for (const depth of [1, 4, 8, 16, 32]) {
    test(`already-admitted backward preserves mutable view dispatch (${forceVariant}, depth=${depth})`, async () => {
      const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
      const original = Tensor.prototype.view;
      try {
        const input = session.tensor([2], { requiresGrad: true }), views = [];
        let root = input;
        for (let index = 0; index < depth; index += 1) { root = root.view([1]); views.push(root); }
        const base = session.tensor([1]), seed = base.add(base);
        let calls = 0;
        Tensor.prototype.view = function (shape) {
          const gradient = views[depth - 1 - calls++].grad;
          assert.notEqual(gradient, null);
          try { return original.call(gradient, shape); }
          finally { gradient.close(); }
        };
        try { root.backward(seed, { inputs: [input, ...views] }); }
        finally { Tensor.prototype.view = original; }
        assert.equal(calls, depth);
        for (const owner of [input, ...views]) {
          assert.deepEqual([...await owner.grad.toArray()], [2]);
          assert.equal(getTestTensorVersion(owner.grad), 0, "the incoming lazy seed is acquired without a copy");
        }
      } finally { Tensor.prototype.view = original; await session.close(); }
      assertRetired(session);
    });
  }

  for (const prepared of [false, true]) {
    for (const count of [36, 128, 512]) {
      for (const explicit of [false, true]) {
        test(`bounded gradient admission (${forceVariant}, prepared=${prepared}, leaves=${count}, explicit=${explicit})`, async () => {
          const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
          try {
            if (prepared) await prepareRuntimeSession(session);
            const { root, leaves } = chain(session, count);
            const seed = explicit ? session.tensor([2]) : undefined;
            const fetches = [...fixtures.requestCounts];
            root.backward(seed, { inputs: leaves });
            assert.deepEqual([...fixtures.requestCounts], fetches, "admission must not prepare a cold host-only plan");
            for (const leaf of leaves) {
              const gradient = leaf.grad;
              assert.equal(leaf.grad, gradient, "gradient identity remains stable");
              assert.equal(getTestTensorVersion(gradient), 1);
              assert.deepEqual([...await gradient.toArray()], [explicit ? 2 : 1]);
            }
            if (seed !== undefined) assert.deepEqual([...await seed.toArray()], [2]);
          } finally { await session.close(); }
          assertRetired(session);
        });
      }
    }
  }
}
