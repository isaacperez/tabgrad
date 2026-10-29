import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicationEnvironment, runPublicationProcess } from "../../../scripts/publication-client.mjs";
import { runHumanPublisher } from "../../../scripts/publication-human.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "tabgrad-publication-process-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, environment: publicationEnvironment(directory), timeoutMs: 2000, maxOutputBytes: 1024 };
}

test("publication child receives a closed environment and observes exit", async t => {
  const options = await fixture(t);
  const environment = publicationEnvironment(options.directory, { NODE_OPTIONS: "private", GH_TOKEN: "secret", npm_config_userconfig: "private", LANG: "C" });
  assert.equal(environment.NODE_OPTIONS, undefined); assert.equal(environment.GH_TOKEN, undefined);
  assert.equal(environment.npm_config_userconfig, undefined); assert.equal(environment.LANG, "C");
  const result = await runPublicationProcess(process.execPath, ["-e", "process.stdout.write('known')"], { ...options, environment });
  assert.equal(result.stdout, "known"); assert.equal(result.dispatched, true);
});

for (const [name, source, overrides, expected] of [
  ["timeout", "setInterval(() => {}, 1000)", { timeoutMs: 75 }, "PUBLICATION_CLIENT_TIMEOUT"],
  ["stdout cap", "process.stdout.write('x'.repeat(50000))", {}, "PUBLICATION_CLIENT_OUTPUT_LIMIT"],
  ["stderr cap", "process.stderr.write('x'.repeat(50000))", {}, "PUBLICATION_CLIENT_OUTPUT_LIMIT"],
  ["rejection", "process.exitCode=3", {}, "PUBLICATION_CLIENT_REJECTED"],
]) test(`publication child ${name} retains dispatched uncertainty and is reaped`, async t => {
  const options = await fixture(t);
  await assert.rejects(runPublicationProcess(process.execPath, ["-e", source], { ...options, ...overrides }), error => {
    assert.equal(error.code, expected); assert.equal(error.dispatched, true);
    assert.ok(error.privateClientEvidence.status !== null || error.privateClientEvidence.signal !== null);
    assert.ok(error.privateClientEvidence.stdout.length <= options.maxOutputBytes);
    assert.ok(error.privateClientEvidence.stderr.length <= options.maxOutputBytes); return true;
  });
});

test("publication child cancellation before spawn has no dispatched call", async t => {
  const options = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(runPublicationProcess(process.execPath, ["-e", "process.exit(0)"], { ...options, signal: controller.signal }),
    { code: "PUBLICATION_CLIENT_CANCELLED", dispatched: false });
});

test("publication child cancellation after spawn observes its termination", async t => {
  const options = await fixture(t), controller = new AbortController();
  const result = runPublicationProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { ...options, signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 75);
  try { await assert.rejects(result, { code: "PUBLICATION_CLIENT_CANCELLED", dispatched: true }); }
  finally { clearTimeout(timer); }
});

test("missing publication executable is a known no-dispatch failure", async t => {
  const options = await fixture(t);
  await assert.rejects(runPublicationProcess(join(options.directory, "absent"), [], options),
    { code: "PUBLICATION_CLIENT_FAILED", dispatched: false });
});

test("human controller rejects live authority before touching private configuration or spawning", async () => {
  let calls = 0;
  await assert.rejects(runHumanPublisher({ root: "/nonexistent", plan: {}, admission: {}, environment: {}, fresh: async () => {
    calls++; throw new Error("authority unavailable");
  } }), /authority unavailable/);
  assert.equal(calls, 1);
});
