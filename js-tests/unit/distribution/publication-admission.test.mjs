import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { provenanceFixture, controlledConsumerReport } from "../../fixtures/package-provenance.mjs";
import { publicationPlanFixture } from "../../fixtures/publication.mjs";
import { canonicalBytes, sha256 } from "../../../scripts/release-record-data.mjs";
import { preparePublicationPlan } from "../../../scripts/prepare-publication-plan.mjs";
import { admitPublicationInputs, recheckPublicationInputs, validatePublicationQualification } from "../../../scripts/publication-admission.mjs";
import { createPublicationEvidence, decodePublicationEvidence } from "../../../scripts/publication-evidence.mjs";

async function fixture(t) {
  const f = await provenanceFixture(t), root = join(f.directory, "material");
  const data = join(root, "data"), proofs = join(root, "proofs"), verification = join(root, "verification"), input = join(root, "input");
  for (const path of [data, proofs, verification, input]) await mkdir(path, { recursive: true });
  await cp(f.source, join(data, "package"), { recursive: true });
  await cp(f.tarball, join(data, f.candidate.tarball.path));
  await writeFile(join(data, "candidate.json"), f.bytes);
  const qualification = controlledConsumerReport(f.candidate, f.bytes), raw = Buffer.from(`${JSON.stringify(qualification, null, 2)}\n`);
  await writeFile(join(data, "qualification.json"), raw);
  await writeFile(join(data, "producer.json"), Buffer.from(`${JSON.stringify({ schemaVersion: 1, identity: f.paths.plan.identity,
    expiresAt: f.paths.plan.expiresAt, inventorySha256: sha256(f.bytes), archiveSha512: f.paths.plan.candidate.archiveSha512,
    qualificationSha256: sha256(raw) }, null, 2)}\n`));
  for (const kind of ["archive", "inventory"]) await cp(f.paths[`${kind}Bundle`], join(proofs, `${kind}-proof.json`));
  for (const [name, bytes] of [["ci-evidence.json", await readFile(f.paths.ciEvidence)],
    ["trusted-root.jsonl", await readFile(f.paths.trustRoot)], ["verification.json", Buffer.from('{"status":"controlled"}\n')],
    ...["api-run.json", "api-jobs.json", "api-data.json", "api-proofs.json"].map(name => [name, Buffer.from(`{ "fixture": "${name}" }\n`)])]) {
    await writeFile(join(verification, name), bytes);
  }
  await writeFile(join(input, "qualification.json"), canonicalBytes([qualification]));
  await writeFile(join(input, "notes.md"), "# Synthetic release\n");
  const plan = publicationPlanFixture({ candidate: f.candidate, verification: f.paths.plan }).publicationPlan;
  delete plan.authority;
  for (const key of ["inventorySha256", "archiveSha512"]) { delete plan.candidate[key]; delete plan.producer.verification.candidate[key]; }
  for (const key of ["archiveProofSha256", "inventoryProofSha256", "signingDeadline"]) delete plan.producer[key];
  delete plan.github.notesSha256; delete plan.qualification.evidenceSha256;
  for (const asset of plan.github.assets) { delete asset.byteLength; delete asset.sha256; }
  await writeFile(join(root, "draft.json"), canonicalBytes(plan));
  const output = join(f.directory, "prepared");
  const result = await preparePublicationPlan(root, output);
  const approved = JSON.parse(await readFile(join(output, "input/plan.json")));
  const assets = Object.fromEntries(approved.github.assets.map(asset => [asset.name, asset.kind === "archive" ? join(data, f.candidate.tarball.path)
    : asset.kind === "inventory" ? join(data, "candidate.json") : asset.kind.endsWith("-proof") ? join(proofs, `${asset.kind}.json`)
      : join(output, "input", asset.kind === "evidence" ? "producer-evidence.json" : "release-checksums.txt")]));
  const options = { plan: approved, dataDirectory: data, proofsDirectory: proofs, qualification: join(output, "input/qualification.json"),
    notes: join(output, "input/notes.md"), verificationClient: f.paths.plan.client.path,
    trustRoot: join(verification, "trusted-root.jsonl"), ciEvidence: join(verification, "ci-evidence.json"), assets };
  return { ...f, root, output, data, verification, approved, result, options };
}

test("offline builder conserves exact original evidence, produces six assets and never adopts an existing output", async t => {
  const f = await fixture(t), bytes = await readFile(join(f.output, "input/plan.json"));
  assert.equal(sha256(bytes), f.result.planSha256);
  const evidence = await createPublicationEvidence({ dataDirectory: f.data, verificationDirectory: f.verification,
    qualification: join(f.root, "input/qualification.json") });
  assert.deepEqual(await readFile(join(f.output, "input/producer-evidence.json")), evidence);
  assert.equal(decodePublicationEvidence(evidence).size, 10);
  await assert.rejects(preparePublicationPlan(f.root, f.output), { code: "EEXIST" });
  assert.deepEqual(await readFile(join(f.output, "input/plan.json")), bytes);
  const draft = JSON.parse(await readFile(join(f.root, "draft.json"))); draft.github.notesSha256 = "0".repeat(64);
  await writeFile(join(f.root, "draft.json"), canonicalBytes(draft));
  await assert.rejects(preparePublicationPlan(f.root, join(f.directory, "contrary")), { code: "PUBLICATION_DRAFT_MISMATCH" });
});

test("full input admission uses the controlled proof adapter then immutable handoff recheck catches changed transport", async t => {
  const f = await fixture(t), material = await admitPublicationInputs(f.options);
  assert.equal(material.admission.status, "passed"); assert.equal(material.assets.size, 6);
  const rechecked = await recheckPublicationInputs(f.options, material.admission);
  assert.equal(rechecked.report.status, "passed");
  const original = await readFile(f.options.notes); await writeFile(f.options.notes, "changed notes");
  await assert.rejects(recheckPublicationInputs(f.options, material.admission), { code: "PUBLICATION_NOTES_CHANGED" });
  await writeFile(f.options.notes, original);
  await assert.rejects(recheckPublicationInputs(f.options, { ...material.admission, planSha256: "0".repeat(64) }),
    { code: "PUBLICATION_ADMISSION_HANDOFF" });
  await writeFile(join(f.data, "qualification.json"), "{}");
  await assert.rejects(recheckPublicationInputs(f.options, material.admission), { code: "PUBLICATION_ADMISSION_HANDOFF" });
});

test("qualification varies browser, backend, input, identity, profile completeness and cleanup independently", async t => {
  const f = await fixture(t), report = controlledConsumerReport(f.candidate, f.bytes);
  validatePublicationQualification([report], f.candidate, f.approved);
  for (const change of [r => { r.requested.gpu = true; }, r => { r.input = "registry-version"; },
    r => { r.requested.browsers.reverse(); }, r => { r.profiles.pop(); }, r => { r.profiles[0] = r.profiles[1]; },
    r => { r.cleanupFailure = {}; }, r => { r.candidate.sourceRevision = "0".repeat(40); },
    r => { r.expectedEvidenceSha256 = "0".repeat(64); }]) {
    const changed = structuredClone(report); change(changed);
    assert.throws(() => validatePublicationQualification([changed], f.candidate, f.approved), { code: "PUBLICATION_QUALIFICATION_MISMATCH" });
  }
  const gpu = controlledConsumerReport(f.candidate, f.bytes, { gpu: true });
  const plan = structuredClone(f.approved); plan.qualification.gpu = true;
  assert.throws(() => validatePublicationQualification([report, gpu], f.candidate, plan), { code: "PUBLICATION_GPU_EVIDENCE_MISSING" });
  gpu.profiles[0].gpu = { adapter: { isFallbackAdapter: false } };
  validatePublicationQualification([report, gpu], f.candidate, plan);
  gpu.profiles[0].gpu.adapter.isFallbackAdapter = true;
  assert.throws(() => validatePublicationQualification([report, gpu], f.candidate, plan), { code: "PUBLICATION_GPU_EVIDENCE_MISSING" });
});
