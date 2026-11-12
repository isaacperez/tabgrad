import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inventory, preparePayload } from "../scripts/payload.mjs";
import { publicationContext, hostingAccount, publishWebsite } from "../scripts/publisher.mjs";
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
    let calls = 0;
    const receipts = [];
    await assert.rejects(publishWebsite(payload, env, {
      async record(value) { receipts.push(structuredClone(value)); },
      async deploy() { calls++; if (outcome === "throw") throw new Error("synthetic failure"); return outcome === "exit" ? 1 : 0; },
      async observe() { return "c".repeat(64); },
    }), /unknown/);
    assert.equal(calls, 1);
    assert.equal(receipts.at(-1).state, "unknown");
  }
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
});
