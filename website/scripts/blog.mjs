import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { collectTrackedMarkdown } from "./source-files.mjs";
import { writeChanged } from "./files.mjs";

export const blogDirectory = "website/content/blog";

/** The filename owns an article's public route; metadata cannot replace it.
 * @param {string} source @returns {string}
 */
export function articleId(source) {
  const match = /^website\/content\/blog\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/.exec(source);
  if (!match) throw new Error(`Invalid blog source path: ${source}`);
  return match[1];
}

/** Reconcile an owned, ignored collection before Astro reads it.
 * @param {string} root @param {string} destination
 * @returns {Promise<{source: string, id: string, route: string}[]>}
 */
export async function prepareBlog(root, destination) {
  const sources = await collectTrackedMarkdown(root, blogDirectory);
  const posts = sources.map(entry => ({ ...entry, id: articleId(entry.source) }));
  await mkdir(destination, { recursive: true });
  const current = new Set(posts.map(post => `${post.id}.md`));
  for (const entry of await readdir(destination, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) throw new Error(`Unexpected generated blog entry: ${entry.name}`);
    if (!current.has(entry.name)) await rm(join(destination, entry.name));
  }
  for (const post of posts) await writeChanged(join(destination, `${post.id}.md`), post.body);
  return posts.map(({ source, id }) => ({ source, id, route: `/blog/${id}/` }));
}
