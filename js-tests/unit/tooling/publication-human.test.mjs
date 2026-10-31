import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { humanPublicationFixture } from "../../fixtures/publication-human.mjs";
import { publicationNamespaceService } from "../../fixtures/publication-namespace.mjs";
import { runHumanPublisher } from "../../../scripts/publication-human.mjs";

async function trace(f) { return (await readFile(join(f.root, "trace.txt"), "utf8")).trim().split("\n"); }

for (const [windowMs, readerWindowMs] of [[180000, 240000], [240000, 180000]]) {
  test(`human publish uses remaining plan/reader deadlines (${windowMs}/${readerWindowMs})`, async t => {
    const f = await humanPublicationFixture(t, { windowMs, readerWindowMs, captureBudget: true });
    const reader = JSON.parse(await readFile(join(f.root, "reader.json")));
    const deadline = Math.min(Date.parse(f.plan.window.deadline), Date.parse(reader.expiresAt));
    const before = Date.now();
    const result = await runHumanPublisher({ ...f, fresh: async () => {},
      authorizeReady: async () => ({ permissionSha256: "e".repeat(64) }) });
    const after = Date.now(), budget = JSON.parse(await readFile(join(f.root, "budget.json")));
    assert.equal(result.status, "completed");
    assert.ok(budget.timeoutMs >= deadline - after && budget.timeoutMs <= deadline - before,
      `forwarded budget ${budget.timeoutMs} must follow the earlier remaining deadline`);
    assert.ok(budget.timeoutMs > 120000);
  });
}

for (const windowMs of [2147483647 + 60000, 2147483647 - 1000]) {
  test(`human session and close grace do not overflow the native timer (${windowMs})`, async t => {
    const f = await humanPublicationFixture(t, { windowMs,
      readerWindowMs: 2147483647 + 120000, captureBudget: true });
    const deadline = Date.parse(f.plan.window.deadline), before = Date.now();
    const result = await runHumanPublisher({ ...f, fresh: async () => {},
      authorizeReady: async () => ({ permissionSha256: "e".repeat(64) }) });
    assert.equal(result.status, "completed");
    const after = Date.now(), budget = JSON.parse(await readFile(join(f.root, "budget.json")));
    assert.ok(budget.timeoutMs >= Math.min(2147483647, deadline - after)
      && budget.timeoutMs <= Math.min(2147483647, deadline - before));
  });
}

test("genuine terminal shows the pinned npm web link without Enter or browser launch", {
  skip: !process.env.TABGRAD_COMPOSITION_CLIENT || !process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY,
  timeout: 60000,
}, async t => {
  const f = await humanPublicationFixture(t, { webTerminal: true, windowMs: 30000,
    clientDirectory: process.env.TABGRAD_COMPOSITION_CLIENT, clientSha256: process.env.TABGRAD_COMPOSITION_CLIENT_SHA256 });
  const original = childProcess.fork;
  const fork = t.mock.method(childProcess, "fork", (module, args, options) => {
    assert.equal(module, fileURLToPath(new URL("../../../scripts/publication-human.mjs", import.meta.url)));
    return original(fileURLToPath(new URL("../../fixtures/publication-human-client.mjs", import.meta.url)), [], options);
  });
  syncBuiltinESMExports();
  try {
    const result = await runHumanPublisher({ ...f, launch: undefined, fresh: async () => {},
      authorizeReady: async () => ({ permissionSha256: "e".repeat(64) }) });
    const observed = JSON.parse(await readFile(join(f.root, "terminal-result.json")));
    t.diagnostic(JSON.stringify(observed));
    assert.deepEqual(observed, { terminal: { stdin: true, stdout: true, stderr: true }, json: false, browser: false,
      standardLinks: 1, bufferedLinks: 0, inputRequests: 0, registryRequests: 0 });
    assert.equal(result.status, "completed");
    assert.equal(result.receipt.code, "PUBLICATION_NPM_HUMAN_PROCESS_SUCCESS");
  } finally { fork.mock.restore(); syncBuiltinESMExports(); }
});

test("genuine terminal crosses the default human launcher and reaches the pinned npm challenge", {
  skip: !process.env.TABGRAD_COMPOSITION_CLIENT || !process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY,
  timeout: 60000,
}, async t => {
  const f = await humanPublicationFixture(t, { terminal: true, windowMs: 30000, clientDirectory: process.env.TABGRAD_COMPOSITION_CLIENT,
    clientSha256: process.env.TABGRAD_COMPOSITION_CLIENT_SHA256 });
  const original = childProcess.fork;
  // Keep the production launcher's options and real fork. Only external effects
  // are replaced by the existing child fixture; the TTY chain is not mocked.
  const fork = t.mock.method(childProcess, "fork", (module, args, options) => {
    assert.equal(module, fileURLToPath(new URL("../../../scripts/publication-human.mjs", import.meta.url)));
    return original(fileURLToPath(new URL("../../fixtures/publication-human-client.mjs", import.meta.url)), [], options);
  });
  syncBuiltinESMExports();
  try {
    const result = await runHumanPublisher({ ...f, launch: undefined, fresh: async () => {},
      authorizeReady: async () => ({ permissionSha256: "e".repeat(64) }) });
    const observed = JSON.parse(await readFile(join(f.root, "terminal-result.json")));
    t.diagnostic(JSON.stringify(observed));
    assert.deepEqual(observed, {
      terminal: { stdin: true, stdout: true, stderr: true }, calls: 2, status: "passed", registryRequests: 0,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.receipt.outcome, "verified-effect");
    assert.equal(result.receipt.code, "PUBLICATION_NPM_HUMAN_PROCESS_SUCCESS");
    assert.equal(result.receipt.cleanup, "completed");
  } finally { fork.mock.restore(); syncBuiltinESMExports(); }
});

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
