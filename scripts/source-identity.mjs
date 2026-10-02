import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Enumerate regular TypeScript files with slash-separated root-relative paths.
 * Reject symbolic links, including directory links, rather than follow sources
 * outside the caller's root or include the same physical tree more than once.
 *
 * @param {string} rootPath
 * @returns {Promise<string[]>}
 */
async function listTypeScriptSources(rootPath) {
  const paths = [];
  const pending = [{ absolutePath: rootPath, relativePath: "" }];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await fs.readdir(directory.absolutePath, { withFileTypes: true })) {
      const relativePath = directory.relativePath === ""
        ? entry.name : `${directory.relativePath}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new Error(`Source identity does not allow symbolic links: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        pending.push({ absolutePath: join(directory.absolutePath, entry.name), relativePath });
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        paths.push(relativePath);
      }
    }
  }
  return paths.sort();
}

/**
 * Hash a stable local source tree for contributor measurement reports.
 * For each sorted regular `.ts` path, append its UTF-8 root-relative name and
 * raw file bytes to SHA-256. This retains the former flat-tree byte stream.
 * Includes `.d.ts`; ignores other extensions. Traversal/read failures propagate.
 * The root is a trusted directory file URL; this is not an atomic filesystem
 * snapshot, a distribution-freshness check or a proof of numerical execution.
 *
 * @param {URL} root
 * @returns {Promise<string>} Lowercase hexadecimal SHA-256 digest.
 */
export async function fingerprintTypeScriptSources(root) {
  const rootPath = fileURLToPath(root);
  const paths = await listTypeScriptSources(rootPath);
  const fingerprint = createHash("sha256");
  for (const relativePath of paths) {
    fingerprint.update(relativePath).update(await fs.readFile(join(rootPath, ...relativePath.split("/"))));
  }
  return fingerprint.digest("hex");
}
