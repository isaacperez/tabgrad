import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, access, unlink } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { provenanceFixture, producerIdentity, controlledVerifiedResult } from "../../fixtures/package-provenance.mjs";
import { hash } from "../../fixtures/package-candidate.mjs";
import { validateProvenancePlan, readProducerInventory, verifyProducerIdentity, verifyOriginalProof,
  verifyPackageProvenance } from "../../../scripts/package-provenance.mjs";
import { provenanceEnvironment } from "../../../scripts/provenance-client.mjs";

test("controlled adapter composes exact retained bytes, two proofs and policy without executing the package", async context => {
  const f = await provenanceFixture(context);
  const before = await readFile(f.paths.inventory);
  const report = await verifyPackageProvenance(f.paths);
  assert.equal(report.status, "passed");
  assert.equal(report.cleanup, "completed");
  assert.deepEqual(report.checks.slice(-4), ["archive-signature", "archive-identity-and-claims", "inventory-signature", "inventory-identity-and-claims"]);
  assert.equal(report.generatorInteroperability, "unqualified");
  assert.equal(report.operationalTrust, "unqualified");
  assert.equal(report.releaseAdmission, "unqualified");
  assert.deepEqual(await readFile(f.paths.inventory), before);
  await assert.rejects(access(f.lifecycleMarker), { code: "ENOENT" });
  const observation = await f.observation();
  await assert.rejects(access(observation.directory), { code: "ENOENT" });
  for (const flag of ["--bundle", "--custom-trusted-root", "--cert-identity", "--cert-oidc-issuer", "--source-digest", "--source-ref", "--signer-digest", "--deny-self-hosted-runners"]) assert.ok(observation.arguments.includes(flag));
  assert.equal(JSON.stringify(report).includes(f.directory), false);
});

for (const [field, value] of [["issuer", "https://example.invalid"], ["sourceRepositoryIdentifier", "99"],
  ["sourceRepositoryOwnerIdentifier", "99"], ["sourceRepositoryURI", "https://github.com/other/project"],
  ["sourceRepositoryOwnerURI", "https://github.com/other"],
  ["sourceRepositoryDigest", "f".repeat(40)], ["sourceRepositoryRef", "refs/heads/Main"],
  ["buildSignerURI", "https://github.com/example/unapproved"], ["subjectAlternativeName", "https://github.com/example/unapproved"],
  ["buildSignerDigest", "f".repeat(40)], ["buildConfigURI", "https://github.com/example/unapproved"],
  ["buildConfigDigest", "f".repeat(40)], ["buildTrigger", "pull_request"],
  ["runnerEnvironment", "self-hosted"], ["runInvocationURI", "https://github.com/example/project/actions/runs/132/attempts/2"]]) {
  test(`certificate-bound ${field} must independently agree`, () => {
    const identity = producerIdentity(); const subject = { name: "candidate.json", digest: { sha256: "a".repeat(64) } };
    const result = controlledVerifiedResult(identity, subject);
    result.signature.certificate[field] = value;
    assert.throws(() => verifyProducerIdentity(result, identity, subject), { code: "IDENTITY_MISMATCH" });
    delete result.signature.certificate[field];
    assert.throws(() => verifyProducerIdentity(result, identity, subject), { code: "IDENTITY_MISMATCH" });
  });
}

test("attempt and separately trusted signer revision cannot be inferred from claims", () => {
  const identity = producerIdentity(); const subject = { name: "candidate.json", digest: { sha256: "a".repeat(64) } };
  const result = controlledVerifiedResult(identity, subject);
  assert.throws(() => verifyProducerIdentity(result, { ...identity, runAttempt: "3" }, subject), { code: "IDENTITY_MISMATCH" });
  assert.throws(() => verifyProducerIdentity(result, { ...identity, signerRevision: identity.sourceRevision }, subject), { code: "IDENTITY_MISMATCH" });
});

for (const [name, mutate] of [
  ["repository ID", s => { s.predicate.buildDefinition.internalParameters.github.repository_id = "99"; }],
  ["owner ID", s => { s.predicate.buildDefinition.internalParameters.github.repository_owner_id = "99"; }],
  ["source dependency", s => { s.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "f".repeat(40); }],
  ["extra dependency", s => { s.predicate.buildDefinition.resolvedDependencies.push({ uri: "unexpected" }); }],
  ["workflow", s => { s.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/other.yml"; }],
  ["event", s => { s.predicate.buildDefinition.internalParameters.github.event_name = "pull_request"; }],
  ["run", s => { s.predicate.runDetails.metadata.invocationId += "0"; }],
  ["builder", s => { s.predicate.runDetails.builder.id = "unapproved"; }],
]) test(`workflow-controlled ${name} is corroborated separately`, () => {
  const identity = producerIdentity(); const subject = { name: "candidate.json", digest: { sha256: "a".repeat(64) } };
  const result = controlledVerifiedResult(identity, subject); mutate(result.statement);
  assert.throws(() => verifyProducerIdentity(result, identity, subject), { code: "CLAIMS_MISMATCH" });
});

for (const [name, mutate] of [
  ["extra subject", r => { r.statement.subject.push(r.statement.subject[0]); }],
  ["subject name", r => { r.statement.subject[0].name = "other"; }],
  ["subject digest", r => { r.statement.subject[0].digest.sha256 = "f".repeat(64); }],
  ["predicate type", r => { r.statement.predicateType = "unsupported"; }],
  ["statement version", r => { r.statement._type = "unsupported"; }],
  ["timestamps", r => { r.verifiedTimestamps = []; }],
]) test(`required result ${name} rejects`, () => {
  const identity = producerIdentity(); const subject = { name: "candidate.json", digest: { sha256: "a".repeat(64) } };
  const result = controlledVerifiedResult(identity, structuredClone(subject)); mutate(result);
  assert.throws(() => verifyProducerIdentity(result, identity, subject));
});

test("exact inventory encoding is checked without rewriting the original", async context => {
  const f = await provenanceFixture(context);
  assert.deepEqual(readProducerInventory(f.bytes), f.candidate);
  for (const bytes of [Buffer.from(JSON.stringify(f.candidate)), Buffer.from(f.bytes.toString().replace(/\n/g, "\r\n")),
    Buffer.from(`${JSON.stringify({ ...f.candidate, extra: true }, null, 2)}\n`)]) assert.throws(() => readProducerInventory(bytes), { code: "INVENTORY_INVALID" });
  const reordered = structuredClone(f.candidate);
  reordered.files[0] = { sha256: reordered.files[0].sha256, path: reordered.files[0].path, byteLength: reordered.files[0].byteLength };
  assert.throws(() => readProducerInventory(Buffer.from(`${JSON.stringify(reordered, null, 2)}\n`)), { code: "INVENTORY_INVALID" });
});

for (const [name, mutate] of [
  ["inventory", async f => writeFile(f.paths.inventory, `${f.bytes} `)],
  ["archive", async f => writeFile(f.paths.archive, Buffer.from("substituted"))],
  ["static file", async f => writeFile(join(f.paths.staticDirectory, "index.js"), "changed")],
  ["static omission", async f => unlink(join(f.paths.staticDirectory, "index.js"))],
  ["static addition", async f => writeFile(join(f.paths.staticDirectory, "unexpected"), "extra")],
  ["CI bytes", async f => writeFile(f.paths.ciEvidence, "{}")],
  ["trust bytes", async f => writeFile(f.paths.trustRoot, "{}\n")],
  ["client bytes", async f => writeFile(f.paths.plan.client.path, "changed")],
]) test(`independent ${name} substitution fails before successful admission`, async context => {
  const f = await provenanceFixture(context); await mutate(f);
  await assert.rejects(verifyPackageProvenance(f.paths), error => {
    assert.equal(error.report.status, "failed"); assert.equal(error.report.cleanup, "completed");
    assert.equal(error.report.checks.includes("inventory-identity-and-claims"), false); return true;
  });
});

test("independently admitted CI content must corroborate tools and qualification", async context => {
  const f = await provenanceFixture(context); f.ci.tools.node = "unqualified";
  const changed = JSON.stringify(f.ci); await writeFile(f.paths.ciEvidence, changed); f.paths.plan.ciEvidenceSha256 = hash(changed);
  await assert.rejects(verifyPackageProvenance(f.paths), { code: "CI_EVIDENCE_INVALID" });
});

test("client result cannot substitute another original statement", async context => {
  const f = await provenanceFixture(context); f.model.archive.statement.subject[0].name = "other";
  await writeFile(join(f.directory, "client-model.json"), JSON.stringify(f.model));
  await assert.rejects(verifyPackageProvenance(f.paths), { code: "BUNDLE_MISMATCH" });
});

test("duplicate original envelopes are outside this profile", () => {
  const statement = { subject: [] };
  const original = Buffer.from(JSON.stringify({ dsseEnvelope: { payloadType: "application/vnd.in-toto+json",
    payload: Buffer.from(JSON.stringify(statement)).toString("base64"), signatures: [{}, {}] } }));
  assert.throws(() => verifyOriginalProof(original, { statement }), { code: "BUNDLE_INVALID" });
});

test("hostile inherited identities, injection and proxies do not enter the client", async context => {
  const f = await provenanceFixture(context); const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "PRIVATE TEST IDENTITY";
  try {
    await verifyPackageProvenance(f.paths);
    const actual = (await f.observation()).environment;
    for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "NODE_OPTIONS", "HTTPS_PROXY", "GIT_ASKPASS", "SSH_AUTH_SOCK"]) assert.equal(actual[key], undefined);
    assert.notEqual(actual.HOME, process.env.HOME);
    assert.equal(actual.GH_HOST, "github.com");
  } finally { if (previous === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previous; }
  const isolated = provenanceEnvironment(f.directory, { GH_TOKEN: "secret", PATH: "hostile", HOME: "ambient", GH_HOST: "other" });
  assert.equal(isolated.PATH, undefined); assert.equal(isolated.GH_TOKEN, undefined);
});

for (const [mode, code] of [["reject", "CLIENT_REJECTED"], ["reject-inventory", "CLIENT_REJECTED"],
  ["invalid-json", "CLIENT_RESULT_INVALID"], ["timeout", "CLIENT_TIMEOUT"], ["output", "CLIENT_OUTPUT_LIMIT"],
  ["stderr-output", "CLIENT_OUTPUT_LIMIT"]]) test(`bounded client ${mode} preserves safe partial evidence and cleanup`, async context => {
  const f = await provenanceFixture(context); f.model.mode = mode;
  if (mode === "timeout") f.paths.plan.limits.timeoutMs = 1000;
  await f.save();
  await assert.rejects(verifyPackageProvenance(f.paths), error => {
    assert.equal(error.code, code); assert.equal(error.report.cleanup, "completed");
    assert.equal(JSON.stringify(error.report).includes("PRIVATE CLIENT DETAILS"), false);
    assert.equal(JSON.stringify(error.report).includes(f.directory), false);
    if (mode === "reject-inventory") assert.ok(error.report.checks.includes("archive-identity-and-claims"));
    return true;
  });
  const observation = await f.observation(); await assert.rejects(access(observation.directory), { code: "ENOENT" });
});

test("ambiguous client result, unsupported client and expired plan fail closed", async context => {
  const f = await provenanceFixture(context);
  f.model.resultOverride = []; await f.save();
  await assert.rejects(verifyPackageProvenance(f.paths), { code: "CLIENT_RESULT_INVALID" });
  f.paths.plan.client.version = "2.103.0";
  await assert.rejects(verifyPackageProvenance(f.paths), { code: "CLIENT_UNQUALIFIED" });
  f.paths.plan.expiresAt = "2020-01-01T00:00:00.000Z";
  assert.throws(() => validateProvenancePlan(f.paths.plan), { code: "PLAN_INVALID" });
});

test("plan data rejects coercion, unknown fields, ambiguous expiry and unsupported execution bounds", async context => {
  const f = await provenanceFixture(context);
  for (const change of [p => { p.extra = true; }, p => { p.identity.repository = [p.identity.repository]; },
    p => { p.candidate.inventorySha256 = [p.candidate.inventorySha256]; },
    p => { p.expiresAt = "2030-02-31T00:00:00.000Z"; }, p => { p.limits.maxOutputBytes = 0; },
    p => { p.limits.timeoutMs = 2147483648; }, p => { p.client.path = "gh"; },
    p => { p.identity.workflowRevision = "f".repeat(40); }, p => { p.identity.sourceRef = "refs/heads/Main"; }]) {
    const plan = structuredClone(f.paths.plan); change(plan);
    assert.throws(() => validateProvenancePlan(plan), { code: "PLAN_INVALID" });
  }
});

test("null or multiple client results never become verified evidence", async context => {
  const f = await provenanceFixture(context);
  for (const resultOverride of [[{ verificationResult: null }],
    [{ verificationResult: f.model.archive }, { verificationResult: f.model.archive }]]) {
    f.model.resultOverride = resultOverride; await f.save();
    await assert.rejects(verifyPackageProvenance(f.paths), { code: "CLIENT_RESULT_INVALID" });
  }
});

test("CLI diagnostics exclude input paths and raw client failures", async context => {
  const f = await provenanceFixture(context); f.model.mode = "reject"; await f.save();
  const planPath = join(f.directory, "private-plan.json"); await writeFile(planPath, JSON.stringify(f.paths.plan));
  const x = spawnSync(process.execPath, ["scripts/package-provenance.mjs", planPath, f.paths.archive, f.paths.inventory,
    f.paths.staticDirectory, f.paths.archiveBundle, f.paths.inventoryBundle, f.paths.trustRoot, f.paths.ciEvidence],
  { encoding: "utf8" });
  assert.equal(x.status, 1); assert.equal(x.stderr, "");
  const report = JSON.parse(x.stdout); assert.equal(report.failure.code, "CLIENT_REJECTED");
  assert.equal(x.stdout.includes(f.directory), false); assert.equal(x.stdout.includes("PRIVATE CLIENT DETAILS"), false);
});
