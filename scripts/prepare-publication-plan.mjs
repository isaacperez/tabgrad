import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { readProducerInventory } from "./package-provenance.mjs";
import { publicationFile } from "./publication-admission.mjs";
import { requirePublication, validatePublicationPlan } from "./publication-plan.mjs";
import { canonicalBytes, sha256 } from "./release-record-data.mjs";
import { createPublicationEvidence } from "./publication-evidence.mjs";

export function publicationChecksums(plan) {
  return Buffer.from(plan.github.assets.filter(asset => asset.kind !== "checksums")
    .toSorted((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .map(asset => `${asset.sha256}  ${asset.name}\n`).join(""));
}

export function publicationAuthorityBytes(plan) { return canonicalBytes({ schemaVersion: 1, operation: plan.operation }); }

function fill(object, key, value) {
  requirePublication(object[key] === undefined || isDeepStrictEqual(object[key], value), "PUBLICATION_DRAFT_MISMATCH");
  object[key] = value;
}

/** Offline draft construction, not source admission, approval, setup or publication. */
export async function preparePublicationPlan(input, output) {
  const plan = JSON.parse(await publicationFile(join(input, "draft.json"), 65536));
  const data = join(input, "data"), proofs = join(input, "proofs"), text = join(input, "input");
  const inventory = await publicationFile(join(data, "candidate.json"), 2 * 1024 * 1024);
  const candidate = readProducerInventory(inventory);
  requirePublication(candidate.private === false && plan.candidate.name === candidate.name
    && plan.candidate.version === candidate.version && plan.candidate.sourceRevision === candidate.sourceRevision,
  "PUBLICATION_DRAFT_SOURCE_MISMATCH");
  plan.operation ??= randomBytes(32).toString("hex");
  fill(plan, "authority", sha256(publicationAuthorityBytes(plan)));
  fill(plan.candidate, "inventorySha256", sha256(inventory));
  fill(plan.candidate, "archiveSha512", Buffer.from(candidate.tarball.integrity.slice(7), "base64").toString("hex"));
  for (const key of ["inventorySha256", "archiveSha512"]) fill(plan.producer.verification.candidate, key, plan.candidate[key]);
  const producer = JSON.parse(await publicationFile(join(data, "producer.json"), 65536));
  requirePublication(isDeepStrictEqual(producer.identity, plan.producer.verification.identity), "PUBLICATION_DRAFT_PRODUCER_MISMATCH");
  fill(plan.producer, "signingDeadline", producer.expiresAt);
  const notes = await publicationFile(join(text, "notes.md"), 1024 * 1024);
  const qualification = await publicationFile(join(text, "qualification.json"), 4 * 1024 * 1024);
  fill(plan.github, "notesSha256", sha256(notes));
  fill(plan.qualification, "evidenceSha256", sha256(qualification));
  const evidence = await createPublicationEvidence({ dataDirectory: data, verificationDirectory: join(input, "verification"),
    qualification: join(text, "qualification.json") });
  const originals = new Map([["inventory", inventory], ["evidence", evidence],
    ["archive", await publicationFile(join(data, candidate.tarball.path), candidate.tarball.byteLength)]]);
  for (const kind of ["archive", "inventory"]) {
    const proof = await publicationFile(join(proofs, `${kind}-proof.json`), 16 * 1024 * 1024);
    originals.set(`${kind}-proof`, proof);
    fill(plan.producer, `${kind}ProofSha256`, sha256(proof));
  }
  for (const asset of plan.github.assets) if (asset.kind !== "checksums") {
    const bytes = originals.get(asset.kind);
    requirePublication(bytes !== undefined, "PUBLICATION_DRAFT_ASSET_INVALID");
    fill(asset, "byteLength", bytes.length); fill(asset, "sha256", sha256(bytes));
  }
  const checksums = publicationChecksums(plan);
  const asset = plan.github.assets.find(value => value.kind === "checksums");
  requirePublication(asset !== undefined, "PUBLICATION_DRAFT_ASSET_INVALID");
  fill(asset, "byteLength", checksums.length); fill(asset, "sha256", sha256(checksums));
  validatePublicationPlan(plan);
  const bytes = canonicalBytes(plan);
  // All writes belong to a new directory; never adopt or remove an existing one.
  await mkdir(output, { mode: 0o700 });
  await mkdir(join(output, "input"), { mode: 0o700 });
  for (const [name, raw] of [["plan.json", bytes], ["notes.md", notes], ["qualification.json", qualification],
    ["producer-evidence.json", evidence], ["release-checksums.txt", checksums]]) {
    await writeFile(join(output, "input", name), raw, { flag: "wx", mode: 0o600 });
  }
  return { schemaVersion: 1, status: "draft-for-independent-inspection", planSha256: sha256(bytes),
    operation: plan.operation, candidate: plan.candidate };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requirePublication(process.argv.length === 4, "PUBLICATION_USAGE");
    process.stdout.write(`${JSON.stringify(await preparePublicationPlan(process.argv[2], process.argv[3]))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: "failed", code: error.code ?? "PUBLICATION_DRAFT_FAILED" })}\n`);
    process.exitCode = 1;
  }
}
