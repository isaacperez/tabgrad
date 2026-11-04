import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, posix } from "node:path";
import GithubSlugger from "github-slugger";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { visit } from "unist-util-visit";
import { documentDirectories, references, documentRoute, repositoryRoot, repositoryUrl } from "./config.mjs";
import { escapeHtml, sha256 } from "./files.mjs";

const markdown = unified().use(remarkParse).use(remarkGfm).use(remarkStringify, { fences: true });

/** @param {import('mdast').Nodes} node @returns {string} */
function nodeText(node) {
  if ("value" in node) return node.value;
  if ("children" in node) return node.children.map(nodeText).join("");
  return "alt" in node ? node.alt : "";
}

/** @param {string} root @param {string} source @param {Set<string>} checked @returns {Promise<void>} */
async function checkSourcePath(root, source, checked) {
  const parts = source.split("/");
  for (let count = 1; count <= parts.length; count++) {
    const prefix = parts.slice(0, count).join("/");
    if (checked.has(prefix)) continue;
    if ((await lstat(join(root, prefix))).isSymbolicLink()) throw new Error(`Symbolic link in public documentation: ${prefix}`);
    checked.add(prefix);
  }
}

/**
 * Read only the public source categories and explicitly admitted usage pages.
 * @param {string} root
 * @param {{directories?: string[], individual?: string[]}} options
 * @returns {Promise<{source: string, body: string}[]>}
 */
export async function collectDocuments(root = repositoryRoot, options = {}) {
  const directories = options.directories ?? documentDirectories;
  const individual = options.individual ?? ["docs/javascript-api.md", "docs/compatibility.md", ...references.map((name) => `docs/reference/${name}.md`)];
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "docs"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const selected = tracked.filter((source) => source.endsWith(".md") && (individual.includes(source)
    || directories.some((directory) => source.startsWith(`docs/${directory}/`))));
  const documents = [];
  const checked = new Set();
  for (const source of [...new Set(selected)].sort()) {
    await checkSourcePath(root, source, checked);
    documents.push({ source, body: await readFile(join(root, source), "utf8") });
  }
  return documents;
}

/** @param {{source:string, body:string}[]} entries @returns {Map<string, {source:string, body:string, title:string, route:string, headings:string[]}>} */
export function createDocumentIndex(entries) {
  const result = new Map();
  const routes = new Set();
  for (const entry of entries) {
    const route = documentRoute(entry.source);
    if (routes.has(route)) throw new Error(`Documentation route collision: ${entry.source}`);
    const tree = markdown.parse(entry.body);
    const slugger = new GithubSlugger();
    const headings = [];
    let title;
    visit(tree, "heading", (node) => {
      const text = nodeText(node);
      headings.push(slugger.slug(text));
      if (node.depth === 1 && !title) title = text;
    });
    if (!title) throw new Error(`Missing document title: ${entry.source}`);
    routes.add(route);
    result.set(entry.source, { ...entry, title, route, headings });
  }
  return result;
}

/** @param {string} target @param {string} source @param {Map} documents @param {string} revision @returns {string} */
function rewriteLink(target, source, documents, revision) {
  if (!target) return target;
  const parsed = new URL(target, "https://source.invalid/");
  if (/^[a-z][a-z\d+.-]*:/i.test(target)) {
    if (!["https:", "http:", "mailto:"].includes(parsed.protocol)) throw new Error(`Unsupported link scheme in ${source}`);
    const prefixes = [`${repositoryUrl}/blob/main/`, `${repositoryUrl}/blob/${revision}/`];
    const prefix = prefixes.find((value) => target.startsWith(value));
    if (!prefix) return target;
    target = target.slice(prefix.length);
    source = "README.md";
  }
  const hashAt = target.indexOf("#");
  const path = decodeURIComponent(hashAt < 0 ? target : target.slice(0, hashAt));
  const fragment = hashAt < 0 ? "" : target.slice(hashAt + 1);
  const destination = path ? posix.normalize(posix.join(posix.dirname(source), path)) : source;
  if (destination.startsWith("../") || destination.startsWith("/")) throw new Error(`Link outside the repository in ${source}: ${target}`);
  const entry = documents.get(destination);
  if (entry) {
    if (fragment && !entry.headings.includes(decodeURIComponent(fragment))) {
      throw new Error(`Unknown document fragment in ${source}: ${destination}#${fragment}`);
    }
    return entry.route + (fragment ? `#${fragment}` : "");
  }
  if (!existsSync(join(repositoryRoot, destination))) throw new Error(`Missing repository destination in ${source}: ${destination}`);
  return `${repositoryUrl}/blob/${revision}/${destination}` + (fragment ? `#${fragment}` : "");
}

/**
 * Adapt presentation links and diagrams without interpreting executable samples.
 * @param {{source:string, body:string}} entry
 * @param {Map} documents
 * @param {string} revision
 * @param {{diagramKey?: string}} options
 * @returns {{markdown:string, diagrams:{id:string, definition:string, label:string}[]}}
 */
export function adaptDocument(entry, documents, revision, options = {}) {
  const metadata = documents.get(entry.source);
  const tree = markdown.parse(entry.body);
  const diagrams = [];
  let heading = metadata.title;
  visit(tree, (node) => {
    if (node.type === "heading") heading = nodeText(node);
    if (node.type === "link" || node.type === "definition" || node.type === "image") {
      node.url = rewriteLink(node.url, entry.source, documents, revision);
    }
    if (node.type === "code" && node.lang === "mermaid") {
      const definition = node.value;
      const id = sha256(definition + (options.diagramKey ?? ""));
      const label = `${metadata.title}: ${heading}`;
      diagrams.push({ id, definition, label });
      node.type = "html";
      node.value = `<figure class="documentation-diagram"><img src="/diagrams/${id}.svg" alt="${escapeHtml(label)}" loading="lazy"><figcaption>${escapeHtml(heading)} · <a href="/diagrams/${id}.svg">Open full-size SVG</a></figcaption></figure>\n<details class="diagram-source"><summary>Diagram source</summary><pre><code>${escapeHtml(definition)}</code></pre></details>`;
      delete node.lang;
      delete node.meta;
    }
  });
  return { markdown: markdown.stringify(tree), diagrams };
}

/** @param {string} source @param {string} language @returns {string} */
export function firstCodeBlock(source, language) {
  const tree = markdown.parse(source);
  let result;
  visit(tree, "code", (node) => { if (result === undefined && node.lang === language) result = node.value; });
  if (result === undefined) throw new Error(`No ${language} sample in documentation`);
  return result;
}
