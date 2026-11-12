import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inventory, preparePayload } from "../scripts/payload.mjs";
import { publicationContext, hostingAccount, liveDigest, publishWebsite } from "../scripts/publisher.mjs";
import { acquirePredecessor } from "../scripts/predecessor.mjs";

const revision = "a".repeat(40), origin = "https://site.example.edu/";
/** @param {object} context @returns {Promise<object>} */
async function candidate(context) {
  const root = await mkdtemp(join(tmpdir(), "tabgrad-publisher-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"); await mkdir(source);
  await writeFile(join(source, "index.html"), "<h1>Home</h1>");
  await writeFile(join(source, "404.html"), "<h1>Missing</h1>");
  const checked = { origin, revision, localChanges: false, files: await inventory(source) };
  const payload = join(root, "payload");
  const { digest } = await preparePayload(source, payload, { origin, revision, checked });
  const env = { TABGRAD_WEBSITE_ENABLED: "true", TABGRAD_WEBSITE_MODE: "publish", GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: revision, TABGRAD_DELIVERY_SHA256: digest,
    TABGRAD_WEBSITE_INITIAL: "true", TABGRAD_SITE_URL: origin, CLOUDFLARE_API_TOKEN: "synthetic-test-value",
    TABGRAD_HOST_CONFIG_JSON: JSON.stringify({ account_id: "b".repeat(32), name: "static-fixture" }) };
  return { root, payload, env, checked };
}

test("missing configuration, PR context, nonmain and re-runs cannot reach a publication", () => {
  const valid = { TABGRAD_WEBSITE_ENABLED: "true", TABGRAD_WEBSITE_MODE: "publish", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: revision, TABGRAD_DELIVERY_SHA256: "b".repeat(64), TABGRAD_WEBSITE_INITIAL: "false" };
  assert.equal(publicationContext(valid).initial, false);
  for (const key of Object.keys(valid)) assert.throws(() => publicationContext({ ...valid, [key]: undefined }), key);
  for (const [key, value] of [["GITHUB_EVENT_NAME", "pull_request"], ["GITHUB_REF", "refs/heads/other"], ["GITHUB_RUN_ATTEMPT", "2"]]) assert.throws(() => publicationContext({ ...valid, [key]: value }));
  assert.throws(() => hostingAccount({ account_id: "b".repeat(32), name: "static", routes: [] }));
});

test("the protected handoff publishes once, records before writing, and confirms the exact public bytes", async context => {
  const { payload, env } = await candidate(context);
  const events = [];
  const result = await publishWebsite(payload, env, {
    async record(value) { events.push(["receipt", value.state]); },
    async deploy(config) {
      assert.deepEqual(events, [["receipt", "unknown"]]);
      assert.ok(!config.main && !config.routes && !config.vars);
      assert.equal(config.workers_dev, false);
      assert.equal(config.assets.not_found_handling, "404-page");
      events.push(["deploy"]); return 0;
    },
    async observe() { events.push(["observe"]); return env.TABGRAD_DELIVERY_SHA256; },
  });
  assert.equal(result.state, "confirmed");
  assert.deepEqual(events, [["receipt", "unknown"], ["deploy"], ["observe"], ["receipt", "confirmed"]]);
});

test("public confirmation tolerates activation and propagation without another deployment", async context => {
  const { payload, env } = await candidate(context);
  let elapsed = 0, deployments = 0, observations = 0;
  const receipts = [];
  const result = await publishWebsite(payload, env, {
    now: () => elapsed,
    async wait(milliseconds) { elapsed += milliseconds; },
    async record(value) { receipts.push(structuredClone(value)); },
    async deploy() { deployments++; return 0; },
    async observe() {
      observations++;
      if (observations === 1) throw new Error("synthetic unavailable origin");
      return observations === 2 ? "c".repeat(64) : env.TABGRAD_DELIVERY_SHA256;
    },
  });
  assert.equal(result.state, "confirmed");
  assert.equal(deployments, 1);
  assert.equal(observations, 3);
  assert.deepEqual(result.confirmation, { confirmed: true, attempts: 3, unavailable: 1, different: 1 });
  assert.equal(receipts.at(-1).state, "confirmed");
  assert.ok(elapsed > 0 && elapsed < 300_000);
});

test("an unavailable public identity releases its response body before another observation", async context => {
  let cancelled = 0;
  context.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.equal(options.headers, undefined);
    return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 404 });
  });
  await assert.rejects(liveDigest(origin), /identity is unavailable/);
  assert.equal(cancelled, 1);
});

test("changed output or absent credential fails before the credential-bearing operation", async context => {
  const { payload, env } = await candidate(context);
  let calls = 0;
  const operations = { async record() {}, async deploy() { calls++; return 0; }, async observe() { return env.TABGRAD_DELIVERY_SHA256; } };
  await assert.rejects(publishWebsite(payload, { ...env, CLOUDFLARE_API_TOKEN: undefined }, operations), /credential/);
  await writeFile(join(payload, "index.html"), "changed after tests");
  await assert.rejects(publishWebsite(payload, env, operations), /inventory/);
  assert.equal(calls, 0);
});

test("failure, interruption or missing confirmation stays unknown without repeating the call", async context => {
  const { payload, env } = await candidate(context);
  for (const outcome of ["exit", "throw", "unconfirmed"]) {
    let calls = 0, observations = 0, elapsed = 0;
    const receipts = [];
    await assert.rejects(publishWebsite(payload, env, {
      now: () => elapsed,
      async wait(milliseconds) { elapsed += milliseconds; },
      async record(value) { receipts.push(structuredClone(value)); },
      async deploy() { calls++; if (outcome === "throw") throw new Error("synthetic failure"); return outcome === "exit" ? 1 : 0; },
      async observe() { observations++; return "c".repeat(64); },
    }), /unknown/);
    assert.equal(calls, 1);
    assert.equal(receipts.at(-1).state, "unknown");
    if (outcome === "unconfirmed") {
      assert.equal(elapsed, 300_000);
      assert.ok(observations > 1);
      assert.equal(receipts.at(-1).commandExit, 0);
      assert.equal(receipts.at(-1).confirmation.confirmed, false);
      assert.equal(receipts.at(-1).confirmation.different, observations);
    } else assert.equal(observations, 0);
  }
});

test("a matching observation arriving after the deadline cannot confirm an upload", async context => {
  const { payload, env } = await candidate(context);
  let elapsed = 0, deployments = 0, observations = 0;
  const receipts = [];
  await assert.rejects(publishWebsite(payload, env, {
    now: () => elapsed,
    async wait() { assert.fail("a late response must not start another wait"); },
    async record(value) { receipts.push(structuredClone(value)); },
    async deploy() { deployments++; return 0; },
    async observe(_origin, timeout) {
      observations++;
      assert.ok(timeout > 0 && timeout <= 15_000);
      elapsed = 300_001;
      return env.TABGRAD_DELIVERY_SHA256;
    },
  }), /unknown/);
  assert.equal(deployments, 1);
  assert.equal(observations, 1);
  assert.equal(receipts.at(-1).commandExit, 0);
  assert.equal(receipts.at(-1).confirmation.confirmed, false);
  assert.equal(receipts.at(-1).state, "unknown");
});

test("the final read is capped by the remaining confirmation budget", async context => {
  const { payload, env } = await candidate(context);
  let elapsed = 0, deployments = 0;
  const timeouts = [];
  const result = await publishWebsite(payload, env, {
    now: () => elapsed,
    async wait(milliseconds) { elapsed += milliseconds; },
    async record() {},
    async deploy() { deployments++; return 0; },
    async observe(_origin, timeout) {
      timeouts.push(timeout);
      if (timeouts.length === 1) { elapsed = 294_000; throw new Error("synthetic unavailable origin"); }
      return env.TABGRAD_DELIVERY_SHA256;
    },
  });
  assert.deepEqual(timeouts, [15_000, 4_000]);
  assert.equal(deployments, 1);
  assert.equal(result.state, "confirmed");
});

test("an update checks the current live predecessor before any credential-bearing call", async context => {
  const { root, payload, env, checked } = await candidate(context);
  const previous = join(root, "predecessor");
  await acquirePredecessor(origin, join(root, "source"), previous, async url => new Response(await readFile(join(payload, url.pathname))));
  const next = join(root, "next");
  const revision = "c".repeat(40);
  const { digest } = await preparePayload(join(root, "source"), next, { origin, revision, checked: { ...checked, revision }, previous });
  const nextEnv = { ...env, GITHUB_SHA: revision, TABGRAD_DELIVERY_SHA256: digest, TABGRAD_WEBSITE_INITIAL: "false" };
  let calls = 0;
  await assert.rejects(publishWebsite(next, nextEnv, { async record() {}, async observe() { return "d".repeat(64); }, async deploy() { calls++; return 0; } }), /live website changed/);
  assert.equal(calls, 0);
  let observations = 0, elapsed = 0;
  const result = await publishWebsite(next, nextEnv, {
    now: () => elapsed, async wait(milliseconds) { elapsed += milliseconds; },
    async record() {}, async deploy() { calls++; return 0; },
    async observe() {
      observations++;
      if (observations === 1) return env.TABGRAD_DELIVERY_SHA256;
      assert.equal(calls, 1, "only post-upload reads may be repeated");
      if (observations === 2) throw new Error("synthetic propagation delay");
      return digest;
    },
  });
  assert.equal(calls, 1);
  assert.equal(observations, 3);
  assert.equal(result.state, "confirmed");
});

test("malformed private configuration never appears in a public error or reaches deployment", async context => {
  const { payload, env } = await candidate(context);
  const marker = "SYNTHETIC_PRIVATE_CONFIG_MARKER";
  let calls = 0;
  await assert.rejects(publishWebsite(payload, { ...env, TABGRAD_HOST_CONFIG_JSON: marker + "{" }, {
    async record() {}, async observe() { return env.TABGRAD_DELIVERY_SHA256; }, async deploy() { calls++; return 0; },
  }), error => {
    assert.equal(error.message, "Invalid private hosting configuration");
    assert.ok(!String(error.stack).includes(marker));
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(calls, 0);
});

test("equivalent admitted origin spellings publish consistently and different origins remain rejected", async context => {
  const { payload, env } = await candidate(context);
  let calls = 0;
  const operations = { async record() {}, async observe() { return env.TABGRAD_DELIVERY_SHA256; }, async deploy() { calls++; return 0; } };
  for (const value of [origin.slice(0, -1), "https://SITE.example.edu:443/"]) {
    const result = await publishWebsite(payload, { ...env, TABGRAD_SITE_URL: value }, operations);
    assert.equal(result.state, "confirmed");
  }
  assert.equal(calls, 2);
  await assert.rejects(publishWebsite(payload, { ...env, TABGRAD_SITE_URL: "https://other.example.edu/" }, operations), /origin changed/);
  assert.equal(calls, 2);
});
