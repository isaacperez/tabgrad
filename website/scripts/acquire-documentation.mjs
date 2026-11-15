/** Explicit source preparation, separate from rendering and verification. */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { documentationCataloguePath, parseReleaseCatalogue } from "../../scripts/release-documentation.mjs";
import { readReleaseInput } from "./release-input.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const catalogue = parseReleaseCatalogue(await readFile(resolve(root, documentationCataloguePath)));
const release = readReleaseInput(process.env.TABGRAD_WEBSITE_RELEASE_INPUT)?.release;
const sources = [...new Set([...catalogue.releases.filter(entry => entry.source !== "candidate").map(entry => entry.source),
  ...(release ? [release.sourceRevision] : [])])];
const missing = [];
for (const source of sources) {
  try {
    if (execFileSync("git", ["cat-file", "-t", source], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() !== "commit") throw new Error("Not a commit");
  } catch { missing.push(source); }
}
if (missing.length) execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", ...missing], { cwd: root, stdio: "inherit" });
for (const source of sources) if (execFileSync("git", ["cat-file", "-t", source], { cwd: root, encoding: "utf8" }).trim() !== "commit") throw new Error("Missing prepared documentation source");
console.log(`Documentation source preparation complete: ${sources.length} exact commits.`);
