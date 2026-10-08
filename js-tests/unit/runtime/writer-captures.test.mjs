import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";
import { ExecutionTicket } from "../../../dist/execution/execution-ticket.js";
import { WebAssemblyCpuBackend } from "../../../dist/backends/cpu/cpu-backend.js";
import { WriterOutcomeLedger } from "../../../dist/runtime/writer-outcome.js";
import { createTestRuntimeSession, getTestRuntimeOwnership, getTestTensorVersion } from "../../../dist/testing.js";

const fixtures = new RuntimeFixtureServer(fileURLToPath(new URL("../../../dist", import.meta.url)));
let distributionUrl;
before(async () => { distributionUrl = await fixtures.start(); });
after(async () => { await fixtures.close(); });

async function gatedManifest(name) {
  let release;
  fixtures.virtualResponses.set(`/${name}.json`, {
    body: await readFile(new URL("../../../dist/manifest.json", import.meta.url)),
    contentType: "application/json",
    waitFor: new Promise(resolve => { release = resolve; }),
  });
  return { manifestUrl: new URL(`${name}.json`, distributionUrl), release };
}

function copiedAggregate(session, count) {
  const base = session.tensor([1], { shape: [] });
  let aggregate, last;
  for (let index = 0; index < count; index += 1) {
    const destination = session.tensor([0], { shape: [] });
    const source = base.add(base);
    session.noGrad(() => destination.copy_(source));
    source.close();
    if (aggregate === undefined) aggregate = destination;
    else {
      const next = aggregate.add(destination);
      aggregate.close();
      if (last !== aggregate) last.close();
      aggregate = next;
    }
    last = destination;
  }
  return { aggregate, last };
}

function causedBy(error, cause) {
  return error === cause || (error?.cause !== undefined && causedBy(error.cause, cause));
}

function assertRetired(session) {
  for (const [name, count] of Object.entries(getTestRuntimeOwnership(session))) assert.equal(count, 0, name);
  assert.equal(session.diagnostics().liveAllocationBytes, 0);
}

for (const forceVariant of ["scalar", "simd128"]) {
  test(`completed writer captures stay within admitted backward capacity (${forceVariant})`, async () => {
    const gate = await gatedManifest(`completed-captures-${forceVariant}`);
    const session = createTestRuntimeSession({ ...gate, forceVariant, updateLimits: { owners: 12728 } });
    try {
      const { aggregate, last } = copiedAggregate(session, 128);
      gate.release();
      await last.toArray();
      const prior = aggregate.view([]);
      const input = session.tensor([2], { shape: [], requiresGrad: true });
      input.grad = prior;
      const padding = Array.from({ length: 2000 }, () => session.tensor([]));
      assert.equal(padding.length, 2000);
      const version = getTestTensorVersion(prior);
      input.backward();
      assert.equal(input.grad, prior);
      assert.equal(getTestTensorVersion(prior), version + 1);
      assert.deepEqual([...await prior.toArray()], [257]);
      assert.deepEqual([...await aggregate.toArray()], [257]);
    } finally {
      gate.release();
      await session.close();
    }
    assertRetired(session);
  });

  for (const count of [1, 8, 128]) {
    test(`completed prior-gradient alias preserves explicit seed (${forceVariant}, writers=${count})`, async () => {
      const gate = await gatedManifest(`explicit-captures-${forceVariant}-${count}`);
      const session = createTestRuntimeSession({ ...gate, forceVariant });
      try {
        const { aggregate, last } = copiedAggregate(session, count);
        gate.release();
        await last.toArray();
        const prior = aggregate.view([]);
        const input = session.tensor([2], { shape: [], requiresGrad: true });
        input.grad = prior;
        const seed = session.tensor([2], { shape: [] });
        // Pinned native observations: a single copied prior starts at version
        // one; an addition aggregate starts at zero. Backward increments once.
        assert.equal(getTestTensorVersion(prior), count === 1 ? 1 : 0);
        input.backward(seed);
        assert.equal(input.grad, prior);
        assert.equal(getTestTensorVersion(prior), count === 1 ? 2 : 1);
        assert.deepEqual([...await prior.toArray()], [count * 2 + 2]);
        assert.deepEqual([...await aggregate.toArray()], [count * 2 + 2]);
        assert.deepEqual([...await seed.toArray()], [2]);
      } finally {
        gate.release();
        await session.close();
      }
      assertRetired(session);
    });
  }

  for (const owned of [false, true]) {
    for (const fail of [false, true]) {
      test(`mixed writer captures preserve ${owned ? "owned" : "new"} snapshots (${forceVariant}, failure=${fail})`, async () => {
        const gate = await gatedManifest(`mixed-captures-${forceVariant}-${owned}-${fail}`);
        const execute = WebAssemblyCpuBackend.prototype.execute;
        const retain = WriterOutcomeLedger.prototype.retain;
        const fault = new Error("controlled second publication failure");
        let releaseWriter, reachedWriter;
        const writerGate = new Promise(resolve => { releaseWriter = resolve; });
        const writerReached = new Promise(resolve => { reachedWriter = resolve; });
        let executions = 0, publications = 0, completedRetains = 0;
        const session = createTestRuntimeSession({ ...gate, forceVariant,
          beforeCopyPublication() { if (++publications === 2 && fail) throw fault; },
        });
        WebAssemblyCpuBackend.prototype.execute = function (...arguments_) {
          const result = execute.apply(this, arguments_);
          if (++executions !== 2) return result;
          reachedWriter();
          return new ExecutionTicket(writerGate.then(() => result), writerGate);
        };
        try {
          const { aggregate } = copiedAggregate(session, 2);
          const view = aggregate.view([]);
          const one = session.tensor([1], { shape: [] });
          const held = [];
          if (owned) {
            held.push(view.add(one));
            const before = getTestRuntimeOwnership(session).controlReferences;
            held.push(view.add(one));
            assert.equal(getTestRuntimeOwnership(session).controlReferences - before, 2,
              "pending-only view snapshot is shared; only the new result captures both writers");
          }
          gate.release();
          await writerReached;
          assert.equal(publications, 1);
          WriterOutcomeLedger.prototype.retain = function (outcome) {
            if (outcome.state.kind === "success") completedRetains += 1;
            retain.call(this, outcome);
          };
          const before = getTestRuntimeOwnership(session).controlReferences;
          const result = view.add(one);
          assert.equal(completedRetains, 0, "new numerical ownership must omit completed controls");
          if (owned) assert.equal(getTestRuntimeOwnership(session).controlReferences - before, 1,
            "an owned mixed snapshot keeps its paired capture until release");
          releaseWriter();
          if (fail) {
            await assert.rejects(result.toArray(), error => causedBy(error, fault));
            assert.equal(getTestRuntimeOwnership(session).undeliveredEffects, 0);
            await assert.rejects(view.toArray(), error => causedBy(error, fault),
              "a delivered failure remains part of subsequent captures");
          } else {
            assert.deepEqual([...await result.toArray()], [5]);
            assert.deepEqual([...await view.toArray()], [4]);
          }
          for (const handle of held) handle.close();
          await session.close();
          assertRetired(session);
        } finally {
          gate.release();
          releaseWriter();
          WriterOutcomeLedger.prototype.retain = retain;
          WebAssemblyCpuBackend.prototype.execute = execute;
          await session.close().catch(() => undefined);
        }
      });
    }
  }
}
