import assert from "node:assert/strict";
import { test } from "node:test";
import { publicationPlanFixture } from "../../fixtures/publication.mjs";
import { validatePublicationPlan, verifyPublicationAuthority, publicationEffects,
  publicationCandidateIdentity } from "../../../scripts/publication-plan.mjs";

test("approved ordinary profile preserves producer identities and role-local client locators", () => {
  const f = publicationPlanFixture(); const p = validatePublicationPlan(f.publicationPlan, f.now);
  assert.deepEqual(p, f.publicationPlan); assert.notEqual(p, f.publicationPlan);
  assert.notEqual(p.publisher.revision, p.candidate.sourceRevision);
  assert.equal(Object.hasOwn(p.producer.verification.client, "path"), false);
  verifyPublicationAuthority(p, f.planSha256, f.authority, f.policySha256, f.now);
  const effects = publicationEffects(p);
  assert.equal(effects.length, 10); assert.equal(new Set(effects.map(x => x.identity)).size, 10);
  assert.equal(effects[0].kind, "npm-publish"); assert.equal(effects.at(-1).kind, "github-public");
  assert(effects.every(x => x.candidate === publicationCandidateIdentity(p)));
});

for (const [name, mutate] of [
  ["extra top field", p => { p.extra = true; }],
  ["expired authority", p => { p.window.deadline = p.window.start; }],
  ["future authority", p => { p.window.start = p.window.deadline; }],
  ["noncanonical time", p => { p.window.start = "2030-02-31T00:00:00.000Z"; }],
  ["version coercion", p => { p.candidate.version = [p.candidate.version]; }],
  ["preview outside ordinary profile", p => { p.candidate.version += "-preview.1"; }],
  ["different candidate source", p => { p.candidate.sourceRevision = "f".repeat(40); }],
  ["different candidate inventory", p => { p.candidate.inventorySha256 = "f".repeat(64); }],
  ["expired preparation output", p => { p.producer.data.expiresAt = p.window.start; }],
  ["unknown output field", p => { p.producer.proofs.url = "https://example.invalid"; }],
  ["same data and proof output", p => { p.producer.proofs.id = p.producer.data.id; }],
  ["unapproved verification locator", p => { p.producer.verification.client.path = "/injected"; }],
  ["short verification authority", p => { p.producer.verification.expiresAt = p.window.start; }],
  ["different publisher repository", p => { p.publisher.repository = "other/project"; }],
  ["unexpected recipe field", p => { p.publisher.branch = "main"; }],
  ["unapproved registry", p => { p.npm.registry = "https://example.invalid/"; }],
  ["restricted access", p => { p.npm.access = "restricted"; }],
  ["bootstrap of existing package", p => { p.npm.before.package = "existing"; }],
  ["republication of used version", p => { p.npm.before.version = "matching"; }],
  ["unattributed observation mode", p => { p.npm.mode = "observe"; }],
  ["different GitHub target", p => { p.github.repository = "other/project"; }],
  ["wrong tag", p => { p.github.tag = "v9.0.0"; }],
  ["unknown latest selection", p => { delete p.github.latest; }],
  ["wrong existing tag source", p => { p.github.before.tagRevision = "f".repeat(40); }],
  ["duplicate asset name", p => { p.github.assets[1].name = p.github.assets[0].name; }],
  ["missing inventory proof asset", p => { p.github.assets = p.github.assets.filter(x => x.kind !== "inventory-proof"); }],
  ["asset traversal", p => { p.github.assets[0].name = "../archive.tgz"; }],
  ["unknown asset field", p => { p.github.assets[0].uri = "https://example.invalid"; }],
  ["repeated browser", p => { p.qualification.browsers.push("Chrome"); }],
  ["self continuation", p => { p.continuation = { operation: p.operation, evidenceSha256: "a".repeat(64) }; }],
]) test(`publication plan rejects ${name}`, () => {
  const f = publicationPlanFixture(); mutate(f.publicationPlan);
  assert.throws(() => validatePublicationPlan(f.publicationPlan, f.now));
});

test("new ordinary versions use OIDC; matching versions require an explicit read-only continuation", () => {
  const f = publicationPlanFixture(); const p = f.publicationPlan;
  p.npm.mode = "oidc"; p.npm.before.package = "existing"; p.npm.before.channel = "0.8.0";
  validatePublicationPlan(p, f.now);
  p.npm.before.version = "matching"; p.npm.mode = "observe";
  p.continuation = { operation: "e".repeat(64), evidenceSha256: "f".repeat(64) };
  validatePublicationPlan(p, f.now);
  p.npm.mode = "oidc";
  assert.throws(() => validatePublicationPlan(p, f.now), { code: "PUBLICATION_NPM_INVALID" });
});

for (const field of ["planSha256", "authority", "owner", "writerPolicySha256", "repository", "workflow", "revision", "runId", "runAttempt", "approved"]) {
  test(`authority ${field} cannot be omitted or replaced`, () => {
    const f = publicationPlanFixture(); const a = structuredClone(f.authority);
    a[field] = field === "approved" ? false : "unapproved";
    assert.throws(() => verifyPublicationAuthority(f.publicationPlan, f.planSha256, a, f.policySha256, f.now),
      { code: "PUBLICATION_AUTHORITY_INVALID" });
    delete a[field];
    assert.throws(() => verifyPublicationAuthority(f.publicationPlan, f.planSha256, a, f.policySha256, f.now),
      { code: "PUBLICATION_AUTHORITY_INVALID" });
  });
}

test("effect identity binds every asset and proof but permits a new approved continuation window", () => {
  const f = publicationPlanFixture(); const before = publicationEffects(f.publicationPlan);
  const p = structuredClone(f.publicationPlan); p.window.deadline = new Date(f.now + 40 * 60 * 1000).toISOString();
  assert.deepEqual(publicationEffects(p), before);
  p.producer.archiveProofSha256 = "e".repeat(64);
  assert.notEqual(publicationCandidateIdentity(p), publicationCandidateIdentity(f.publicationPlan));
  assert(publicationEffects(p).every((x, i) => x.identity !== before[i].identity));
});
