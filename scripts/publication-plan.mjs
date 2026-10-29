import { isDeepStrictEqual } from "node:util";
import { canonicalBytes, sha256 } from "./release-record-data.mjs";
import { validateProvenancePlan } from "./package-provenance.mjs";

const digest = /^[0-9a-f]{64}$/;
const commit = /^[0-9a-f]{40}$/;
const id = /^[1-9][0-9]*$/;
const ordinaryVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const repository = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const workflow = /^\.github\/workflows\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ya?ml$/;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const assetName = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);

export class PublicationError extends Error {
  constructor(code, options) { super(code, options); this.name = "PublicationError"; this.code = code; }
}

export function requirePublication(condition, code) { if (!condition) throw new PublicationError(code); }

export function exactPublicationKeys(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function instant(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function output(value, deadline) {
  return exactPublicationKeys(value, ["id", "sha256", "expiresAt"])
    && matches(id, value.id) && matches(digest, value.sha256) && instant(value.expiresAt)
    && Date.parse(deadline) <= Date.parse(value.expiresAt);
}

/** The caller admits the original plan digest separately; this parser supplies no authority. */
export function validatePublicationPlan(input, now = Date.now()) {
  const p = structuredClone(input);
  requirePublication(exactPublicationKeys(p, ["schemaVersion", "operation", "authority", "owner", "window",
    "candidate", "producer", "publisher", "npm", "github", "qualification", "continuation"])
    && p.schemaVersion === 1 && [p.operation, p.authority, p.owner].every(value => matches(digest, value)),
  "PUBLICATION_PLAN_INVALID");
  requirePublication(exactPublicationKeys(p.window, ["start", "deadline"])
    && instant(p.window.start) && instant(p.window.deadline)
    && Date.parse(p.window.start) <= now && now < Date.parse(p.window.deadline), "PUBLICATION_WINDOW_INVALID");
  requirePublication(exactPublicationKeys(p.candidate, ["name", "version", "sourceRevision", "inventorySha256", "archiveSha512"])
    && matches(packageName, p.candidate.name) && matches(ordinaryVersion, p.candidate.version)
    && matches(commit, p.candidate.sourceRevision) && matches(digest, p.candidate.inventorySha256)
    && matches(/^[0-9a-f]{128}$/, p.candidate.archiveSha512), "PUBLICATION_CANDIDATE_INVALID");
  const producer = p.producer;
  requirePublication(exactPublicationKeys(producer, ["verification", "signingDeadline", "archiveProofSha256", "inventoryProofSha256", "data", "proofs", "corroboration"])
    && matches(digest, producer.archiveProofSha256) && matches(digest, producer.inventoryProofSha256)
    && instant(producer.signingDeadline)
    && [producer.data, producer.proofs, producer.corroboration].every(value => output(value, p.window.deadline))
    && new Set([producer.data.id, producer.proofs.id, producer.corroboration.id]).size === 3, "PUBLICATION_PRODUCER_INVALID");
  // Filesystem locations are role-local; the approved verification identity excludes only that locator.
  requirePublication(exactPublicationKeys(producer.verification, ["schemaVersion", "expiresAt", "trustRootSha256", "client",
    "limits", "identity", "candidate", "ciEvidenceSha256", "inventorySubject"])
    && exactPublicationKeys(producer.verification.client, ["version", "sha256"]), "PUBLICATION_PRODUCER_INVALID");
  const proofPlan = validateProvenancePlan({ ...producer.verification,
    client: { ...producer.verification.client, path: "/role-local-verification-client" } }, now);
  requirePublication(proofPlan.identity.sourceRevision === p.candidate.sourceRevision
    && proofPlan.candidate.inventorySha256 === p.candidate.inventorySha256
    && proofPlan.candidate.archiveSha512 === p.candidate.archiveSha512
    && Date.parse(p.window.deadline) <= Date.parse(proofPlan.expiresAt), "PUBLICATION_PRODUCER_INVALID");
  requirePublication(exactPublicationKeys(p.publisher, ["repository", "workflow", "revision", "clientSha256", "githubClientSha256"])
    && p.publisher.repository === proofPlan.identity.repository && matches(repository, p.publisher.repository)
    && matches(workflow, p.publisher.workflow) && matches(commit, p.publisher.revision)
    && matches(digest, p.publisher.clientSha256) && matches(digest, p.publisher.githubClientSha256),
  "PUBLICATION_RECIPE_INVALID");
  requirePublication(exactPublicationKeys(p.npm, ["registry", "channel", "access", "mode", "before"])
    && p.npm.registry === "https://registry.npmjs.org/" && matches(/^[a-z][a-z0-9._-]*$/, p.npm.channel)
    && p.npm.access === "public" && ["bootstrap", "oidc", "observe"].includes(p.npm.mode)
    && exactPublicationKeys(p.npm.before, ["package", "version", "channel"])
    && ["absent", "existing"].includes(p.npm.before.package)
    && ["absent", "matching"].includes(p.npm.before.version)
    && (p.npm.before.channel === null || matches(ordinaryVersion, p.npm.before.channel))
    && (p.npm.before.package !== "absent" || (p.npm.before.version === "absent" && p.npm.before.channel === null))
    && (p.npm.mode !== "bootstrap" || p.npm.before.package === "absent")
    && (p.npm.mode === "observe" ? p.npm.before.version === "matching" && p.continuation !== null
      : p.npm.before.version === "absent"), "PUBLICATION_NPM_INVALID");
  requirePublication(exactPublicationKeys(p.github, ["repository", "tag", "prerelease", "latest", "notesSha256", "assets", "before"])
    && p.github.repository === proofPlan.identity.repository && p.github.tag === `v${p.candidate.version}`
    && p.github.prerelease === false && typeof p.github.latest === "boolean" && matches(digest, p.github.notesSha256)
    && exactPublicationKeys(p.github.before, ["tagRevision", "releaseId"])
    && (p.github.before.tagRevision === null || p.github.before.tagRevision === p.candidate.sourceRevision)
    && (p.github.before.releaseId === null || matches(id, p.github.before.releaseId))
    && Array.isArray(p.github.assets) && p.github.assets.length === 6, "PUBLICATION_GITHUB_INVALID");
  const assetNames = new Set();
  const kinds = new Set();
  let assetBytes = 0;
  for (const a of p.github.assets) {
    requirePublication(exactPublicationKeys(a, ["name", "kind", "byteLength", "sha256"])
      && matches(assetName, a.name) && !assetNames.has(a.name)
      && ["archive", "inventory", "archive-proof", "inventory-proof", "evidence", "checksums"].includes(a.kind)
      && Number.isSafeInteger(a.byteLength) && a.byteLength > 0 && matches(digest, a.sha256), "PUBLICATION_ASSET_INVALID");
    assetNames.add(a.name); kinds.add(a.kind);
    assetBytes += a.byteLength;
  }
  requirePublication(["archive", "inventory", "archive-proof", "inventory-proof", "evidence", "checksums"]
    .every(kind => kinds.has(kind)) && assetBytes <= 128 * 1024 * 1024, "PUBLICATION_ASSET_INVALID");
  requirePublication(exactPublicationKeys(p.qualification, ["browsers", "gpu", "evidenceSha256"])
    && Array.isArray(p.qualification.browsers) && p.qualification.browsers.length > 0
    && new Set(p.qualification.browsers).size === p.qualification.browsers.length
    && p.qualification.browsers.every(browser => ["Chrome", "Firefox"].includes(browser))
    && typeof p.qualification.gpu === "boolean" && matches(digest, p.qualification.evidenceSha256),
  "PUBLICATION_QUALIFICATION_INVALID");
  requirePublication(p.continuation === null || (exactPublicationKeys(p.continuation, ["operation", "evidenceSha256"])
    && matches(digest, p.continuation.operation) && matches(digest, p.continuation.evidenceSha256)
    && p.continuation.operation !== p.operation), "PUBLICATION_CONTINUATION_INVALID");
  return p;
}

/** Bind contents, not a transport artifact or the operation's journal identifier. */
export function publicationCandidateIdentity(plan) {
  return sha256(canonicalBytes({ candidate: plan.candidate, producer: { identity: plan.producer.verification.identity,
    signingDeadline: plan.producer.signingDeadline, archiveProofSha256: plan.producer.archiveProofSha256,
    inventoryProofSha256: plan.producer.inventoryProofSha256 } }));
}

/** Retained controller observation, not a self-authenticating approval token. */
export function publicationAuthorityDocument(plan, execution) {
  return { schemaVersion: 1, approval: plan.authority, publicationPlanSha256: sha256(canonicalBytes(plan)), execution };
}

export function publicationEffects(plan) {
  const common = { repository: plan.github.repository, version: plan.candidate.version,
    candidate: publicationCandidateIdentity(plan) };
  const effects = [
    { kind: "npm-publish", ...common, registry: plan.npm.registry, name: plan.candidate.name,
      channel: plan.npm.channel, access: plan.npm.access },
    { kind: "github-tag", ...common, tag: plan.github.tag, sourceRevision: plan.candidate.sourceRevision },
    { kind: "github-draft", ...common, tag: plan.github.tag, notesSha256: plan.github.notesSha256,
      prerelease: plan.github.prerelease, latest: plan.github.latest },
    ...plan.github.assets.map(asset => ({ kind: "github-asset", ...common, tag: plan.github.tag, asset })),
    { kind: "github-public", ...common, tag: plan.github.tag, notesSha256: plan.github.notesSha256,
      prerelease: plan.github.prerelease, latest: plan.github.latest },
  ];
  return effects.map(effect => ({ ...effect, identity: sha256(canonicalBytes(effect)) }));
}

/** Independent provider/controller observation; a supplied matching sidecar is not authentication. */
export function verifyPublicationAuthority(plan, planSha256, observation, expectedPolicySha256, now = Date.now()) {
  requirePublication(matches(digest, planSha256) && matches(digest, expectedPolicySha256)
    && exactPublicationKeys(observation, ["schemaVersion", "planSha256", "authority", "owner", "window",
    "writerPolicySha256", "repository", "workflow", "revision", "runId", "runAttempt", "approved"])
    && observation.schemaVersion === 1 && observation.planSha256 === planSha256
    && observation.authority === plan.authority && observation.owner === plan.owner
    && isDeepStrictEqual(observation.window, plan.window)
    && observation.writerPolicySha256 === expectedPolicySha256
    && observation.repository === plan.publisher.repository && observation.workflow === plan.publisher.workflow
    && observation.revision === plan.publisher.revision && matches(id, observation.runId)
    && matches(id, observation.runAttempt) && observation.approved === true
    && Date.parse(plan.window.start) <= now && now < Date.parse(plan.window.deadline), "PUBLICATION_AUTHORITY_INVALID");
}
