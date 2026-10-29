import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readProducerInventory, verifyPackageProvenance } from "./package-provenance.mjs";
import { inspectTrialPacket } from "./producer-trial.mjs";
import { admitNpmManifest } from "./publication-npm.mjs";
import { requirePublication } from "./publication-plan.mjs";
import { canonicalBytes, sha256 } from "./release-record-data.mjs";

export async function publicationFile(path, maxBytes) {
  const stat = await lstat(path);
  requirePublication(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes, "PUBLICATION_INPUT_INVALID");
  return readFile(path);
}

function sameCandidate(report, candidate, inventorySha256) {
  requirePublication(report?.schemaVersion === 1 && report.status === "passed"
    && ["supplied-archive", "registry-version"].includes(report.input)
    && report.expectedEvidenceSha256 === inventorySha256
    && report.candidate?.name === candidate.name && report.candidate.version === candidate.version
    && report.candidate.sourceRevision === candidate.sourceRevision && report.candidate.private === false
    && report.candidate.archive?.sha256 === candidate.tarball.sha256
    && report.candidate.archive.integrity === candidate.tarball.integrity
    && report.candidate.archive.byteLength === candidate.tarball.byteLength
    && report.candidate.files === candidate.files.length && !report.cleanupFailure && !report.preparationCleanupFailure,
  "PUBLICATION_QUALIFICATION_MISMATCH");
  for (const check of ["archive-identity", "archive-structure", "metadata-and-source", "installed-inventory",
    "public-entries", "public-types", "cpu-assets", "static-inventory"]) {
    requirePublication(report.checks?.includes(check), "PUBLICATION_QUALIFICATION_MISMATCH");
  }
}

export function validatePublicationQualification(reports, candidate, plan, input = "supplied-archive") {
  requirePublication(Array.isArray(reports) && reports.length === (plan.qualification.gpu ? 2 : 1),
    "PUBLICATION_QUALIFICATION_MISMATCH");
  const required = [{ gpu: false, browsers: plan.qualification.browsers, profiles: ["direct", "python", "prerequisite"] },
    ...(plan.qualification.gpu ? [{ gpu: true, browsers: ["Chrome"], profiles: ["gpu", "origin"] }] : [])];
  for (const expected of required) {
    const matches = reports.filter(report => report.requested?.gpu === expected.gpu);
    requirePublication(matches.length === 1, "PUBLICATION_QUALIFICATION_MISMATCH");
    const report = matches[0];
    sameCandidate(report, candidate, plan.candidate.inventorySha256);
    requirePublication(report.input === input && isDeepStrictEqual(report.requested, expected)
      && report.profiles?.length === expected.browsers.length * expected.profiles.length,
    "PUBLICATION_QUALIFICATION_MISMATCH");
    for (const browser of expected.browsers) for (const mode of expected.profiles) {
      requirePublication(report.profiles.filter(profile => profile.browser === browser && profile.mode === mode
        && profile.status === "passed" && typeof profile.version === "string" && profile.version.length > 0).length === 1,
      "PUBLICATION_QUALIFICATION_MISMATCH");
    }
    if (expected.gpu) requirePublication(report.profiles.find(profile => profile.mode === "gpu")?.gpu?.adapter?.isFallbackAdapter === false,
      "PUBLICATION_GPU_EVIDENCE_MISSING");
    if (input === "registry-version") requirePublication(report.checks.includes("supplied-archive-installation"),
      "PUBLICATION_QUALIFICATION_MISMATCH");
    if (input === "registry-version") {
      const registry = report.registry;
      requirePublication(registry?.status === "passed" && registry.npm === "11.1.0" && registry.channel === plan.npm.channel
        && registry.transport?.rejected === 0 && registry.consumedArchive?.sha256 === candidate.tarball.sha256
        && registry.consumedArchive.byteLength === candidate.tarball.byteLength
        && registry.consumedArchive.integrity === candidate.tarball.integrity
        && ["exact-registry-metadata", "channel", "dependency-boundary", "downloaded-archive-identity",
          "approved-cache-population", "named-registry-installation", "consumed-archive-integrity", "installed-inventory"]
          .every(check => registry.checks?.includes(check)), "PUBLICATION_REGISTRY_CONSUMER_MISMATCH");
    }
  }
}

/** Original-data verification, without building or running package/consumer code. */
export async function admitPublicationInputs(options) {
  const { plan, dataDirectory, proofsDirectory, verificationClient, trustRoot, ciEvidence } = options;
  const packet = await inspectTrialPacket(dataDirectory, { identity: plan.producer.verification.identity,
    expiresAt: plan.producer.signingDeadline });
  const material = await publicationMaterials(options, packet);
  const report = await verifyPackageProvenance({ plan: { ...plan.producer.verification,
    client: { ...plan.producer.verification.client, path: verificationClient } },
  archive: material.archive, inventory: join(dataDirectory, "candidate.json"),
  staticDirectory: join(dataDirectory, "package/dist"), archiveBundle: join(proofsDirectory, "archive-proof.json"),
  inventoryBundle: join(proofsDirectory, "inventory-proof.json"), trustRoot, ciEvidence });
  return { ...material, report, admission: { schemaVersion: 1, status: "passed", planSha256: sha256(canonicalBytes(plan)),
    candidate: packet.candidate, preparationQualificationSha256: packet.producer.qualificationSha256, provenance: report } };
}

/** Reuse immutable proof evidence only after the caller authenticates its CI handoff. */
export async function recheckPublicationInputs(options, admission) {
  const { plan, dataDirectory } = options;
  requirePublication(admission?.schemaVersion === 1 && admission.status === "passed"
    && admission.planSha256 === sha256(canonicalBytes(plan)) && admission.provenance?.status === "passed",
  "PUBLICATION_ADMISSION_HANDOFF");
  const inventory = await publicationFile(join(dataDirectory, "candidate.json"), 2 * 1024 * 1024);
  requirePublication(sha256(inventory) === plan.candidate.inventorySha256, "PUBLICATION_INVENTORY_CHANGED");
  const candidate = readProducerInventory(inventory);
  const rawQualification = await publicationFile(join(dataDirectory, "qualification.json"), 4 * 1024 * 1024);
  requirePublication(isDeepStrictEqual(candidate, admission.candidate)
    && candidate.sourceRevision === plan.candidate.sourceRevision
    && sha256(rawQualification) === admission.preparationQualificationSha256, "PUBLICATION_ADMISSION_HANDOFF");
  return { ...await publicationMaterials(options, { candidate, inventory, qualification: JSON.parse(rawQualification) }),
    report: admission.provenance, admission };
}

async function publicationMaterials({ plan, dataDirectory, proofsDirectory, qualification, notes, assets }, packet) {
  requirePublication(packet.candidate.private === false && packet.candidate.name === plan.candidate.name
    && packet.candidate.version === plan.candidate.version, "PUBLICATION_PUBLIC_CANDIDATE_REQUIRED");
  const proofBytes = new Map();
  for (const kind of ["archive", "inventory"]) {
    const raw = await publicationFile(join(proofsDirectory, `${kind}-proof.json`), 16 * 1024 * 1024);
    requirePublication(sha256(raw) === plan.producer[`${kind}ProofSha256`], "PUBLICATION_PROOF_CHANGED");
    proofBytes.set(`${kind}-proof`, raw);
  }
  const rawQualification = await publicationFile(qualification, 4 * 1024 * 1024);
  requirePublication(sha256(rawQualification) === plan.qualification.evidenceSha256, "PUBLICATION_QUALIFICATION_CHANGED");
  const qualificationReports = JSON.parse(rawQualification);
  validatePublicationQualification(qualificationReports, packet.candidate, plan);
  requirePublication(isDeepStrictEqual(qualificationReports.find(value => value.requested.gpu === false), packet.qualification),
    "PUBLICATION_PRODUCER_QUALIFICATION_CHANGED");
  const notesBytes = await publicationFile(notes, 1024 * 1024);
  requirePublication(sha256(notesBytes) === plan.github.notesSha256, "PUBLICATION_NOTES_CHANGED");
  const rawManifest = await publicationFile(join(dataDirectory, "package/package.json"), 1024 * 1024);
  const manifestFile = packet.candidate.files.find(file => file.path === "package.json");
  requirePublication(manifestFile.byteLength === rawManifest.length && manifestFile.sha256 === sha256(rawManifest),
    "PUBLICATION_MANIFEST_CHANGED");
  admitNpmManifest(JSON.parse(rawManifest), plan);
  const selected = new Map();
  const archive = await publicationFile(join(dataDirectory, packet.candidate.tarball.path), packet.candidate.tarball.byteLength);
  requirePublication(createHash("sha512").update(archive).digest("hex") === plan.candidate.archiveSha512,
    "PUBLICATION_ARCHIVE_CHANGED");
  for (const asset of plan.github.assets) {
    const raw = await publicationFile(assets[asset.name], asset.byteLength);
    requirePublication(raw.length === asset.byteLength && sha256(raw) === asset.sha256, "PUBLICATION_ASSET_CHANGED");
    const original = asset.kind === "archive" ? archive : asset.kind === "inventory" ? packet.inventory : proofBytes.get(asset.kind);
    requirePublication(original === undefined || original.equals(raw), "PUBLICATION_ASSET_PAIRING");
    selected.set(asset.name, raw);
  }
  const checksums = plan.github.assets.filter(asset => asset.kind === "checksums");
  requirePublication(checksums.length === 1, "PUBLICATION_CHECKSUMS_INVALID");
  const expectedChecksums = plan.github.assets.filter(asset => asset.kind !== "checksums")
    .toSorted((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .map(asset => `${asset.sha256}  ${asset.name}\n`).join("");
  requirePublication(selected.get(checksums[0].name).equals(Buffer.from(expectedChecksums)), "PUBLICATION_CHECKSUMS_INVALID");
  const decodedNotes = new TextDecoder("utf-8", { fatal: true }).decode(notesBytes);
  return { candidate: packet.candidate, archive: join(dataDirectory, packet.candidate.tarball.path),
    proof: join(proofsDirectory, "archive-proof.json"), notes: decodedNotes, assets: selected,
    qualification: qualificationReports };
}
