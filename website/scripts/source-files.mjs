import { execFileSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

/** @param {string} root @param {string} source @param {Set<string>} checked @returns {Promise<void>} */
async function checkSourcePath(root, source, checked) {
  const parts = source.split("/");
  for (let count = 1; count <= parts.length; count++) {
    const prefix = parts.slice(0, count).join("/");
    if (checked.has(prefix)) continue;
    if ((await lstat(join(root, prefix))).isSymbolicLink()) throw new Error(`Symbolic link in public Markdown: ${prefix}`);
    checked.add(prefix);
  }
}

/** Read one explicitly named data input only after tracked-path and symlink admission.
 * @param {string} root @param {string} source @param {boolean} optional
 * @returns {Promise<string|undefined>} */
export async function readTrackedSource(root, source, optional = false) {
  if (typeof source !== "string" || /[\u0000-\u001f\\:]/.test(source)
    || source.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Unsafe public source path");
  const paths = execFileSync("git", ["ls-files", "-z", "--", source], { cwd: root, encoding: "utf8" }).split("\0");
  if (!paths.includes(source)) {
    if (optional) return undefined;
    throw new Error(`Public data input is not tracked: ${source}`);
  }
  await checkSourcePath(root, source, new Set());
  return readFile(join(root, source), "utf8");
}

/** Read current Markdown bytes only after Git membership and symlink admission.
 * @param {string} root
 * @param {string} directory
 * @param {(source: string) => boolean} select
 * @returns {Promise<{source: string, body: string}[]>}
 */
export async function collectTrackedMarkdown(root, directory, select = () => true) {
  const tracked = execFileSync("git", ["ls-files", "-z", "--", directory], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const selected = [...new Set(tracked.filter(source => source.endsWith(".md") && select(source)))].sort();
  const result = [];
  const checked = new Set();
  for (const source of selected) {
    await checkSourcePath(root, source, checked);
    result.push({ source, body: await readFile(join(root, source), "utf8") });
  }
  return result;
}
