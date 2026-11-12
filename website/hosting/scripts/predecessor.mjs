import { mkdir, readFile, writeFile, rm, copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deliveryManifest, manifestName, publicationOrigin, inventory } from "./inventory.mjs";
import { sha256 } from "../../scripts/files.mjs";

// An explicit transport budget, independent of the host's larger per-file quota.
// Current and predecessor inventories remain subject to the host limits as well.
export const predecessorTransferBytes = 128 * 1024 * 1024;

/** Bound the actual streamed body, not only an optional Content-Length.
 * @param {Response} response @param {number} maximum @returns {Promise<Buffer>} */
export async function boundedBody(response, maximum) {
  if (response.status !== 200 || !response.body) throw new Error("Predecessor resource is unavailable");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maximum) throw new Error("Predecessor transfer exceeds its budget");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Read a captured public manifest plus only its current immutable files. Neither
 * old HTML nor an old host configuration is a deployment input. Missing or changed
 * bytes fail; retained files from two generations ago are never transferred.
 * @param {string} root @param {boolean} production @returns {Promise<object>} */
export async function readPredecessor(root, production = true) {
  const bytes = await readFile(join(root, manifestName));
  if (bytes.length > 8 * 1024 * 1024) throw new Error("Predecessor manifest is too large");
  const manifest = deliveryManifest(JSON.parse(bytes), production);
  const immutable = new Set(manifest.currentImmutable);
  const expected = manifest.files.filter(file => immutable.has(file.path));
  const actual = await inventory(root);
  const byPath = new Map(actual.map(file => [file.path, file]));
  if (actual.length !== expected.length + 1 || expected.some(file => {
    const found = byPath.get(file.path);
    return !found || found.sha256 !== file.sha256 || found.bytes !== file.bytes;
  })) throw new Error("Predecessor immutable files differ from their public inventory");
  return { manifest, digest: sha256(bytes) };
}

/** Capture a coherent predecessor from the admitted public origin, with no auth
 * or redirects and one absolute acquisition deadline. Reuse exact current bytes
 * where possible, avoiding redundant downloads. All originals remain local.
 * @param {string} origin @param {string} current @param {string} destination
 * @param {(url:URL,options:object)=>Promise<Response>} request @returns {Promise<void>} */
export async function acquirePredecessor(origin, current, destination, request = fetch) {
  const site = publicationOrigin(origin);
  const options = { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(60_000) };
  const manifestBytes = await boundedBody(await request(new URL(manifestName, site), options), 8 * 1024 * 1024);
  const manifest = deliveryManifest(JSON.parse(manifestBytes));
  if (manifest.origin !== site) throw new Error("Predecessor origin differs");
  const currentFiles = new Map((await inventory(current)).map(file => [file.path, file]));
  const immutable = new Set(manifest.currentImmutable);
  const required = manifest.files.filter(file => immutable.has(file.path));
  if (required.reduce((sum, file) => sum + file.bytes, manifestBytes.length) > predecessorTransferBytes) throw new Error("Predecessor exceeds the acquisition budget");
  await mkdir(destination);
  try {
    await writeFile(join(destination, manifestName), manifestBytes);
    for (const file of required) {
      const target = join(destination, file.path);
      await mkdir(dirname(target), { recursive: true });
      if (currentFiles.get(file.path)?.sha256 === file.sha256) await copyFile(join(current, file.path), target);
      else {
        const bytes = await boundedBody(await request(new URL(file.path, site), options), file.bytes);
        if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error("Predecessor asset changed bytes");
        await writeFile(target, bytes);
      }
    }
    await readPredecessor(destination);
    const final = await boundedBody(await request(new URL(manifestName, site), options), 8 * 1024 * 1024);
    if (!final.equals(manifestBytes)) throw new Error("Live website changed during acquisition");
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [current, destination] = process.argv.slice(2);
  if (!current || !destination || process.argv.length !== 4) throw new Error("Use: predecessor.mjs current-output new-predecessor");
  await acquirePredecessor(process.env.TABGRAD_SITE_URL, current, destination);
}
