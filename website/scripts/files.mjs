import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** @param {string | Uint8Array} value @returns {string} */
export function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

/** @param {string} path @param {string | Uint8Array} value @returns {Promise<void>} */
export async function writeChanged(path, value) {
  const next = Buffer.from(value);
  try { if ((await readFile(path)).equals(next)) return; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next);
}

/** @param {string} value @returns {string} */
export function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
