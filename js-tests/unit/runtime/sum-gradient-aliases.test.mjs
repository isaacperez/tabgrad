import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";
import { createTestRuntimeSession, getTestRuntimeOwnership, getTestTensorVersion, getTestTensorReachability, getTestRuntimeSemanticOwnership } from "../../../dist/testing.js";
import { completeRuntimeSession } from "../../../dist/runtime/runtime.js";
import { ExecutionTicket } from "../../../dist/execution/execution-ticket.js";
import { WebAssemblyCpuBackend } from "../../../dist/backends/cpu/cpu-backend.js";

const fixtures = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist", import.meta.url)));
let distributionUrl;
before(async () => { distributionUrl = await fixtures.start(); });
after(async () => { await fixtures.close(); });

function assertRetired(session) {
  for (const [name, value] of Object.entries(getTestRuntimeOwnership(session))) assert.equal(value, 0, name);
  assert.equal(session.diagnostics().liveTensorValues, 0);
  assert.equal(session.diagnostics().liveAllocationBytes, 0);
}

function hasCause(error, cause) {
  return error === cause || (error?.cause !== undefined && hasCause(error.cause, cause))
    || (error instanceof AggregateError && error.errors.some(value => hasCause(value, cause)));
}

function sumGradient(session, seed, shape) {
  const input = session.tensor(new Float32Array(shape.reduce((n, size) => n * size, 1)), { shape, requiresGrad: true });
  const output = input.sum();
  try { return session.grad(output, [input], seed)[0]; }
  finally { output.close(); input.close(); }
}

for (const forceVariant of ["scalar", "simd128"]) {
  for (const shape of [[], [1], [1, 1], [0], [0, 2], [1, 0, 2], [2], [65]]) {
    test(`sum aliases preserve immutable captures and shared versions (${forceVariant}, ${shape})`, async () => {
      const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
      try {
        const seed = session.tensor([3], { shape: [] }), gradient = sumGradient(session, seed, shape);
        const count = shape.reduce((n, size) => n * size, 1);
        const captured = gradient.mul(gradient), next = session.tensor([4], { shape: [] });
        session.noGrad(() => seed.copy_(next));
        assert.equal(getTestTensorVersion(gradient), 1);
        assert.deepEqual([...await captured.toArray()], Array(count).fill(9));
        assert.deepEqual([...await gradient.toArray()], Array(count).fill(4));
        const replacement = session.tensor(new Float32Array(count).fill(5), { shape });
        if (count > 1) assert.throws(() => gradient.copy_(replacement), { code: "OVERLAPPING_COPY" });
        else {
          gradient.copy_(replacement);
          assert.equal(getTestTensorVersion(seed), 2);
          assert.deepEqual([...await seed.toArray()], [count === 0 ? 4 : 5]);
        }
        session.noGrad(() => gradient.copy_(gradient));
        assert.equal(getTestTensorVersion(seed), count > 1 ? 2 : 3);
        for (const value of [gradient, captured, seed, next, replacement]) value.close();
        await completeRuntimeSession(session);
        assertRetired(session);
      } finally { await session.close(); }
    });
  }

  for (const holderKind of ["view", "association", "empty"]) {
    test(`sum expansion remains owned only by live projections (${forceVariant}, ${holderKind})`, async () => {
      const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
      try {
        const seed = session.tensor([3], { shape: [] }), gradient = sumGradient(session, seed, [65]);
        await gradient.toArray();
        const firstKernels = session.diagnostics().kernelCalls;
        await gradient.toArray();
        assert.equal(session.diagnostics().kernelCalls, firstKernels, "a repeated observation reuses its expansion");
        let holder;
        if (holderKind === "view") holder = gradient.view([1, 65]);
        else if (holderKind === "association") { holder = session.tensor(new Float32Array(65)); holder.grad = gradient; }
        else {
          holder = sumGradient(session, seed, [0, 2]);
          const larger = sumGradient(session, seed, [257]);
          await larger.toArray(); larger.close();
        }
        gradient.close();
        assert.equal(session.diagnostics().liveAllocationBytes, holderKind === "empty" ? 1032 : 264);
        if (holderKind === "association") holder.grad = null;
        holder.close();
        assert.equal(session.diagnostics().liveTensorValues, 1);
        assert.equal(session.diagnostics().liveAllocationBytes, 4);
        assert.deepEqual([...await seed.toArray()], [3]);
        seed.close(); await completeRuntimeSession(session); assertRetired(session);
      } finally { await session.close(); }
    });
  }

  for (const phase of ["replacement", "write", "retirement"]) for (const effect of ["before", "after"]) {
    test(`sum cache ${phase} preserves failures ${effect} physical cleanup (${forceVariant})`, async (context) => {
      const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
      const owned = [], own = value => { owned.push(value); return value; };
      const seed = own(session.tensor([3], { shape: [] })), gradient = own(sumGradient(session, seed, [2]));
      const larger = own(sumGradient(session, seed, [65]));
      await gradient.toArray();
      const cause = new Error("controlled projection cache retirement failure");
      const release = WebAssemblyCpuBackend.prototype.release;
      let armed = true;
      const mock = context.mock.method(WebAssemblyCpuBackend.prototype, "release", function (...args) {
        if (armed) { armed = false; if (effect === "after") release.apply(this, args); throw cause; }
        return release.apply(this, args);
      });
      try {
        if (phase === "replacement") {
          const captured = own(larger.add(larger)); // Capturing must not evict or call the backend.
          await assert.rejects(captured.toArray(), error => hasCause(error, cause));
        } else if (phase === "write") {
          const next = own(session.tensor([4], { shape: [] }));
          assert.throws(() => seed.copy_(next), error => hasCause(error, cause));
          assert.equal(getTestTensorVersion(seed), 1, "a committed write cannot be rolled back by cache cleanup");
        } else {
          larger.close();
          assert.throws(() => gradient.close(), error => hasCause(error, cause));
          gradient.close();
        }
      } finally { armed = false; mock.mock.restore(); }
      assert.deepEqual([...await seed.toArray()], [phase === "write" ? 4 : 3]);
      for (const value of owned.reverse()) value.close();
      await session.close(); assertRetired(session);
    });
  }

  test(`an old sum capture does not retain the latest replacement graph (${forceVariant})`, async () => {
    const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant });
    try {
      const seed = session.tensor([3], { shape: [] }), gradient = sumGradient(session, seed, [65]);
      const captured = gradient.add(gradient);
      let source = session.tensor([4], { shape: [] });
      for (let depth = 0; depth < 32; depth++) {
        const next = source.add(source); source.close(); source = next;
      }
      seed.copy_(source); source.close(); gradient.close(); seed.close();
      const reachable = getTestTensorReachability(captured);
      assert.ok(reachable.values <= 4, JSON.stringify(reachable));
      assert.deepEqual([...await captured.toArray()], Array(65).fill(6));
      captured.close(); await completeRuntimeSession(session); assertRetired(session);
    } finally { await session.close(); }
  });
}

function ownerCount(session) {
  const semantic = getTestRuntimeSemanticOwnership(session), numerical = getTestRuntimeOwnership(session);
  return semantic.identityReferences + numerical.valueReferences + numerical.derivativeReferences
    + numerical.controlReferences + session.diagnostics().liveRequestLeases + numerical.undeliveredEffects
    + semantic.optimizerRegistrations + semantic.optimizerCaptureScopes;
}

for (const length of [0, 65]) {
  test(`a later capture remains valid when the optional expansion pin is denied (${length})`, async (context) => {
    const fillers = [];
    let fill = false, begin, finish;
    const started = new Promise(resolve => { begin = resolve; });
    const gate = new Promise(resolve => { finish = resolve; });
    const session = createTestRuntimeSession({
      manifestUrl: new URL("manifest.json", distributionUrl), forceVariant: "scalar",
      updateLimits: { owners: 512 },
      onProgramFormed() {
        if (!fill) return;
        while (ownerCount(session) + 2 <= 512) fillers.push(session.tensor([]));
        if (ownerCount(session) === 511) fillers.at(-1).grad = fillers[0];
        assert.equal(ownerCount(session), 512, "ordinary owner budget denies the optional pin");
      },
    });
    const execute = WebAssemblyCpuBackend.prototype.execute;
    let first = true;
    const mock = context.mock.method(WebAssemblyCpuBackend.prototype, "execute", function (...args) {
      if (!first) return execute.apply(this, args);
      first = false; begin();
      return new ExecutionTicket(gate.then(() => execute.apply(this, args)), gate);
    });
    const owned = [];
    try {
      const seed = session.tensor([3], { shape: [] }), gradient = sumGradient(session, seed, [length]);
      const factor = session.tensor(new Float32Array(length).fill(2)), early = gradient.mul(factor);
      owned.push(seed, gradient, factor, early);
      fill = true;
      const pending = early.toArray();
      await started;
      fill = false;
      for (const filler of fillers) filler.close();
      const late = gradient.mul(factor); owned.push(late);
      finish();
      assert.deepEqual([...await pending], Array(length).fill(6));
      assert.deepEqual([...await late.toArray()], Array(length).fill(6));
      gradient.close();
      const recreated = sumGradient(session, seed, [length]); owned.push(recreated);
      assert.deepEqual([...await recreated.toArray()], Array(length).fill(3));
    } finally {
      fill = false; finish(); mock.mock.restore();
      for (const filler of fillers) filler.close();
      for (const value of owned.reverse()) value.close();
      await session.close();
    }
    assertRetired(session);
  });
}

test("closed scalar projection metadata is collected while its session stays alive", async () => {
  const child = fileURLToPath(new URL("../../fixtures/sum-gradient-collection-child.mjs", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, ["--expose-gc", child], { timeout: 30_000 });
  assert.deepEqual(JSON.parse(stdout), [0, 65].flatMap(length => [1, 16].map(occurrences => ({ length, occurrences, remaining: 0 }))));
});

test("a retired projection cannot give a new identity its pending scratch origin", async (context) => {
  let begin, finish;
  const started = new Promise(resolve => { begin = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant: "scalar" });
  const execute = WebAssemblyCpuBackend.prototype.execute;
  let first = true;
  const mock = context.mock.method(WebAssemblyCpuBackend.prototype, "execute", function (...args) {
    if (!first) return execute.apply(this, args);
    first = false; begin();
    return new ExecutionTicket(gate.then(() => execute.apply(this, args)), gate);
  });
  const owned = [];
  try {
    const seed = session.tensor([3], { shape: [] }), gradient = sumGradient(session, seed, [65]);
    const parameter = session.tensor(new Float32Array(65).fill(2)), early = gradient.mul(parameter);
    owned.push(seed, gradient, parameter, early);
    gradient.close(); // No live projection or optional cache at the first admission.
    const pending = early.toArray();
    await started;
    const recreated = sumGradient(session, seed, [65]), late = recreated.mul(parameter);
    owned.push(recreated, late);
    finish();
    assert.deepEqual([...await pending], Array(65).fill(6));
    assert.deepEqual([...await late.toArray()], Array(65).fill(6));
  } finally {
    finish(); mock.mock.restore();
    for (const value of owned.reverse()) value.close();
    await session.close();
  }
  assertRetired(session);
});

test("active view guards precede overlap, which precedes equal-shape rejection", async () => {
  const session = createTestRuntimeSession({ manifestUrl: new URL("manifest.json", distributionUrl), forceVariant: "scalar" });
  try {
    const seed = session.tensor([3], { shape: [] }), gradient = sumGradient(session, seed, [65]);
    const wrong = session.tensor([0, 0, 0]), tracked = session.tensor([0, 0, 0], { requiresGrad: true });
    const before = getTestRuntimeOwnership(session);
    assert.throws(() => gradient.copy_(tracked), { code: "INPLACE_VIEW" });
    assert.throws(() => gradient.copy_(wrong), { code: "OVERLAPPING_COPY" });
    assert.deepEqual(getTestRuntimeOwnership(session), before);
    assert.equal(getTestTensorVersion(seed), 0);
    const alias = gradient.view([65]);
    session.noGrad(() => gradient.copy_(alias));
    assert.equal(getTestTensorVersion(seed), 1);
    for (const value of [alias, tracked, wrong, gradient, seed]) value.close();
    await completeRuntimeSession(session); assertRetired(session);
  } finally { await session.close(); }
});
