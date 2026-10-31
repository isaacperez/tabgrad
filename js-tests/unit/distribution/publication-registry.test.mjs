import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function associationFixture(t, original) {
  const directory = await mkdtemp(join(tmpdir(), "tabgrad-publication-association-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = fixture(), raw = Buffer.from(JSON.stringify(original));
  f.plan.producer.archiveProofSha256 = sha256(raw);
  const path = join(directory, "proof.json"); await writeFile(path, raw);
  f.pack.versions[f.plan.candidate.version] = { name: f.plan.candidate.name, version: f.plan.candidate.version, dist: {
    integrity: `sha512-${Buffer.from(f.plan.candidate.archiveSha512, "hex").toString("base64")}`,
    attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/fixture" },
  } };
  f.pack["dist-tags"].latest = f.plan.candidate.version;
  const state = { bundle: structuredClone(original), predicateType: "https://slsa.dev/provenance/v1" };
  const registry = publicationRegistry({ fetcher: async url => new Response(JSON.stringify(url.pathname.startsWith("/-/")
    ? { attestations: (state.bundles ?? [state.bundle]).map(bundle => ({ predicateType: state.predicateType, bundle })) } : f.pack)) });
  return { ...f, raw, path, state, registry };
}

// Structural association controls only; these are not cryptographic proofs.
function syntheticBundle(defaults = 0) {
  const bundle = { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    dsseEnvelope: { payloadType: "application/vnd.in-toto+json", payload: "cGF5bG9hZA==", signatures: [{ sig: "c2ln" }] },
    verificationMaterial: { certificate: { rawBytes: "Y2VydA==" }, tlogEntries: [{ logIndex: "1" }], timestampVerificationData: {} },
    unknownField: { preserved: true } };
  if (defaults & 1) bundle.dsseEnvelope.signatures[0].keyid = "";
  if (defaults & 2) bundle.verificationMaterial.timestampVerificationData.rfc3161Timestamps = [];
  return bundle;
}

for (let original = 0; original < 4; original++) for (let received = 0; received < 4; received++) {
  test(`association preserves known empty defaults (${original}/${received}) and original bytes`, async t => {
    const f = await associationFixture(t, syntheticBundle(original));
    f.state.bundle = syntheticBundle(received);
    const before = structuredClone(f.state.bundle);
    const report = await f.registry.associateOriginalProof(f.plan, f.path);
    assert.equal(report.status, "passed"); assert.equal(report.originalProofSha256, sha256(f.raw));
    assert.deepEqual(await readFile(f.path), f.raw); assert.deepEqual(f.state.bundle, before);
  });
}

for (const [name, change] of [
  ["nonempty key id", b => { b.dsseEnvelope.signatures[0].keyid = "another-key"; }],
  ["nonempty timestamp", b => { b.verificationMaterial.timestampVerificationData.rfc3161Timestamps = [{ signedTimestamp: "b3RoZXI=" }]; }],
  ["null key id", b => { b.dsseEnvelope.signatures[0].keyid = null; }],
  ["null timestamps", b => { b.verificationMaterial.timestampVerificationData.rfc3161Timestamps = null; }],
  ["signed payload", b => { b.dsseEnvelope.payload = "b3RoZXI="; }],
  ["payload type", b => { b.dsseEnvelope.payloadType = "other"; }],
  ["signature", b => { b.dsseEnvelope.signatures[0].sig = "b3RoZXI="; }],
  ["certificate", b => { b.verificationMaterial.certificate.rawBytes = "b3RoZXI="; }],
  ["transparency material", b => { b.verificationMaterial.tlogEntries[0].logIndex = "2"; }],
  ["unknown empty field", b => { b.extraUnknown = []; }],
  ["removed unknown field", b => { delete b.unknownField; }],
  ["changed unknown field", b => { b.unknownField.preserved = false; }],
  ["absent message", b => { delete b.verificationMaterial.timestampVerificationData; }],
  ["signature cardinality", b => { b.dsseEnvelope.signatures.push({ sig: "b3RoZXI=" }); }],
  ["malformed signatures", b => { b.dsseEnvelope.signatures = null; }],
]) test(`association rejects changed ${name}`, async t => {
  const f = await associationFixture(t, syntheticBundle()); change(f.state.bundle);
  await assert.rejects(f.registry.associateOriginalProof(f.plan, f.path), { code: "PUBLICATION_REGISTRY_PROVENANCE_MISMATCH" });
});

test("association preserves exact nonempty and unknown values", async t => {
  const original = syntheticBundle(); original.dsseEnvelope.signatures[0].keyid = "same-key";
  original.verificationMaterial.timestampVerificationData.rfc3161Timestamps = [{ signedTimestamp: "c2FtZQ==" }];
  const f = await associationFixture(t, original);
  assert.equal((await f.registry.associateOriginalProof(f.plan, f.path)).status, "passed");
});

test("association preserves transparency array ordering", async t => {
  const original = syntheticBundle(); original.verificationMaterial.tlogEntries.push({ logIndex: "2" });
  const f = await associationFixture(t, original); f.state.bundle.verificationMaterial.tlogEntries.reverse();
  await assert.rejects(f.registry.associateOriginalProof(f.plan, f.path), { code: "PUBLICATION_REGISTRY_PROVENANCE_MISMATCH" });
});

test("association rejects ambiguous normalized matches, wrong predicate and changed original bytes", async t => {
  const f = await associationFixture(t, syntheticBundle()); f.state.bundles = [syntheticBundle(), syntheticBundle(3)];
  await assert.rejects(f.registry.associateOriginalProof(f.plan, f.path), { code: "PUBLICATION_REGISTRY_PROVENANCE_MISMATCH" });
  delete f.state.bundles; f.state.predicateType = "https://example.invalid/other";
  await assert.rejects(f.registry.associateOriginalProof(f.plan, f.path), { code: "PUBLICATION_REGISTRY_PROVENANCE_MISMATCH" });
  f.state.predicateType = "https://slsa.dev/provenance/v1";
  await writeFile(f.path, Buffer.concat([f.raw, Buffer.from("\n")]));
  await assert.rejects(f.registry.associateOriginalProof(f.plan, f.path), { code: "PUBLICATION_REGISTRY_PROVENANCE_MISMATCH" });
});

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
