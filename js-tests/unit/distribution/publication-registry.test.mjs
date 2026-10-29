import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publicationPlanFixture } from "../../fixtures/publication.mjs";
import { publicationRegistry } from "../../../scripts/publication-registry.mjs";
import { sha256 } from "../../../scripts/release-record-data.mjs";

function fixture() {
  const plan = publicationPlanFixture().publicationPlan;
  plan.npm.mode = "oidc"; plan.npm.before = { package: "existing", version: "absent", channel: "0.9.6" };
  const pack = { name: plan.candidate.name, "dist-tags": { latest: "0.9.6" }, versions: {}, time: {} }, requests = [];
  const registry = publicationRegistry({ fetcher: async (url, options) => {
    requests.push({ url, options }); return new Response(JSON.stringify(pack));
  } });
  return { plan, pack, requests, registry };
}

test("public registry observation has no credentials, redirects or writes", async () => {
  const f = fixture(); await f.registry.inspect(f.plan, "before");
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].options.method, "GET");
  assert.equal(f.requests[0].options.redirect, "error");
  assert.deepEqual(f.requests[0].options.headers, { Accept: "application/json" });
  assert.equal(f.requests[0].url.origin, "https://registry.npmjs.org");
});

test("public 404 remains unknown, never proof of first-package absence", async () => {
  const f = fixture(), r = publicationRegistry({ fetcher: async () => new Response("{}", { status: 404 }) });
  await assert.rejects(r.inspect(f.plan, "before"), { code: "PUBLICATION_REGISTRY_VISIBILITY_UNKNOWN" });
});

for (const [name, change] of [["version already present", (p, v) => { p.versions[v] = {}; }],
  ["used version time", (p, v) => { p.time[v] = "2026-01-01"; }],
  ["unpublished version", (p, v) => { p.time.unpublished = { versions: [v] }; }],
  ["moved channel", p => { p["dist-tags"].latest = "0.8.0"; }]]) test(`registry rejects ${name} before a call`, async () => {
  const f = fixture(); change(f.pack, f.plan.candidate.version);
  await assert.rejects(f.registry.inspect(f.plan, "before"), { code: "PUBLICATION_REGISTRY_CONFLICT" });
});

test("registry proof association conserves the original bundle and refuses a foreign provenance URL", async t => {
  const directory = await mkdtemp(join(tmpdir(), "tabgrad-publication-registry-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = fixture(), raw = Buffer.from('{ "original": "signed fixture payload" }\n');
  f.plan.producer.archiveProofSha256 = sha256(raw);
  const path = join(directory, "proof.json"); await writeFile(path, raw);
  const version = { name: f.plan.candidate.name, version: f.plan.candidate.version, dist: {
    integrity: `sha512-${Buffer.from(f.plan.candidate.archiveSha512, "hex").toString("base64")}`,
    attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/fixture" } } };
  f.pack.versions[f.plan.candidate.version] = version; f.pack["dist-tags"].latest = f.plan.candidate.version;
  let bundle = JSON.parse(raw), calls = 0;
  const registry = publicationRegistry({ fetcher: async url => {
    calls++; return new Response(JSON.stringify(url.pathname.startsWith("/-/")
      ? { attestations: [{ predicateType: "https://slsa.dev/provenance/v1", bundle }] } : f.pack));
  } });
  assert.equal((await registry.associateOriginalProof(f.plan, path)).status, "passed");
  bundle = { changed: true };
  await assert.rejects(registry.associateOriginalProof(f.plan, path), { code: "PUBLICATION_REGISTRY_PROVENANCE_MISMATCH" });
  version.dist.attestations.url = "https://example.invalid/stolen";
  const before = calls;
  await assert.rejects(registry.associateOriginalProof(f.plan, path), { code: "PUBLICATION_REGISTRY_ENDPOINT" });
  assert.equal(calls, before + 1);
});

test("registry bounds response bytes and does not retry a rejected response", async () => {
  const f = fixture(); let calls = 0;
  const r = publicationRegistry({ maxBytes: 16, fetcher: async () => { calls++; return new Response("x".repeat(17)); } });
  await assert.rejects(r.inspect(f.plan, "after"), { code: "PUBLICATION_REGISTRY_RESPONSE_LIMIT" });
  assert.equal(calls, 1);
});
