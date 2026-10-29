import { join } from "node:path";
import { lstat, readFile } from "node:fs/promises";
import { canonicalBytes, sha256 } from "./release-record-data.mjs";
import { exactPublicationKeys, requirePublication } from "./publication-plan.mjs";

const documents = ["producer.json", "qualification.json", "ci-evidence.json", "trusted-root.jsonl", "verification.json",
  "api-run.json", "api-jobs.json", "api-data.json", "api-proofs.json", "release-qualification.json"];
const limit = 4 * 1024 * 1024;

/** Preserve original bytes needed after temporary CI outputs expire. No private config. */
export async function createPublicationEvidence({ dataDirectory, verificationDirectory, qualification }) {
  const files = [];
  for (const name of documents) {
    const path = name === "release-qualification.json" ? qualification
      : join(["producer.json", "qualification.json"].includes(name) ? dataDirectory : verificationDirectory, name);
    const stat = await lstat(path);
    requirePublication(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= limit,
      "PUBLICATION_EVIDENCE_INPUT");
    const raw = await readFile(path);
    files.push({ name, byteLength: raw.length, sha256: sha256(raw), base64: raw.toString("base64") });
  }
  return canonicalBytes({ schemaVersion: 1, input: "original-producer-verification-documents", files });
}

/** Data-only extraction; callers keep source/trust admission separate from decoding. */
export function decodePublicationEvidence(bytes) {
  requirePublication(bytes.length <= 64 * 1024 * 1024, "PUBLICATION_EVIDENCE_LIMIT");
  const packet = JSON.parse(bytes);
  requirePublication(exactPublicationKeys(packet, ["schemaVersion", "input", "files"]) && packet.schemaVersion === 1
    && packet.input === "original-producer-verification-documents" && Array.isArray(packet.files)
    && packet.files.length === documents.length && canonicalBytes(packet).equals(bytes), "PUBLICATION_EVIDENCE_INVALID");
  const decoded = new Map();
  for (const file of packet.files) {
    requirePublication(exactPublicationKeys(file, ["name", "byteLength", "sha256", "base64"])
      && documents.includes(file.name) && !decoded.has(file.name)
      && Number.isSafeInteger(file.byteLength) && file.byteLength > 0 && file.byteLength <= limit
      && typeof file.sha256 === "string" && /^[0-9a-f]{64}$/.test(file.sha256)
      && typeof file.base64 === "string" && file.base64.length === Math.ceil(file.byteLength / 3) * 4,
    "PUBLICATION_EVIDENCE_INVALID");
    const raw = Buffer.from(file.base64, "base64");
    requirePublication(raw.length === file.byteLength && raw.toString("base64") === file.base64
      && sha256(raw) === file.sha256, "PUBLICATION_EVIDENCE_CHANGED");
    decoded.set(file.name, raw);
  }
  return decoded;
}
