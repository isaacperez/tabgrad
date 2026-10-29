import { provenanceFixture, producerIdentity } from "./package-provenance.mjs";

/** Pure plan data: schema controls do not need to pack/install an archive. */
export function publicationPlanFixture(options = {}) {
  const now = Date.now();
  const candidate = options.candidate ?? { name: "@example/candidate", version: "0.9.7", sourceRevision: "a".repeat(40) };
  const verification = options.verification ?? { schemaVersion: 1, expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
    trustRootSha256: "a".repeat(64), client: { version: "2.102.0", sha256: "b".repeat(64) },
    limits: { timeoutMs: 10000, maxOutputBytes: 50000 }, identity: producerIdentity(),
    candidate: { inventorySha256: "c".repeat(64), archiveSha512: "d".repeat(128) },
    ciEvidenceSha256: "e".repeat(64), inventorySubject: "candidate.json" };
  const { path: _path, ...client } = verification.client;
  const assets = ["archive", "inventory", "archive-proof", "inventory-proof", "evidence", "checksums"]
    .map((kind, i) => ({ name: `fixture-${kind}.json`, kind, byteLength: 1, sha256: String(i + 1).repeat(64) }));
  const plan = { schemaVersion: 1, operation: "1".repeat(64), authority: "2".repeat(64), owner: "3".repeat(64),
    window: { start: new Date(now - 1000).toISOString(), deadline: new Date(now + 30 * 60 * 1000).toISOString() },
    candidate: { name: candidate.name, version: candidate.version, sourceRevision: candidate.sourceRevision,
      ...verification.candidate },
    producer: { verification: { ...verification, client }, signingDeadline: verification.expiresAt, archiveProofSha256: "4".repeat(64),
      inventoryProofSha256: "5".repeat(64),
      data: { id: "211", sha256: "6".repeat(64), expiresAt: verification.expiresAt },
      proofs: { id: "212", sha256: "7".repeat(64), expiresAt: verification.expiresAt },
      corroboration: { id: "213", sha256: "8".repeat(64), expiresAt: verification.expiresAt } },
    publisher: { repository: verification.identity.repository, workflow: ".github/workflows/release-publication.yml",
      revision: "b".repeat(40), clientSha256: "8".repeat(64), githubClientSha256: "9".repeat(64) },
    npm: { registry: "https://registry.npmjs.org/", channel: "latest", access: "public", mode: "bootstrap",
      before: { package: "absent", version: "absent", channel: null } },
    github: { repository: verification.identity.repository, tag: `v${candidate.version}`, prerelease: false,
      latest: true, notesSha256: "a".repeat(64), assets, before: { tagRevision: null, releaseId: null } },
    qualification: { browsers: ["Chrome", "Firefox"], gpu: false, evidenceSha256: "b".repeat(64) }, continuation: null };
  const policySha256 = "c".repeat(64);
  const planSha256 = "d".repeat(64);
  const authority = { schemaVersion: 1, planSha256, authority: plan.authority, owner: plan.owner,
    window: structuredClone(plan.window), writerPolicySha256: policySha256, repository: plan.publisher.repository,
    workflow: plan.publisher.workflow, revision: plan.publisher.revision, runId: "301", runAttempt: "1", approved: true };
  return { publicationPlan: plan, authority, policySha256, planSha256, now };
}

export async function publicationFixture(context) {
  const f = await provenanceFixture(context);
  return { ...f, ...publicationPlanFixture({ candidate: f.candidate, verification: f.paths.plan }) };
}
