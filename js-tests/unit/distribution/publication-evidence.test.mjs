import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPublicationEvidence, decodePublicationEvidence } from "../../../scripts/publication-evidence.mjs";
import { canonicalBytes } from "../../../scripts/release-record-data.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "tabgrad-publication-evidence-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = join(root, "data"), verificationDirectory = join(root, "verification");
  await mkdir(dataDirectory); await mkdir(verificationDirectory);
  const originals = new Map();
  for (const name of ["producer.json", "qualification.json", "ci-evidence.json", "trusted-root.jsonl", "verification.json",
    "api-run.json", "api-jobs.json", "api-data.json", "api-proofs.json", "release-qualification.json"]) {
    const raw = Buffer.from(`{ "original": "${name}", "utf8": "á" }\n`);
    const path = name === "release-qualification.json" ? join(root, name)
      : join(["producer.json", "qualification.json"].includes(name) ? dataDirectory : verificationDirectory, name);
    await writeFile(path, raw); originals.set(name, raw);
  }
  // Sensitive or role-local sidecars are deliberately not selected.
  for (const name of ["private-policy.json", "verification-plan.json", "npmrc"]) await writeFile(join(verificationDirectory, name), "private");
  return { dataDirectory, verificationDirectory, qualification: join(root, "release-qualification.json"), originals };
}

test("publication evidence preserves ten exact originals and excludes private sidecars", async t => {
  const f = await fixture(t), first = await createPublicationEvidence(f), second = await createPublicationEvidence(f);
  assert.deepEqual(first, second); assert.deepEqual(decodePublicationEvidence(first), f.originals);
  assert.equal(first.includes(Buffer.from("private-policy")), false);
});

for (const [name, change, code] of [
  ["duplicate", p => { p.files[1] = p.files[0]; }, "PUBLICATION_EVIDENCE_INVALID"],
  ["payload substitution", p => { p.files[0].base64 = Buffer.alloc(p.files[0].byteLength).toString("base64"); }, "PUBLICATION_EVIDENCE_CHANGED"],
  ["unknown field", p => { p.private = "unexpected"; }, "PUBLICATION_EVIDENCE_INVALID"],
  ["missing original", p => { p.files.pop(); }, "PUBLICATION_EVIDENCE_INVALID"],
  ["bad size", p => { p.files[0].byteLength = 4194305; }, "PUBLICATION_EVIDENCE_INVALID"],
]) test(`publication evidence rejects ${name}`, async t => {
  const f = await fixture(t), p = JSON.parse(await createPublicationEvidence(f)); change(p);
  assert.throws(() => decodePublicationEvidence(canonicalBytes(p)), { code });
});

test("publication evidence refuses symlink originals and noncanonical encoding", async t => {
  const f = await fixture(t), raw = await createPublicationEvidence(f);
  assert.throws(() => decodePublicationEvidence(Buffer.concat([raw, Buffer.from("\n")])), { code: "PUBLICATION_EVIDENCE_INVALID" });
  const path = join(f.dataDirectory, "producer.json"); await rm(path); await symlink(f.qualification, path);
  await assert.rejects(createPublicationEvidence(f), { code: "PUBLICATION_EVIDENCE_INPUT" });
  assert.ok((await readFile(f.qualification)).length > 0);
});
