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

async function proofReadinessFixture(t) {
  const f = await associationFixture(t, syntheticBundle());
  const state = { now: Date.now(), metadata: 0, proofs: 0, statuses: [404, 200], pauses: 0 };
  const registry = publicationRegistry({ clock: () => state.now,
    pause: async (ms, signal) => { state.pauses++; state.now += ms; await state.onPause?.(signal); },
    fetcher: async (url, options) => {
      const proof = url.pathname.startsWith('/-/');
      await state.onRequest?.(proof, options);
      if (!proof) { state.metadata++; return new Response(JSON.stringify(f.pack)); }
      const status = state.statuses[Math.min(state.proofs++, state.statuses.length - 1)];
      return new Response(status === 404 ? 'not available' : state.body ?? JSON.stringify({ attestations:
        [{ predicateType: 'https://slsa.dev/provenance/v1', bundle: f.state.bundle }] }), { status });
    } });
  return { ...f, registry, state, deadline: state.now + 60000 };
}

test('consumer readiness waits for locator404 without accepting missing or different proof material', async t => {
  const f = await proofReadinessFixture(t);
  const result = await f.registry.waitForPublished(f.plan, f.deadline, { proofPath: f.path });
  assert.equal(result.status, 'passed');
  assert.equal(result.originalProofSha256, sha256(f.raw));
  assert.equal(f.state.metadata, 2); assert.equal(f.state.proofs, 2); assert.equal(f.state.pauses, 1);
  assert.deepEqual(f.registry.observations.map(row => row.status), [200, 404, 200, 200]);
  assert.deepEqual(await readFile(f.path), f.raw);
});

test('metadata and proof availability spend the same absolute budget', async t => {
  const f = await proofReadinessFixture(t), ready = structuredClone(f.pack);
  f.pack.versions = {}; f.pack['dist-tags'].latest = f.plan.npm.before.channel;
  f.state.statuses = [404];
  f.state.onPause = () => Object.assign(f.pack, ready);
  await assert.rejects(f.registry.waitForPublished(f.plan, f.state.now + 30000, { proofPath: f.path }),
    { code: 'PUBLICATION_REGISTRY_NOT_READY' });
  assert.equal(f.state.metadata, 2); assert.equal(f.state.proofs, 1);
  assert.equal(f.state.pauses, 2);
});

for (const clockChange of ['advancing', 'static', 'rollback']) test(`unavailable proof has finite reads with ${clockChange} clock`, async t => {
  const f = await proofReadinessFixture(t); f.state.statuses = [404];
  if (clockChange !== 'advancing') f.state.onPause = () => { f.state.now -= clockChange === 'static' ? 15000 : 15001; };
  await assert.rejects(f.registry.waitForPublished(f.plan, f.state.now + 30000, { proofPath: f.path }),
    { code: 'PUBLICATION_REGISTRY_NOT_READY' });
  assert.equal(f.state.proofs, clockChange === 'advancing' ? 2 : 3);
});

for (const at of ['before', 'metadata', 'proof', 'pause']) test(`proof readiness propagates cancellation ${at}`, async t => {
  const f = await proofReadinessFixture(t), abort = new AbortController();
  if (at === 'before') abort.abort();
  if (at === 'metadata' || at === 'proof') f.state.onRequest = (proof, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    if (proof === (at === 'proof')) abort.abort();
  };
  if (at === 'pause') f.state.onPause = signal => { assert.equal(signal, abort.signal); abort.abort(); };
  await assert.rejects(f.registry.waitForPublished(f.plan, f.deadline, { proofPath: f.path, signal: abort.signal }), { name: 'AbortError' });
  assert.equal(f.state.proofs, at === 'before' || at === 'metadata' ? 0 : 1);
});

for (const at of ['metadata', 'proof']) test(`late ${at} cannot establish proof readiness or start a later acquisition`, async t => {
  const f = await proofReadinessFixture(t); f.state.statuses = [200];
  f.state.onRequest = proof => { if (proof === (at === 'proof')) f.state.now += 1001; };
  await assert.rejects(f.registry.waitForPublished(f.plan, f.state.now + 1000, { proofPath: f.path }),
    { code: 'PUBLICATION_REGISTRY_NOT_READY' });
  assert.equal(f.state.proofs, at === 'metadata' ? 0 : 1);
});

test('later metadata contradictions stop before another locator request', async t => {
  const f = await proofReadinessFixture(t); f.state.onPause = () => { f.pack['dist-tags'].latest = 'foreign'; };
  await assert.rejects(f.registry.waitForPublished(f.plan, f.deadline, { proofPath: f.path }), { code: 'PUBLICATION_REGISTRY_CONFLICT' });
  assert.equal(f.state.proofs, 1); assert.equal(f.state.metadata, 2);
});

for (const [name, change] of [
  ['HTTP403', f => { f.state.statuses = [403]; }],
  ['HTTP500', f => { f.state.statuses = [500]; }],
  ['malformed200', f => { f.state.statuses = [200]; f.state.body = 'invalid json'; }],
  ['missing attestations', f => { f.state.statuses = [200]; f.state.body = '{}'; }],
  ['different proof', f => { f.state.statuses = [200]; f.state.body = '{"attestations":[]}'; }],
  ['missing locator', f => { delete f.pack.versions[f.plan.candidate.version].dist.attestations; }],
  ['foreign locator', f => { f.pack.versions[f.plan.candidate.version].dist.attestations.url = 'https://example.invalid/proof'; }],
]) test(`proof readiness does not retry ${name}`, async t => {
  const f = await proofReadinessFixture(t); change(f);
  await assert.rejects(f.registry.waitForPublished(f.plan, f.deadline, { proofPath: f.path }));
  assert.equal(f.state.pauses, 0); assert.equal(f.state.metadata, 1);
});

test('locator404 cannot hide changed original bytes; direct association remains one-shot', async t => {
  const f = await proofReadinessFixture(t);
  await assert.rejects(f.registry.associateOriginalProof(f.plan, f.path), { code: 'PUBLICATION_REGISTRY_PROVENANCE_PENDING' });
  assert.equal(f.state.proofs, 1); assert.equal(f.state.pauses, 0);
  await writeFile(f.path, Buffer.concat([f.raw, Buffer.from('\n')]));
  const before = f.state.proofs;
  await assert.rejects(f.registry.waitForPublished(f.plan, f.deadline, { proofPath: f.path }), { code: 'PUBLICATION_REGISTRY_PROVENANCE_MISMATCH' });
  assert.equal(f.state.proofs, before); assert.equal(f.state.pauses, 0);
});

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

function pendingFixture(change) {
  const f = fixture(); let now = Date.now(), calls = 0;
  const exact = { name: f.plan.candidate.name, version: f.plan.candidate.version,
    dist: { integrity: `sha512-${Buffer.from(f.plan.candidate.archiveSha512, "hex").toString("base64")}` } };
  const states = [structuredClone(f.pack), structuredClone(f.pack)];
  states[1].versions[f.plan.candidate.version] = exact;
  states[1]["dist-tags"].latest = f.plan.candidate.version;
  change?.(states[0], exact, f.plan);
  const registry = publicationRegistry({ clock: () => now, pause: async ms => { now += ms; }, fetcher: async () => {
    const value = states[Math.min(calls++, states.length - 1)]; return new Response(JSON.stringify(value));
  } });
  return { ...f, registry, states, deadline: now + 60000, calls: () => calls, advance: ms => { now += ms; } };
}

for (const present of [false, true]) test(`post-result waits for exact registry state (selected version present=${present})`, async () => {
  const f = pendingFixture((pack, exact, plan) => { if (present) pack.versions[plan.candidate.version] = exact; });
  await f.registry.waitForPublished(f.plan, f.deadline);
  assert.equal(f.calls(), 2);
  assert.deepEqual(f.registry.observations.map(row => row.state), ["pending", "ready"]);
});

for (const [name, change] of [
  ["foreign channel", p => { p["dist-tags"].latest = "0.2.0"; }],
  ["missing channel", p => { delete p["dist-tags"].latest; }],
  ["selected channel without version", (p, _, plan) => { p["dist-tags"].latest = plan.candidate.version; }],
  ["withdrawn version", (p, _, plan) => { p.time.unpublished = { versions: [plan.candidate.version] }; }],
  ["used but absent version", (p, _, plan) => { p.time[plan.candidate.version] = "2026-01-01"; }],
  ["incomplete selected metadata", (p, _, plan) => { p.versions[plan.candidate.version] = {}; }],
  ["wrong integrity", (p, exact, plan) => { p.versions[plan.candidate.version] = { ...exact, dist: { integrity: "foreign" } }; }],
  ["wrong name", (p, exact, plan) => { p.versions[plan.candidate.version] = { ...exact, name: "foreign" }; }],
  ["wrong version", (p, exact, plan) => { p.versions[plan.candidate.version] = { ...exact, version: "0.0.1" }; }],
  ["private version", (p, exact, plan) => { p.versions[plan.candidate.version] = { ...exact, private: true }; }],
]) test(`post-result does not retry ${name}`, async () => {
  const f = pendingFixture(change);
  await assert.rejects(f.registry.waitForPublished(f.plan, f.deadline), { code: "PUBLICATION_REGISTRY_CONFLICT" });
  assert.equal(f.calls(), 1); assert.equal(f.registry.observations[0].state, "conflict");
});

test("pending result expires with bounded evidence and before remains one-shot", async () => {
  const f = pendingFixture(); f.states[1] = f.states[0];
  await assert.rejects(f.registry.waitForPublished(f.plan, f.deadline), { code: "PUBLICATION_REGISTRY_NOT_READY" });
  assert.equal(f.calls(), 4); assert.equal(f.registry.observations.length, 4);
  const before = fixture(); await before.registry.inspect(before.plan, "before"); assert.equal(before.requests.length, 1);
});

test("an expired budget or cancellation does not establish readiness", async () => {
  const f = pendingFixture(); f.states[0] = f.states[1]; f.advance(60000);
  await assert.rejects(f.registry.waitForPublished(f.plan, f.deadline), { code: "PUBLICATION_REGISTRY_WAIT_INVALID" });
  assert.equal(f.calls(), 0);
  const g = pendingFixture(), abort = new AbortController(); abort.abort();
  await assert.rejects(g.registry.waitForPublished(g.plan, g.deadline, { signal: abort.signal }), { name: "AbortError" });
  assert.equal(g.calls(), 0);
});

test("an exact response completing after the fixed deadline is not ready", async () => {
  const f = pendingFixture(); let now = Date.now();
  const deadline = now + 1000;
  const r = publicationRegistry({ clock: () => now, fetcher: async () => {
    now += 1001; return new Response(JSON.stringify(f.states[1]));
  } });
  await assert.rejects(r.waitForPublished(f.plan, deadline), { code: "PUBLICATION_REGISTRY_NOT_READY" });
  assert.equal(r.observations.length, 1);
});

test("cancellation after a pending observation stops before a second request", async () => {
  const f = pendingFixture(), abort = new AbortController(); let calls = 0;
  const r = publicationRegistry({ fetcher: async () => { calls++; return new Response(JSON.stringify(f.states[0])); },
    pause: async () => { abort.abort(); } });
  await assert.rejects(r.waitForPublished(f.plan, f.deadline, { signal: abort.signal }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("a nonadvancing injected clock/pause cannot grow observations without bound", async () => {
  const f = pendingFixture(); const now = Date.now(); let calls = 0;
  const r = publicationRegistry({ clock: () => now, pause: async () => {},
    fetcher: async () => { calls++; return new Response(JSON.stringify(f.states[0])); } });
  await assert.rejects(r.waitForPublished(f.plan, now + 30000), { code: "PUBLICATION_REGISTRY_NOT_READY" });
  assert.equal(calls, 3);
});

for (const response of [() => new Response("{}", { status: 404 }), () => new Response("denied", { status: 403 }),
  () => new Response("not-json"), () => new Response("x".repeat(32))]) test("post-result does not retry invalid HTTP/body", async () => {
  const f = pendingFixture(); let calls = 0;
  const r = publicationRegistry({ maxBytes: 16, fetcher: async () => { calls++; return response(); } });
  await assert.rejects(r.waitForPublished(f.plan, f.deadline)); assert.equal(calls, 1);
});
