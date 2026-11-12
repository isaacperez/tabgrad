import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isImmutableAsset } from "../../scripts/asset-identity.mjs";
import { sha256 } from "../../scripts/files.mjs";
import { siteOrigin } from "../../scripts/publication.mjs";

export const manifestName = "website-delivery.json";
export const hostingLimits = { files: 20_000, fileBytes: 25 * 1024 * 1024, headerRules: 100, headerLine: 2_000 };
const hashPattern = /^[a-f0-9]{64}$/;

/** @param {unknown} value @returns {string} */
export function assetPath(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_@./-]*$/.test(value)
    || value.split("/").some(part => !part || part.startsWith("."))) throw new Error("Invalid payload path");
  return value;
}

/** @param {unknown} value @param {boolean} production @returns {string} */
export function publicationOrigin(value, production = true) {
  if (typeof value !== "string") throw new Error("An explicit website origin is required");
  const origin = siteOrigin(value);
  const hostname = new URL(origin).hostname;
  if (production && (/(?:^|\.)(?:invalid|test|localhost|local|example\.com|example\.net|example\.org)$/.test(hostname)
    || hostname.includes(":") || /^[\d.]+$/.test(hostname))) throw new Error("A preview or reserved origin cannot be published");
  return origin;
}

/** Inventory regular files only, rejecting links and special entries including the root.
 * @param {string} root @param {string} prefix @returns {Promise<Array<{path:string,sha256:string,bytes:number}>>} */
export async function inventory(root, prefix = "") {
  const entry = await lstat(join(root, prefix));
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Payload root must be a regular directory");
  const files = [];
  for (const child of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = assetPath(prefix ? `${prefix}/${child.name}` : child.name);
    if (child.isDirectory()) files.push(...await inventory(root, path));
    else if (child.isFile()) {
      if ((await lstat(join(root, path))).size > hostingLimits.fileBytes) throw new Error(`File exceeds the static-host limit: ${path}`);
      const bytes = await readFile(join(root, path));
      if (bytes.byteLength > hostingLimits.fileBytes) throw new Error(`File exceeds the static-host limit: ${path}`);
      files.push({ path, sha256: sha256(bytes), bytes: bytes.byteLength });
    } else throw new Error(`Nonregular payload entry: ${path}`);
    if (files.length > hostingLimits.files) throw new Error("Too many static files");
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

/** @param {unknown} entries @returns {Array<{path:string,sha256:string,bytes:number}>} */
export function fileRecords(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > hostingLimits.files) throw new Error("Invalid file inventory");
  const seen = new Set();
  for (const file of entries) {
    if (!file || typeof file !== "object" || !hashPattern.test(file.sha256) || !Number.isSafeInteger(file.bytes)
      || file.bytes < 0 || file.bytes > hostingLimits.fileBytes || Object.keys(file).sort().join() !== "bytes,path,sha256") throw new Error("Invalid file record");
    assetPath(file.path);
    if (seen.has(file.path)) throw new Error("Duplicate payload path");
    seen.add(file.path);
  }
  return entries;
}

/** @param {unknown} value @param {boolean} production @returns {object} */
export function deliveryManifest(value, production = true) {
  if (!value || typeof value !== "object" || value.format !== 1 || !/^[a-f0-9]{40}$/.test(value.revision)
    || (value.previous !== null && !hashPattern.test(value.previous))
    || typeof value.publishable !== "boolean" || (production && !value.publishable)
    || Object.keys(value).sort().join() !== "currentImmutable,files,format,origin,previous,publishable,revision") throw new Error("Invalid or nonpublishable delivery manifest");
  publicationOrigin(value.origin, production);
  fileRecords(value.files);
  const paths = new Set(value.files.map(file => file.path));
  if (paths.has(manifestName) || !paths.has("_headers") || !paths.has("404.html")) throw new Error("Incomplete delivery manifest");
  if (!Array.isArray(value.currentImmutable) || new Set(value.currentImmutable).size !== value.currentImmutable.length
    || value.currentImmutable.some(path => !paths.has(path) || !isImmutableAsset("/" + path))) throw new Error("Invalid immutable inventory");
  return value;
}

/** @param {object[]} expected @param {object[]} actual @returns {void} */
export function sameInventory(expected, actual) {
  const byPath = new Map(actual.map(file => [file.path, file]));
  if (expected.length !== actual.length || expected.some(file => {
    const found = byPath.get(file.path);
    return !found || found.sha256 !== file.sha256 || found.bytes !== file.bytes;
  })) throw new Error("Payload files differ from the verified inventory");
}

/** Verify every byte, including generated rules, and reject extra files before a
 * credential-bearing command. The expected digest comes from this run's producer.
 * @param {string} root @param {{digest?:string,production?:boolean}} options @returns {Promise<object>} */
export async function verifyPayload(root, { digest, production = true } = {}) {
  const bytes = await readFile(join(root, manifestName));
  if (digest !== undefined && (!hashPattern.test(digest) || sha256(bytes) !== digest)) throw new Error("Delivery identity changed");
  const manifest = deliveryManifest(JSON.parse(bytes), production);
  const files = await inventory(root);
  if (files.length > hostingLimits.files) throw new Error("Too many static files");
  sameInventory(manifest.files, files.filter(file => file.path !== manifestName));
  return { manifest, digest: sha256(bytes) };
}
