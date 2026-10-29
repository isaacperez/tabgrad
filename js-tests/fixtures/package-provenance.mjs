import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { packageFixture, hash, sourceRevision } from "./package-candidate.mjs";

/** Synthetic adapter evidence only: these envelopes are not cryptographic proofs. */
export function producerIdentity() {
  return { repository: "example/project", repositoryId: "17", ownerId: "23", sourceRevision,
    sourceRef: "refs/heads/main", workflowPath: ".github/workflows/prepare.yml", workflowRevision: sourceRevision,
    signerUri: "https://github.com/example/signing/.github/workflows/sign.yml@refs/heads/main",
    signerRevision: "b".repeat(40), runId: "131", runAttempt: "2", event: "workflow_dispatch" };
}

/** Controlled report data only; it does not assert that a browser was executed. */
export function controlledConsumerReport(candidate, inventoryBytes, { input = "supplied-archive", gpu = false,
  browsers = gpu ? ["Chrome"] : ["Chrome", "Firefox"] } = {}) {
  const profiles = gpu ? ["gpu", "origin"] : ["direct", "python", "prerequisite"];
  return { schemaVersion: 1, status: "passed", input, expectedEvidenceSha256: hash(inventoryBytes),
    requested: { gpu, browsers, profiles },
    checks: ["archive-identity", "archive-structure", "metadata-and-source", "installed-inventory",
      "public-entries", "public-types", "cpu-assets", "static-inventory",
      ...(input === "registry-version" ? ["supplied-archive-installation"] : [])],
    profiles: browsers.flatMap(browser => profiles.map(mode => ({ browser, mode, status: "passed", version: "finite-fixture" }))),
    candidate: { name: candidate.name, version: candidate.version, private: candidate.private,
      sourceRevision: candidate.sourceRevision, files: candidate.files.length, archive: { ...candidate.tarball } } };
}

export function controlledVerifiedResult(identity, subject) {
  const repository = `https://github.com/${identity.repository}`;
  const invocation = `${repository}/actions/runs/${identity.runId}/attempts/${identity.runAttempt}`;
  return { mediaType: "application/vnd.dev.sigstore.verificationresult+json;version=0.1",
    signature: { certificate: { issuer: "https://token.actions.githubusercontent.com",
      subjectAlternativeName: identity.signerUri, buildSignerURI: identity.signerUri,
      buildSignerDigest: identity.signerRevision, runnerEnvironment: "github-hosted",
      sourceRepositoryURI: repository, sourceRepositoryDigest: identity.sourceRevision,
      sourceRepositoryRef: identity.sourceRef, sourceRepositoryIdentifier: identity.repositoryId,
      sourceRepositoryOwnerURI: `https://github.com/${identity.repository.split("/")[0]}`,
      sourceRepositoryOwnerIdentifier: identity.ownerId,
      buildConfigURI: `${repository}/${identity.workflowPath}@${identity.sourceRef}`,
      buildConfigDigest: identity.workflowRevision, buildTrigger: identity.event, runInvocationURI: invocation } },
    verifiedTimestamps: [{ type: "Tlog", timestamp: "2026-01-01T00:00:00Z" }],
    statement: { _type: "https://in-toto.io/Statement/v1", subject: [subject], predicateType: "https://slsa.dev/provenance/v1",
      predicate: { buildDefinition: { buildType: "https://actions.github.io/buildtypes/workflow/v1",
        externalParameters: { workflow: { path: identity.workflowPath, ref: identity.sourceRef, repository } },
        internalParameters: { github: { repository_id: identity.repositoryId, repository_owner_id: identity.ownerId,
          event_name: identity.event, runner_environment: "github-hosted" } },
        resolvedDependencies: [{ digest: { gitCommit: identity.sourceRevision }, uri: `git+${repository}@${identity.sourceRef}` }] },
      runDetails: { builder: { id: identity.signerUri }, metadata: { invocationId: invocation } } } } };
}

const adapterSource = `#!NODE
import { readFileSync, writeFileSync } from "node:fs";
const model = JSON.parse(readFileSync(new URL("./client-model.json", import.meta.url)));
if (process.argv[2] === "--version") { console.log("gh version " + (model.version ?? "2.102.0") + " (controlled adapter)"); }
else {
  writeFileSync(new URL("./client-observation.json", import.meta.url), JSON.stringify({arguments:process.argv.slice(2), environment:process.env, directory:process.cwd()}));
  if (model.mode === "timeout") await new Promise(() => setInterval(() => {}, 1000));
  else if (model.mode === "output") process.stdout.write("x".repeat(100000));
  else if (model.mode === "stderr-output") process.stderr.write("x".repeat(100000));
  else if (model.mode === "reject" || model.mode === "reject-inventory" && process.argv.includes("sha256")) { process.stderr.write("PRIVATE CLIENT DETAILS"); process.exitCode = 9; }
  else if (model.mode === "invalid-json") console.log("PRIVATE CLIENT DETAILS");
  else {
    const kind = process.argv.includes("sha512") ? "archive" : "inventory";
    console.log(JSON.stringify(model.resultOverride ?? [{verificationResult:model[kind]}]));
  }
}
`;

export async function provenanceFixture(context) {
  const fixture = await packageFixture(context);
  const c = fixture.expected;
  const candidate = { schemaVersion: 1, sourceRevision: c.sourceRevision, name: c.name, version: c.version,
    private: c.private, tools: { node: process.version, npm: "11.1.0" }, staticDirectory: c.staticDirectory,
    files: c.files.toSorted((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
      .map(x => ({ path: x.path, byteLength: x.byteLength, sha256: x.sha256 })),
    tarball: { path: c.tarball.path, byteLength: c.tarball.byteLength, sha256: c.tarball.sha256, integrity: c.tarball.integrity } };
  const inventory = join(fixture.directory, "candidate.json");
  const bytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  await writeFile(inventory, bytes);
  const clientPath = join(fixture.directory, "client.mjs");
  const clientBytes = adapterSource.replace("#!NODE", `#!${process.execPath}`);
  await writeFile(clientPath, clientBytes); await chmod(clientPath, 0o700);
  const trustRoot = join(fixture.directory, "trusted-root.jsonl");
  const root = '{"mediaType":"application/vnd.dev.sigstore.trustedroot+json;version=0.1"}\n';
  await writeFile(trustRoot, root);
  const identity = producerIdentity();
  const archiveSha512 = Buffer.from(c.tarball.integrity.slice(7), "base64").toString("hex");
  const expectedCandidate = { inventorySha256: hash(bytes), archiveSha512 };
  const ci = { schemaVersion: 1, identity, candidate: expectedCandidate, tools: candidate.tools,
    qualification: { status: "passed", evidenceSha256: "c".repeat(64) } };
  const ciEvidence = join(fixture.directory, "ci-evidence.json");
  await writeFile(ciEvidence, JSON.stringify(ci));
  const plan = { schemaVersion: 1, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    trustRootSha256: hash(root), client: { path: clientPath, version: "2.102.0", sha256: hash(clientBytes) },
    limits: { timeoutMs: 10000, maxOutputBytes: 50000 }, identity, candidate: expectedCandidate,
    ciEvidenceSha256: hash(JSON.stringify(ci)), inventorySubject: "candidate.json" };
  const archiveSubject = { name: `pkg:npm/%40tabgrad/retained-fixture@${candidate.version}`, digest: { sha512: archiveSha512 } };
  const inventorySubject = { name: "candidate.json", digest: { sha256: hash(bytes) } };
  const model = { archive: controlledVerifiedResult(identity, archiveSubject), inventory: controlledVerifiedResult(identity, inventorySubject) };
  const archiveBundle = join(fixture.directory, "archive-proof.json");
  const inventoryBundle = join(fixture.directory, "inventory-proof.json");
  const paths = { plan, archive: fixture.tarball, inventory, staticDirectory: join(fixture.source, "dist"),
    archiveBundle, inventoryBundle, trustRoot, ciEvidence };
  const result = { ...fixture, candidate, bytes, ci, model, paths,
    async save() {
      for (const [kind, path] of [["archive", archiveBundle], ["inventory", inventoryBundle]]) {
        await writeFile(path, JSON.stringify({ dsseEnvelope: { payloadType: "application/vnd.in-toto+json",
          payload: Buffer.from(JSON.stringify(model[kind].statement)).toString("base64"),
          signatures: [{ keyid: "", sig: "synthetic-not-a-valid-signature" }] } }));
      }
      await writeFile(join(fixture.directory, "client-model.json"), JSON.stringify(model));
    },
    async observation() { return JSON.parse(await readFile(join(fixture.directory, "client-observation.json"), "utf8")); },
  };
  await result.save();
  return result;
}
