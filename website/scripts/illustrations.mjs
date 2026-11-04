import { readFile } from "node:fs/promises";

export const illustrationNames = ["browser", "first-gradient", "weighted-sum", "functional-gradients", "matrix-products", "learning", "open-source", "conversation", "backends"];

/** Wrap a known maintained drawing. Source acquisition belongs to its builder.
 * @param {string} name @param {string} svg @returns {string}
 */
export function illustrationMarkup(name, svg) {
  if (!illustrationNames.includes(name)) throw new Error(`Unknown website illustration: ${name}`);
  return `<span class="illustration" data-illustration="${name}" aria-hidden="true">${svg}</span>`;
}

/** The Markdown generator runs directly in Node, outside the Astro bundler.
 * @param {string} name @returns {Promise<string>}
 */
export async function loadIllustration(name) {
  if (!illustrationNames.includes(name)) throw new Error(`Unknown website illustration: ${name}`);
  return illustrationMarkup(name, await readFile(new URL(`../src/assets/illustrations/${name}.svg`, import.meta.url), "utf8"));
}
