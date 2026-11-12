import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export const brandPaths = ["brand/tabgrad-logo.svg", "brand/tabgrad-logo-dark.svg", "brand/tabgrad-small.svg"];
export const componentNoticePath = "licenses/website-components.txt";
const generatedNamespaces = new Set(["brand", "licenses", "examples"]);

/** @param {string} root @param {string} path @param {Set<string>} files
 * @param {Set<string>} directories @param {Set<string>} seen @returns {Promise<void>} */
async function inspectAsset(root, path, files, directories, seen) {
  let entry;
  try { entry = await lstat(join(root, path)); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (entry.isSymbolicLink()) throw new Error(`Symbolic link in generated assets: ${path}`);
  if (entry.isDirectory() && directories.has(path)) {
    for (const name of (await readdir(join(root, path))).sort())
      await inspectAsset(root, `${path}/${name}`, files, directories, seen);
  } else if (entry.isFile() && files.has(path)) seen.add(path);
  else throw new Error(`Unexpected generated asset: ${path}. Remove obsolete generated files before rebuilding.`);
}

/** Check only the namespaces owned by these declarations; never delete entries.
 * Preparation allows not-yet-written files. Final output requires every generated
 * file, while explicitly admitted authored routes may share a namespace.
 * @param {string} root @param {string[]} expected
 * @param {{allowMissing?:boolean,authoredPaths?:string[]}} options @returns {Promise<void>} */
export async function checkGeneratedAssets(root, expected, { allowMissing = false, authoredPaths = [] } = {}) {
  const files = new Set([...expected, ...authoredPaths]);
  const directories = new Set();
  const namespaces = new Set(expected.map(path => path.split("/")[0]));
  for (const path of files) {
    const parts = path.split("/");
    if (parts.length < 2 || !generatedNamespaces.has(parts[0]) || !namespaces.has(parts[0])
      || parts.some(part => !part || part === "." || part === ".." || part.includes("\\") || part.includes("\0")))
      throw new Error(`Invalid generated asset declaration: ${path}`);
    for (let length = 1; length < parts.length; length++) directories.add(parts.slice(0, length).join("/"));
  }
  try {
    const entry = await lstat(root);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Generated asset root must be a regular directory");
  } catch (error) {
    if (!(allowMissing && error.code === "ENOENT")) throw error;
  }
  const seen = new Set();
  for (const namespace of namespaces) await inspectAsset(root, namespace, files, directories, seen);
  if (!allowMissing) for (const path of expected)
    if (!seen.has(path)) throw new Error(`Missing generated asset: ${path}`);
}
