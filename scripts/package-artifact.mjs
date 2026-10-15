import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

/** Safe contributor diagnostics; input paths and package output are not messages. */
export class PackageArtifactError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PackageArtifactError";
    this.code = code;
  }
}

function requireArtifact(condition, code, message) {
  if (!condition) throw new PackageArtifactError(code, message);
}

function digest(bytes, algorithm = "sha256", encoding = "hex") {
  return createHash(algorithm).update(bytes).digest(encoding);
}

/** Compressed-byte identity, shared by admission and the npm cache witness. */
export function packageArchiveIdentity(bytes) {
  return { byteLength: bytes.length, sha256: digest(bytes), integrity: `sha512-${digest(bytes, "sha512", "base64")}` };
}

function packagePath(path) {
  return typeof path === "string"
    && /^(?:dist\/[A-Za-z0-9_./-]+|LICENSE|README\.md|package\.json)$/.test(path)
    && path.split("/").every(part => part !== "" && part !== "." && part !== "..")
    && path !== "dist/testing.js" && path !== "dist/testing.d.ts";
}

/** Snapshot externally admitted expectations; this does not authenticate them. */
export function validatePackageEvidence(input) {
  const expected = structuredClone(input);
  const valid = expected?.schemaVersion === 1
    && typeof expected.sourceRevision === "string" && /^[0-9a-f]{40}$/.test(expected.sourceRevision)
    && typeof expected.name === "string" && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(expected.name)
    && typeof expected.version === "string" && /^[0-9][0-9A-Za-z.+-]*$/.test(expected.version)
    && (expected.private === undefined || typeof expected.private === "boolean")
    && expected.staticDirectory === "package/dist"
    && Array.isArray(expected.files) && expected.files.length > 0
    && Number.isSafeInteger(expected.tarball?.byteLength) && expected.tarball.byteLength > 0
    && typeof expected.tarball.sha256 === "string" && /^[0-9a-f]{64}$/.test(expected.tarball.sha256)
    && typeof expected.tarball.integrity === "string";
  requireArtifact(valid, "EVIDENCE_INVALID", "Expected candidate evidence has an invalid shape.");
  const paths = new Set();
  for (const file of expected.files) {
    requireArtifact(file !== null && typeof file === "object" && packagePath(file.path)
      && Number.isSafeInteger(file.byteLength) && file.byteLength >= 0
      && typeof file.sha256 === "string" && /^[0-9a-f]{64}$/.test(file.sha256)
      && !paths.has(file.path), "EVIDENCE_INVALID", "Expected package inventory is invalid or duplicated.");
    paths.add(file.path);
  }
  requireArtifact(["package.json", "README.md", "LICENSE"].every(path => paths.has(path)),
    "EVIDENCE_INVALID", "Expected package inventory lacks required metadata.");
  return expected;
}

function tarString(field) {
  const end = field.indexOf(0);
  requireArtifact(field.every(byte => byte < 128)
    && (end === -1 || field.subarray(end).every(byte => byte === 0)),
    "ARCHIVE_INVALID", "Archive text field has ambiguous padding.");
  return field.subarray(0, end === -1 ? field.length : end).toString("ascii");
}

function tarNumber(field) {
  const text = field.toString("ascii");
  requireArtifact(field.every(byte => byte < 128) && /^ *[0-7]+[ \0]*$/.test(text),
    "ARCHIVE_INVALID", "Archive numeric field is not supported octal.");
  return Number.parseInt(text.trim(), 8);
}

// The producer emits portable ustar regular files. Reject extension records,
// links and special entries instead of making npm and this reader disagree.
function archiveFiles(compressed) {
  let bytes;
  try { bytes = gunzipSync(compressed); }
  catch { throw new PackageArtifactError("ARCHIVE_INVALID", "Archive gzip content is invalid."); }
  const files = new Map();
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      requireArtifact(bytes.length - offset >= 1024 && bytes.length % 512 === 0
        && bytes.subarray(offset).every(byte => byte === 0), "ARCHIVE_INVALID", "Archive termination is invalid.");
      return files;
    }
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 32 : header[index];
    // A missing terminator can make npm absorb the following type byte.
    requireArtifact((header[155] === 0 || header[155] === 32)
      && checksum === tarNumber(header.subarray(148, 156))
      && header.subarray(257, 265).equals(Buffer.from("ustar\0" + "00"))
      && (header[156] === 48 || header[156] === 0)
      && header.subarray(157, 257).every(byte => byte === 0), "ARCHIVE_INVALID", "Archive header or entry type is unsupported.");
    const prefix = tarString(header.subarray(345, 500));
    const name = tarString(header.subarray(0, 100));
    const path = prefix === "" ? name : `${prefix}/${name}`;
    requireArtifact(path.startsWith("package/") && packagePath(path.slice(8)) && !files.has(path.slice(8)),
      "ARCHIVE_INVALID", "Archive path is unsupported or duplicated.");
    const size = tarNumber(header.subarray(124, 136));
    const start = offset + 512;
    const next = start + Math.ceil(size / 512) * 512;
    requireArtifact(next <= bytes.length && bytes.subarray(start + size, next).every(byte => byte === 0),
      "ARCHIVE_INVALID", "Archive payload or padding is invalid.");
    files.set(path.slice(8), bytes.subarray(start, start + size));
    offset = next;
  }
  throw new PackageArtifactError("ARCHIVE_INVALID", "Archive is truncated or lacks termination.");
}

function verifyFile(bytes, expected) {
  requireArtifact(bytes.length === expected.byteLength && digest(bytes) === expected.sha256,
    "CONTENT_MISMATCH", "Package file bytes differ from the expected inventory.");
}

/** Inspect bytes before npm sees them; no archive extraction or code execution. */
function inspectPackageArchive(bytes, expected, archive) {
  requireArtifact(archive.byteLength === expected.tarball.byteLength && archive.sha256 === expected.tarball.sha256
    && archive.integrity === expected.tarball.integrity,
  "ARCHIVE_MISMATCH", "Archive bytes differ from the approved identity.");
  const files = archiveFiles(bytes);
  requireArtifact(files.size === expected.files.length, "CONTENT_MISMATCH", "Archive file set differs from the expected inventory.");
  for (const file of expected.files) {
    requireArtifact(files.has(file.path), "CONTENT_MISMATCH", "Archive lacks an expected file.");
    verifyFile(files.get(file.path), file);
  }
  let metadata;
  try { metadata = JSON.parse(files.get("package.json").toString("utf8")); }
  catch { throw new PackageArtifactError("METADATA_INVALID", "Archived package metadata is invalid JSON."); }
  requireArtifact(metadata?.name === expected.name && metadata.version === expected.version
    && metadata.private === expected.private && metadata.type === "module", "METADATA_MISMATCH", "Archived package identity differs from the expectations.");
  requireArtifact(["dependencies", "optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies"]
    .every(key => metadata[key] === undefined || (metadata[key] !== null && typeof metadata[key] === "object"
      && Object.keys(metadata[key]).length === 0)), "METADATA_INVALID", "This offline package profile admits no installed dependencies.");
  requireArtifact(files.get("README.md").toString("utf8").startsWith(
    `# Tabgrad ${expected.version}\n\nSource commit: \`${expected.sourceRevision}\`.\n\n`),
  "SOURCE_MISMATCH", "Archived documentation does not identify the expected source.");
  return metadata;
}

/** Copy the bytes read once into owned storage; npm receives only this copy. */
export async function stagePackageArchive(suppliedTarball, input, ownedDirectory) {
  const expected = validatePackageEvidence(input);
  const bytes = await readFile(suppliedTarball);
  const archive = packageArchiveIdentity(bytes);
  let metadata;
  try { metadata = inspectPackageArchive(bytes, expected, archive); }
  catch (error) { error.archive = archive; throw error; }
  const tarball = join(ownedDirectory, "approved.tgz");
  await writeFile(tarball, bytes, { flag: "wx", mode: 0o600 });
  // Check the actual copy, not a later reread of the user-controlled pathname.
  requireArtifact((await readFile(tarball)).equals(bytes), "ARCHIVE_MISMATCH", "Owned archive copy differs from the inspected bytes.");
  return { tarball, metadata, expected, archive };
}

async function collectDirectoryFiles(directory, prefix, paths) {
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await collectDirectoryFiles(directory, path, paths);
    else {
      requireArtifact(entry.isFile(), "CONTENT_MISMATCH", "Installed content contains a link or special entry.");
      paths.push(path);
    }
  }
}

/** Compare a complete owned installed/static tree, including unexpected files. */
export async function verifyPackageDirectory(directory, files) {
  const paths = [];
  await collectDirectoryFiles(directory, "", paths);
  const expected = new Map(files.map(file => [file.path, file]));
  requireArtifact(paths.length === expected.size && paths.every(path => expected.has(path)),
    "CONTENT_MISMATCH", "Installed or static file set differs from the admitted inventory.");
  for (const path of paths) verifyFile(await readFile(join(directory, path)), expected.get(path));
}
