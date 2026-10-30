import assert from "node:assert/strict";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { humanPublicationFixture } from "../../fixtures/publication-human.mjs";
import { publicationNamespaceService } from "../../fixtures/publication-namespace.mjs";
import { runHumanPublisher } from "../../../scripts/publication-human.mjs";

async function trace(f) { return (await readFile(join(f.root, "trace.txt"), "utf8")).trim().split("\n"); }

test("actual parent/child: namespace finishes before nonce-bound approval and one simulated call", async t => {
  const f = await humanPublicationFixture(t); let approved = 0;
  const result = await runHumanPublisher({ ...f, fresh: async () => {}, authorizeReady: async ({ nonce, signal }) => {
    assert.match(nonce, /^[0-9a-f]{64}$/); assert.equal(signal.aborted, false);
    assert.equal((await trace(f)).at(-1), "namespace-complete"); approved++;
    return { permissionSha256: "e".repeat(64) };
  } });
  assert.equal(result.status, "completed"); assert.equal(result.receipt.outcome, "verified-effect");
  assert.equal(result.receipt.cleanup, "completed");
  for (const directory of f.ownedDirectories) await assert.rejects(lstat(directory), { code: "ENOENT" });
  assert.equal(approved, 1); assert.equal((await trace(f)).filter(x => x === "publish").length, 1);
  await assert.rejects(runHumanPublisher({ ...f, fresh: async () => {}, authorizeReady: async () => {} }),
    { code: "PUBLICATION_GATE_ALREADY_ATTEMPTED", dispatched: null });
  assert.equal(f.launched, 1);
});

for (const mode of ["wrong-session", "duplicate-ready", "early-receipt", "disconnect"]) test(`actual IPC rejects ${mode} without accepting a publication success`, async t => {
  const f = await humanPublicationFixture(t, { mode });
  const result = await runHumanPublisher({ ...f, fresh: async () => {}, authorizeReady: async ({ signal }) => {
    await delay(100, undefined, { signal }); return { permissionSha256: "e".repeat(64) };
  } });
  assert.equal(result.status, "failed"); assert.notEqual(result.receipt.outcome, "verified-effect");
  assert.equal((await trace(f)).includes("publish"), false);
});

test("actual child: denied late observation cancels preparation without dispatch", async t => {
  const f = await humanPublicationFixture(t);
  const result = await runHumanPublisher({ ...f, fresh: async () => {}, authorizeReady: async () => {
    throw Object.assign(new Error("revoked"), { code: "AUTHORITY_REVOKED" });
  } });
  assert.equal(result.status, "failed"); assert.equal(result.receipt.outcome, "verified-no-effect");
  assert.equal((await trace(f)).includes("publish"), false);
});

test("actual child reidentifies the client after waiting, before dispatch", async t => {
  const f = await humanPublicationFixture(t, { mode: "changed-client" });
  const result = await runHumanPublisher({ ...f, fresh: async () => {}, authorizeReady: async () => {
    await writeFile(join(f.root, "client-changed"), "changed during permission wait");
    return { permissionSha256: "e".repeat(64) };
  } });
  assert.equal(result.status, "failed"); assert.equal(result.receipt.outcome, "verified-no-effect");
  assert.equal((await trace(f)).filter(x => x === "identify").length, 2);
  assert.equal((await trace(f)).includes("publish"), false);
});

test("actual child: output loss after dispatch remains unknown and prevents another session", async t => {
  const f = await humanPublicationFixture(t, { mode: "output-lost" });
  const result = await runHumanPublisher({ ...f, fresh: async () => {},
    authorizeReady: async () => ({ permissionSha256: "e".repeat(64) }) });
  assert.equal(result.receipt.outcome, "unknown"); assert.equal(result.receipt.dispatched, true);
  assert.equal((await trace(f)).filter(x => x === "publish").length, 1);
  await assert.rejects(runHumanPublisher({ ...f, fresh: async () => {}, authorizeReady: async () => {} }),
    { code: "PUBLICATION_GATE_ALREADY_ATTEMPTED", dispatched: null });
});

test("actual child is closed after the finite deadline even when its fixture namespace ignores cancellation", { timeout: 10000 }, async t => {
  const f = await humanPublicationFixture(t, { mode: "hang", windowMs: 500 });
  const result = await runHumanPublisher({ ...f, fresh: async () => {},
    authorizeReady: async () => ({ permissionSha256: "e".repeat(64) }) });
  assert.equal(result.status, "failed"); assert.equal(result.receipt.outcome, "unknown");
  assert.equal(result.receipt.cleanup, "completed");
  for (const directory of f.ownedDirectories) await assert.rejects(lstat(directory), { code: "ENOENT" });
  assert.equal((await trace(f)).includes("publish"), false);
});

for (const owner of [true, false]) test(`actual human child identifies npm and reads its namespace, owner=${owner}`,
  { skip: !process.env.TABGRAD_COMPOSITION_CLIENT }, async t => {
    const service = await publicationNamespaceService(t, owner);
    const f = await humanPublicationFixture(t, { actual: true, registry: service.registry,
      clientDirectory: process.env.TABGRAD_COMPOSITION_CLIENT, clientSha256: process.env.TABGRAD_COMPOSITION_CLIENT_SHA256 });
    let approvals = 0;
    const result = await runHumanPublisher({ ...f, fresh: async () => {}, authorizeReady: async () => {
      approvals++;
      assert.deepEqual(service.calls, ["/-/whoami", "/-/org/example/user", "/@example/candidate"]);
      return { permissionSha256: "e".repeat(64) };
    } });
    assert.equal(approvals, owner ? 1 : 0);
    assert.equal(result.receipt.outcome, owner ? "verified-effect" : "verified-no-effect");
    assert.equal((await trace(f)).filter(x => x === "identify").length, owner ? 2 : 1);
    for (const directory of f.ownedDirectories) await assert.rejects(lstat(directory), { code: "ENOENT" });
  });
