import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { qualifiedProvenanceClient, identifyProvenanceClient, verifyProvenanceBundle, provenanceDigest as hash,
  ProvenanceError, requireProvenance as requireProof } from "./provenance-client.mjs";
import { verifyOriginalProof, verifyProducerIdentityClaims } from "./package-provenance.mjs";

/** Fixed mapping of the identified upstream fixtures; not a candidate policy fallback. */
export function verifyClientFixtureIdentity(result, identity, subject) {
  verifyProducerIdentityClaims(result, identity, subject,
    "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
    "https://github.com/actions/runner/github-hosted");
}

async function checkRejection(client, options, mutate, name, report, privateEvidence) {
  const changed = await mutate({ ...options, identity: structuredClone(options.identity) });
  let failure;
  try { await verifyProvenanceBundle(client, changed); }
  catch (error) { failure = error; }
  requireProof(failure instanceof ProvenanceError && failure.code === "CLIENT_REJECTED",
    "CONTROL_FAILED", "An actual-client corruption control did not reject as expected.");
  report.checks.push({ name, status: "rejected-as-required", code: failure.code });
  privateEvidence.push({ name, originalClientFailure: failure.privateClientEvidence });
}

/**
 * Specialized actual-client qualification. Fixtures are separately prepared,
 * identified upstream originals, never downloaded/installed/executed here.
 * The CLI emits only report; privateEvidence belongs to the local investigator.
 */
export async function qualifyProvenanceClient({ clientPath, clientSha256, fixturesDirectory }) {
  const manifest = JSON.parse(await readFile(new URL("../js-tests/fixtures/provenance-client.json", import.meta.url), "utf8"));
  const directory = await mkdtemp(join(tmpdir(), "tabgrad-provenance-client-"));
  const report = { schemaVersion: 1, status: "failed", input: "upstream-offline-client-fixtures", checks: [],
    sourceRevision: manifest.revision, environment: { node: process.version, platform: process.platform, architecture: process.arch },
    tabgradSignedPair: "unqualified", operationalTrust: "unqualified", publication: "unqualified" };
  const privateEvidence = [];
  let failure;
  try {
    await writeFile(join(directory, "empty-gitconfig"), "", { flag: "wx", mode: 0o600 });
    for (const file of manifest.files) {
      const bytes = await readFile(join(fixturesDirectory, file.name));
      requireProof(bytes.length === file.bytes && hash(bytes) === file.sha256,
        "FIXTURE_MISMATCH", "An upstream fixture differs from the identified original.");
      await writeFile(join(directory, file.name), bytes, { flag: "wx", mode: 0o600 });
    }
    report.checks.push({ name: "original-upstream-fixture-identities", status: "passed" });
    // gh expects JSONL. Preserve the original fixture; identify this local derivative.
    const root = Buffer.from(`${JSON.stringify(JSON.parse(await readFile(join(directory, "trusted_root.json"), "utf8")))}\n`);
    const trustRoot = join(directory, "trusted-root.jsonl");
    await writeFile(trustRoot, root, { flag: "wx", mode: 0o600 });
    report.derivedTrustRootSha256 = hash(root);
    const limits = { timeoutMs: 15000, maxOutputBytes: 1024 * 1024 };
    const client = await identifyProvenanceClient({ path: clientPath, sha256: clientSha256, version: qualifiedProvenanceClient }, limits, directory);
    report.client = { version: client.version, sha256: client.sha256 };
    for (const entry of manifest.cases) {
      const options = { artifact: join(directory, entry.artifact), bundle: join(directory, entry.bundle), trustRoot,
        algorithm: entry.algorithm, identity: entry.identity, limits, directory };
      const result = await verifyProvenanceBundle(client, options);
      const original = await readFile(options.bundle);
      verifyOriginalProof(original, result);
      verifyClientFixtureIdentity(result, entry.identity, entry.subject);
      report.checks.push({ name: `${entry.name}-actual-signature-and-policy-mapping`, status: "passed" });
      for (const [field, value] of [["repositoryId", "1"], ["ownerId", "1"], ["runId", "1"], ["runAttempt", "999"]]) {
        assert.throws(() => verifyClientFixtureIdentity(result, { ...entry.identity, [field]: value }, entry.subject),
          { code: "IDENTITY_MISMATCH" });
        report.checks.push({ name: `${entry.name}-independent-${field}`, status: "rejected-as-required" });
      }
      assert.throws(() => verifyClientFixtureIdentity(result, entry.identity, { ...entry.subject, name: "unapproved-subject" }),
        { code: "SUBJECT_MISMATCH" });
      report.checks.push({ name: `${entry.name}-exact-subject-name`, status: "rejected-as-required" });
      await checkRejection(client, options, async value => {
        const path = join(directory, `${entry.name}-wrong-artifact`);
        await writeFile(path, Buffer.concat([await readFile(value.artifact), Buffer.from("changed")]));
        return { ...value, artifact: path };
      }, `${entry.name}-changed-artifact`, report, privateEvidence);
      await checkRejection(client, options, async value => {
        const bundle = JSON.parse(original);
        const signature = bundle.dsseEnvelope.signatures[0];
        const bytes = Buffer.from(signature.sig, "base64"); bytes[0] ^= 1;
        signature.sig = bytes.toString("base64");
        const path = join(directory, `${entry.name}-wrong-signature.json`);
        await writeFile(path, JSON.stringify(bundle));
        return { ...value, bundle: path };
      }, `${entry.name}-changed-signature`, report, privateEvidence);
      await checkRejection(client, options, async value => {
        const bundle = JSON.parse(original);
        const payload = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64"));
        payload.subject[0].name = "changed";
        bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(payload)).toString("base64");
        const path = join(directory, `${entry.name}-wrong-payload.json`);
        await writeFile(path, JSON.stringify(bundle));
        return { ...value, bundle: path };
      }, `${entry.name}-changed-signed-payload`, report, privateEvidence);
      await checkRejection(client, options, async value => ({ ...value,
        identity: { ...value.identity, signerUri: "https://github.com/example/project/.github/workflows/unapproved.yml@refs/heads/main" } }),
      `${entry.name}-wrong-signer`, report, privateEvidence);
      await checkRejection(client, options, async value => ({ ...value,
        identity: { ...value.identity, sourceRevision: "f".repeat(40) } }),
      `${entry.name}-wrong-source`, report, privateEvidence);
      await checkRejection(client, options, async value => ({ ...value,
        identity: { ...value.identity, sourceRef: "refs/heads/Main" } }),
      `${entry.name}-source-ref-case`, report, privateEvidence);
      await checkRejection(client, options, async value => ({ ...value,
        identity: { ...value.identity, signerUri: `${value.identity.signerUri}-lookalike` } }),
      `${entry.name}-signer-prefix-lookalike`, report, privateEvidence);
      await checkRejection(client, options, async value => {
        const wrongRoot = JSON.parse(root); wrongRoot.certificateAuthorities = [];
        const path = join(directory, `${entry.name}-no-authorities.jsonl`);
        await writeFile(path, `${JSON.stringify(wrongRoot)}\n`);
        return { ...value, trustRoot: path };
      }, `${entry.name}-missing-trusted-authorities`, report, privateEvidence);
    }
    requireProof(hash(await readFile(client.path)) === client.sha256, "CLIENT_MISMATCH", "The admitted client changed during qualification.");
    report.status = "passed";
  } catch (error) { failure = error; }
  try { await rm(directory, { recursive: true, force: true }); report.cleanup = "completed"; }
  catch (error) {
    if (failure !== undefined) failure.cleanupError = error; else failure = error;
    report.cleanup = "failed";
  }
  if (failure !== undefined) {
    report.status = "failed"; failure.report = report; failure.privateQualificationEvidence = privateEvidence;
    throw failure;
  }
  return { report, privateEvidence };
}

async function main(arguments_) {
  let report;
  try {
    requireProof(arguments_.length === 3, "USAGE_INVALID", "Expected prepared client path, admitted binary SHA-256 and prepared fixture directory.");
    ({ report } = await qualifyProvenanceClient({ clientPath: arguments_[0], clientSha256: arguments_[1], fixturesDirectory: arguments_[2] }));
  } catch (error) {
    report = error.report ?? { schemaVersion: 1, status: "failed", checks: [] };
    report.status = "failed";
    report.failure = { code: error instanceof ProvenanceError ? error.code : "QUALIFICATION_FAILED",
      message: "Offline provenance-client qualification failed." };
    process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
