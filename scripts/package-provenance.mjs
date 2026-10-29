import { isDeepStrictEqual } from "node:util";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PackageArtifactError, stagePackageArchive, validatePackageEvidence, verifyPackageDirectory } from "./package-artifact.mjs";
import { identifyProvenanceClient, verifyProvenanceBundle, ProvenanceError,
  provenanceDigest as hash, requireProvenance as requireProof } from "./provenance-client.mjs";

const sha = /^[0-9a-f]{64}$/;
const commit = /^[0-9a-f]{40}$/;
const sha512 = /^[0-9a-f]{128}$/;
const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const workflowPath = /^\.github\/workflows\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ya?ml$/;
const predicateType = "https://slsa.dev/provenance/v1";
const buildType = "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function matches(pattern, value) { return typeof value === "string" && pattern.test(value); }

function parse(bytes, code) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new ProvenanceError(code, "Provenance input is not valid JSON."); }
}

/** Trusted expectation input; identity is never learned from the checked bundle. */
export function validateProvenancePlan(input, now = Date.now()) {
  const plan = structuredClone(input);
  requireProof(exactKeys(plan, ["schemaVersion", "expiresAt", "trustRootSha256", "client", "limits", "identity",
    "candidate", "ciEvidenceSha256", "inventorySubject"]) && plan.schemaVersion === 1,
  "PLAN_INVALID", "The provenance plan has an unsupported shape.");
  requireProof(typeof plan.expiresAt === "string" && Number.isFinite(Date.parse(plan.expiresAt))
    && new Date(plan.expiresAt).toISOString() === plan.expiresAt
    && Date.parse(plan.expiresAt) > now && matches(sha, plan.trustRootSha256) && matches(sha, plan.ciEvidenceSha256)
    && matches(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/, plan.inventorySubject),
  "PLAN_INVALID", "The provenance plan is expired or has invalid identities.");
  requireProof(exactKeys(plan.client, ["path", "version", "sha256"]) && typeof plan.client.path === "string"
    && isAbsolute(plan.client.path) && typeof plan.client.version === "string" && matches(sha, plan.client.sha256),
  "PLAN_INVALID", "The provenance plan lacks an explicit client identity.");
  requireProof(exactKeys(plan.limits, ["timeoutMs", "maxOutputBytes"])
    && Number.isSafeInteger(plan.limits.timeoutMs) && plan.limits.timeoutMs > 0 && plan.limits.timeoutMs <= 2147483647
    && Number.isSafeInteger(plan.limits.maxOutputBytes) && plan.limits.maxOutputBytes > 0,
  "PLAN_INVALID", "The provenance client bounds are invalid.");
  requireProof(exactKeys(plan.candidate, ["inventorySha256", "archiveSha512"])
    && matches(sha, plan.candidate.inventorySha256) && matches(sha512, plan.candidate.archiveSha512),
  "PLAN_INVALID", "The provenance plan lacks exact candidate identities.");
  const i = plan.identity;
  requireProof(exactKeys(i, ["repository", "repositoryId", "ownerId", "sourceRevision", "sourceRef", "workflowPath",
    "workflowRevision", "signerUri", "signerRevision", "runId", "runAttempt", "event"])
    && matches(repositoryName, i.repository) && !i.repository.split("/").some(x => x === "." || x === "..")
    && [i.repositoryId, i.ownerId, i.runId, i.runAttempt].every(x => typeof x === "string" && /^[1-9][0-9]*$/.test(x))
    && matches(commit, i.sourceRevision) && i.workflowRevision === i.sourceRevision && i.sourceRef === "refs/heads/main"
    && matches(workflowPath, i.workflowPath) && matches(commit, i.signerRevision)
    && typeof i.signerUri === "string" && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml@(?:refs\/(?:heads|tags)\/[A-Za-z0-9_./-]+|[0-9a-f]{40})$/.test(i.signerUri)
    && ["push", "workflow_dispatch"].includes(i.event),
  "PLAN_INVALID", "The expected producer identity is invalid or outside the qualified profile.");
  return plan;
}

/** Preserve the producer's exact existing candidate.json encoding and inventory. */
export function readProducerInventory(bytes) {
  const candidate = parse(bytes, "INVENTORY_INVALID");
  const expected = validatePackageEvidence(candidate);
  const record = { schemaVersion: candidate.schemaVersion, sourceRevision: candidate.sourceRevision,
    name: candidate.name, version: candidate.version, private: candidate.private,
    tools: { node: candidate.tools?.node, npm: candidate.tools?.npm }, staticDirectory: candidate.staticDirectory,
    files: candidate.files.map(file => ({ path: file.path, byteLength: file.byteLength, sha256: file.sha256 })),
    tarball: { path: candidate.tarball.path, byteLength: candidate.tarball.byteLength,
      sha256: candidate.tarball.sha256, integrity: candidate.tarball.integrity } };
  requireProof(exactKeys(candidate.tools, ["node", "npm"]) && typeof candidate.tools.node === "string"
    && typeof candidate.tools.npm === "string" && typeof candidate.tarball.path === "string"
    && /^[A-Za-z0-9_.-]+\.tgz$/.test(candidate.tarball.path)
    && candidate.files.every((file, index, files) => exactKeys(file, ["path", "byteLength", "sha256"])
      && (index === 0 || files[index - 1].path < file.path))
    && exactKeys(candidate.tarball, ["path", "byteLength", "sha256", "integrity"])
    && bytes.equals(Buffer.from(`${JSON.stringify(record, null, 2)}\n`)),
  "INVENTORY_INVALID", "The inventory is not the qualified original producer encoding.");
  requireProof(/^sha512-[A-Za-z0-9+/]{86}==$/.test(expected.tarball.integrity)
    && Buffer.from(expected.tarball.integrity.slice(7), "base64").toString("base64") === expected.tarball.integrity.slice(7),
  "INVENTORY_INVALID", "The inventory lacks a canonical SHA-512 archive identity.");
  return expected;
}

/** The generator and verifier use the same two subject identities. */
export function producerProofSubjects(candidate, inventoryBytes, inventorySubject = "candidate.json") {
  return {
    archive: { name: `pkg:npm/${candidate.name.replace(/^@/, "%40")}@${candidate.version}`,
      digest: { sha512: Buffer.from(candidate.tarball.integrity.slice(7), "base64").toString("hex") } },
    inventory: { name: inventorySubject, digest: { sha256: hash(inventoryBytes) } },
  };
}

/** The caller admits this original CI evidence separately; this tool does not fetch/authenticate it. */
export function verifyProducerCiEvidence(bytes, plan, candidate) {
  requireProof(hash(bytes) === plan.ciEvidenceSha256, "CI_EVIDENCE_MISMATCH", "CI evidence differs from its admitted identity.");
  const evidence = parse(bytes, "CI_EVIDENCE_INVALID");
  requireProof(exactKeys(evidence, ["schemaVersion", "identity", "candidate", "tools", "qualification"])
    && evidence.schemaVersion === 1 && isDeepStrictEqual(evidence.identity, plan.identity)
    && isDeepStrictEqual(evidence.candidate, plan.candidate) && isDeepStrictEqual(evidence.tools, candidate.tools)
    && exactKeys(evidence.qualification, ["status", "evidenceSha256"])
    && evidence.qualification.status === "passed" && matches(sha, evidence.qualification.evidenceSha256),
  "CI_EVIDENCE_INVALID", "The admitted CI evidence does not corroborate this producer and qualified candidate.");
}

/** Validate required certificate-bound values separately from signed workflow claims. */
export function verifyProducerIdentity(result, identity, subject) {
  requireProof(result?.mediaType === "application/vnd.dev.sigstore.verificationresult+json;version=0.1"
    && Array.isArray(result.verifiedTimestamps) && result.verifiedTimestamps.length > 0
    && result.verifiedTimestamps.every(x => x !== null && typeof x === "object" && ["Tlog", "TimestampAuthority"].includes(x.type)
      && typeof x.timestamp === "string" && Number.isFinite(Date.parse(x.timestamp))),
  "CLIENT_RESULT_INVALID", "The verifier result lacks its qualified schema or authenticated time evidence.");
  const repository = `https://github.com/${identity.repository}`;
  const invocation = `${repository}/actions/runs/${identity.runId}/attempts/${identity.runAttempt}`;
  const certificate = result.signature?.certificate;
  const expected = { issuer: "https://token.actions.githubusercontent.com", subjectAlternativeName: identity.signerUri,
    buildSignerURI: identity.signerUri, buildSignerDigest: identity.signerRevision, runnerEnvironment: "github-hosted",
    sourceRepositoryURI: repository, sourceRepositoryDigest: identity.sourceRevision, sourceRepositoryRef: identity.sourceRef,
    sourceRepositoryIdentifier: identity.repositoryId, sourceRepositoryOwnerURI: `https://github.com/${identity.repository.split("/")[0]}`,
    sourceRepositoryOwnerIdentifier: identity.ownerId, buildConfigURI: `${repository}/${identity.workflowPath}@${identity.sourceRef}`,
    buildConfigDigest: identity.workflowRevision, buildTrigger: identity.event, runInvocationURI: invocation };
  requireProof(certificate !== null && typeof certificate === "object"
    && Object.entries(expected).every(([key, value]) => certificate[key] === value),
  "IDENTITY_MISMATCH", "Authenticated producer identity does not match the admitted policy.");
  const statement = result.statement;
  requireProof(statement?._type === "https://in-toto.io/Statement/v1" && statement.predicateType === predicateType
    && isDeepStrictEqual(statement.subject, [subject]),
  "SUBJECT_MISMATCH", "The verified statement has a different type or exact subject.");
  const build = statement.predicate?.buildDefinition;
  requireProof(build?.buildType === buildType && isDeepStrictEqual(build.externalParameters?.workflow,
    { path: identity.workflowPath, ref: identity.sourceRef, repository })
    && build.internalParameters?.github?.repository_id === identity.repositoryId
    && build.internalParameters?.github?.repository_owner_id === identity.ownerId
    && build.internalParameters?.github?.event_name === identity.event
    && isDeepStrictEqual(build.resolvedDependencies, [{ digest: { gitCommit: identity.sourceRevision },
      uri: `git+${repository}@${identity.sourceRef}` }])
    && statement.predicate.runDetails?.builder?.id === "https://github.com/actions/runner/github-hosted"
    && statement.predicate.runDetails?.metadata?.invocationId === invocation,
  "CLAIMS_MISMATCH", "Workflow-controlled claims do not agree with authenticated identity and trusted CI evidence.");
}

/** Check that the client verified the same original signed payload, not an unrelated result. */
export function verifyOriginalProof(bytes, result) {
  const original = parse(bytes, "BUNDLE_INVALID");
  const envelope = original?.dsseEnvelope;
  requireProof(envelope?.payloadType === "application/vnd.in-toto+json" && typeof envelope.payload === "string"
    && Array.isArray(envelope.signatures) && envelope.signatures.length === 1,
  "BUNDLE_INVALID", "The original proof is outside the single-envelope profile.");
  const payload = Buffer.from(envelope.payload, "base64");
  requireProof(payload.toString("base64") === envelope.payload
    && isDeepStrictEqual(parse(payload, "BUNDLE_INVALID"), result.statement),
  "BUNDLE_MISMATCH", "The client result does not identify the original signed statement.");
}

async function ownedInput(path, directory, name) {
  const bytes = await readFile(path);
  await writeFile(join(directory, name), bytes, { flag: "wx", mode: 0o600 });
  return bytes;
}

/**
 * Verify retained originals under separately admitted plan/trust/CI evidence.
 * Inputs are never executed or removed. Temporary copies/client state are owned
 * and removed before success. The report is safe; raw causes/proof inputs are private.
 */
export async function verifyPackageProvenance({ plan: input, archive, inventory, staticDirectory,
  archiveBundle, inventoryBundle, trustRoot, ciEvidence }) {
  const report = { schemaVersion: 1, status: "failed", phase: "plan", checks: [],
    operationalTrust: "unqualified", ciEvidenceAcquisition: "unqualified", generatorInteroperability: "unqualified",
    releaseAdmission: "unqualified", environment: { node: process.version, platform: process.platform, architecture: process.arch } };
  let directory; let failure;
  try {
    const plan = validateProvenancePlan(input);
    report.planSha256 = hash(Buffer.from(JSON.stringify(plan)));
    directory = await mkdtemp(join(tmpdir(), "tabgrad-provenance-"));
    await writeFile(join(directory, "empty-gitconfig"), "", { flag: "wx", mode: 0o600 });
    const rawInventory = await ownedInput(inventory, directory, "inventory.json");
    requireProof(hash(rawInventory) === plan.candidate.inventorySha256, "INVENTORY_MISMATCH", "Inventory bytes differ from the admitted candidate.");
    const candidate = readProducerInventory(rawInventory);
    const archiveDigest = Buffer.from(candidate.tarball.integrity.slice(7), "base64").toString("hex");
    requireProof(archiveDigest === plan.candidate.archiveSha512 && candidate.sourceRevision === plan.identity.sourceRevision,
      "CANDIDATE_MISMATCH", "The inventory identifies another archive or source.");
    const root = await ownedInput(trustRoot, directory, "trusted-root.jsonl");
    requireProof(hash(root) === plan.trustRootSha256 && root.at(-1) === 10
      && root.toString("utf8").trim().split("\n").every(line => parse(Buffer.from(line), "TRUST_INVALID")?.mediaType === "application/vnd.dev.sigstore.trustedroot+json;version=0.1"),
    "TRUST_MISMATCH", "Trust material differs from its admitted offline identity or encoding.");
    verifyProducerCiEvidence(await ownedInput(ciEvidence, directory, "ci-evidence.json"), plan, candidate);
    const archiveProof = await ownedInput(archiveBundle, directory, "archive-proof.json");
    const inventoryProof = await ownedInput(inventoryBundle, directory, "inventory-proof.json");
    report.identities = { inventorySha256: hash(rawInventory), archiveSha512: archiveDigest, trustRootSha256: hash(root),
      ciEvidenceSha256: plan.ciEvidenceSha256, archiveBundleSha256: hash(archiveProof), inventoryBundleSha256: hash(inventoryProof) };
    report.checks.push("admitted-input-identities", "original-inventory-encoding", "admitted-ci-corroboration");
    report.phase = "contents";
    const staged = await stagePackageArchive(archive, candidate, directory);
    const staticFiles = candidate.files.filter(file => file.path.startsWith("dist/"))
      .map(file => ({ ...file, path: file.path.slice(5) }));
    await verifyPackageDirectory(staticDirectory, staticFiles);
    report.checks.push("complete-archive-contents", "complete-static-contents");
    report.phase = "client";
    const client = await identifyProvenanceClient(plan.client, plan.limits, directory);
    report.client = { version: client.version, sha256: client.sha256 };
    report.checks.push("admitted-qualified-client");
    const subjects = producerProofSubjects(candidate, rawInventory, plan.inventorySubject);
    for (const [kind, artifact, bundle, original, algorithm, subject] of [
      ["archive", staged.tarball, join(directory, "archive-proof.json"), archiveProof, "sha512",
        subjects.archive],
      ["inventory", join(directory, "inventory.json"), join(directory, "inventory-proof.json"), inventoryProof, "sha256",
        subjects.inventory],
    ]) {
      report.phase = `${kind}-proof`;
      validateProvenancePlan(plan);
      const result = await verifyProvenanceBundle(client, { artifact, bundle, trustRoot: join(directory, "trusted-root.jsonl"),
        algorithm, identity: plan.identity, limits: plan.limits, directory });
      verifyOriginalProof(original, result);
      report.checks.push(`${kind}-signature`);
      verifyProducerIdentity(result, plan.identity, subject);
      report.checks.push(`${kind}-identity-and-claims`);
    }
    requireProof(hash(await readFile(client.path)) === client.sha256, "CLIENT_MISMATCH", "The admitted client changed during verification.");
    validateProvenancePlan(plan);
    report.status = "passed";
  } catch (error) { failure = error; }
  if (directory !== undefined) {
    try { await rm(directory, { recursive: true, force: true }); report.cleanup = "completed"; }
    catch (error) { if (failure !== undefined) failure.cleanupError = error; else failure = error; report.cleanup = "failed"; }
  }
  if (failure !== undefined) {
    report.status = "failed";
    const safe = failure instanceof ProvenanceError || failure instanceof PackageArtifactError;
    report.failure = { code: safe ? failure.code : "VERIFICATION_FAILED",
      message: safe ? failure.message : "Retained producer verification failed." };
    const error = new ProvenanceError(report.failure.code, report.failure.message);
    error.cause = failure; error.report = report;
    throw error;
  }
  report.phase = "complete";
  return report;
}

async function main(arguments_) {
  let report;
  let planBytes;
  try {
    requireProof(arguments_.length === 8, "USAGE_INVALID", "Expected plan, archive, inventory, static tree, archive proof, inventory proof, trust root and CI evidence paths.");
    const [planPath, archive, inventory, staticDirectory, archiveBundle, inventoryBundle, trustRoot, ciEvidence] = arguments_;
    planBytes = await readFile(planPath);
    report = await verifyPackageProvenance({ plan: parse(planBytes, "PLAN_INVALID"), archive, inventory, staticDirectory,
      archiveBundle, inventoryBundle, trustRoot, ciEvidence });
  } catch (error) {
    report = error.report ?? { schemaVersion: 1, status: "failed", phase: "inputs", checks: [],
      failure: { code: error instanceof ProvenanceError ? error.code : "INPUT_FAILED", message: "Retained producer inputs could not be verified." } };
    process.exitCode = 1;
  }
  if (planBytes !== undefined) report.planInputSha256 = hash(planBytes);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
