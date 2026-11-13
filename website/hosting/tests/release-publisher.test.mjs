import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { siteFixture } from "../../../js-tests/fixtures/release-site.mjs";
import { canonicalBytes, sha256 } from "../../../scripts/release-record-data.mjs";
import { releaseSiteIdentity } from "../../../scripts/release-website.mjs";
import { inventory, preparePayload } from "../scripts/payload.mjs";
import { publishWebsite } from "../scripts/publisher.mjs";

async function released(t) {
  const origin = "https://site.example.edu/", account = { account_id: "a".repeat(32), name: "site-fixture" };
  const f = await siteFixture(t, { website: { configurationSha256: sha256(canonicalBytes(account)), originSha256: sha256(Buffer.from(origin)) } });
  const source = join(f.root, "site-source"); await mkdir(source);
  await writeFile(join(source, "index.html"), "<h1>Site fixture</h1>");
  await writeFile(join(source, "404.html"), "<h1>Not found</h1>");
  const root = join(f.root, "site-payload"), release = releaseSiteIdentity(f.descriptor);
  const { digest } = await preparePayload(source, root, { origin, revision: release.sourceRevision,
    checked: { origin, revision: release.sourceRevision, recipeRevision: release.recipeRevision,
      localChanges: false, release, files: await inventory(source) } });
  const completion = join(f.root, "site-completion.json"); await writeFile(completion, canonicalBytes(f.descriptor));
  const env = { ...f.environment, TABGRAD_WEBSITE_ENABLED: "true", TABGRAD_WEBSITE_MODE: "publish", TABGRAD_WEBSITE_INITIAL: "true",
    TABGRAD_SITE_URL: origin, TABGRAD_DELIVERY_SHA256: digest, TABGRAD_HOST_CONFIG_JSON: JSON.stringify(account),
    CLOUDFLARE_API_TOKEN: "synthetic-not-a-credential", TABGRAD_WEBSITE_COMPLETION: completion,
    TABGRAD_COMPLETION_SHA256: f.selected.sha256, TABGRAD_COMPLETION_ID: f.artifact.id, TABGRAD_COMPLETION_DIGEST: f.artifact.sha256 };
  return { ...f, root, env, digest };
}

test("release-bound publisher verifies known public completion and target before its single hosting call", async t => {
  const f = await released(t); let calls = 0; const records = [];
  const operations = { releaseApi: f.api, deploy: async () => { calls++; return 0; }, observe: async () => f.digest,
    record: async value => { records.push(structuredClone(value)); } };
  assert.equal((await publishWebsite(f.root, f.env, operations)).state, "confirmed");
  assert.equal(calls, 1); assert.deepEqual(records.map(row => row.state), ["unknown", "confirmed"]);
  for (const change of [{ TABGRAD_COMPLETION_SHA256: "f".repeat(64) },
    { TABGRAD_HOST_CONFIG_JSON: JSON.stringify({ account_id: "b".repeat(32), name: "other-fixture" }) }]) {
    await assert.rejects(publishWebsite(f.root, { ...f.env, ...change }, operations)); assert.equal(calls, 1);
  }
  f.values.get("/actions/runs/601/attempts/1/jobs?per_page=100").jobs[0].conclusion = "failure";
  await assert.rejects(publishWebsite(f.root, f.env, operations)); assert.equal(calls, 1);
});

test("release-bound hosting failure retains an unknown result without repeating earlier publication stages", async t => {
  const f = await released(t); let calls = 0; const records = [];
  await assert.rejects(publishWebsite(f.root, f.env, { releaseApi: f.api,
    deploy: async () => { calls++; throw new Error("lost hosting response"); }, observe: async () => f.digest,
    record: async value => { records.push(structuredClone(value)); } }), /unknown/);
  assert.equal(calls, 1); assert.deepEqual(records.map(row => row.state), ["unknown", "unknown"]);
});
