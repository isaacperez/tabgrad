import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import GithubSlugger from "github-slugger";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { visit } from "unist-util-visit";
import { documentDirectories, documentDescriptions, references, documentRoute, repositoryRoot, repositoryUrl } from "./config.mjs";
import { escapeHtml, sha256 } from "./files.mjs";
import { sizeDiagramImages } from "./diagram-layout.mjs";
import { collectTrackedMarkdown } from "./source-files.mjs";

const markdown = unified().use(remarkParse).use(remarkGfm).use(remarkStringify, { fences: true });

/** @param {import('mdast').Nodes} node @returns {string} */
function nodeText(node) {
  if ("value" in node) return node.value;
  if ("children" in node) return node.children.map(nodeText).join("");
  return "alt" in node ? node.alt : "";
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
  return collectTrackedMarkdown(root, "docs", source => individual.includes(source)
    || directories.some(directory => source.startsWith(`docs/${directory}/`)));
}

/** @param {{source:string, body:string}[]} entries @returns {Map<string, {source:string, body:string, title:string, description:string, route:string, headings:string[]}>} */
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
    const introduction = tree.children.find(node => node.type === "paragraph");
    const description = documentDescriptions[entry.source] ?? ((introduction ? nodeText(introduction).replace(/\s+/g, " ").trim() : "") || title);
    routes.add(route);
    result.set(entry.source, { ...entry, title, description, route, headings });
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
 * @returns {{render:(sizes?:Map<string,{width:number,height:number}>)=>string, diagrams:{id:string, definition:string, label:string}[]}}
 */
export function adaptDocument(entry, documents, revision, options = {}) {
  const metadata = documents.get(entry.source);
  const tree = markdown.parse(entry.body);
  const diagrams = [];
  const diagramNodes = [];
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
      // Keep the raw HTML block intact when Markdown is parsed again. Literal
      // blank lines can end it and turn its closing tags into a code block.
      const sourceHtml = escapeHtml(definition).replaceAll("\n", "&#10;").replaceAll("\r", "&#13;");
      node.type = "html";
      node.value = `<figure class="documentation-diagram"><div class="diagram-viewport" tabindex="0" role="group" aria-label="Scrollable diagram: ${escapeHtml(label)}"><img src="/diagrams/${id}.svg" alt="${escapeHtml(label)}" loading="lazy"></div><figcaption>${escapeHtml(heading)} · <a href="/diagrams/${id}.svg">Open full-size diagram</a><span class="diagram-hint">Scroll sideways when needed.</span></figcaption></figure>\n<details class="diagram-source disclosure"><summary>Diagram source</summary><pre><code>${sourceHtml}</code></pre></details>`;
      diagramNodes.push({ node, markup: node.value });
      delete node.lang;
      delete node.meta;
    }
  });
  return {
    diagrams,
    render(sizes) {
      for (const { node, markup } of diagramNodes) node.value = sizes ? sizeDiagramImages(markup, sizes) : markup;
      return markdown.stringify(tree);
    },
  };
}

/** @param {string} source @param {string} language @param {string} [title] @returns {string} */
export function firstCodeBlock(source, language, title) {
  const tree = markdown.parse(source);
  let result, matches = 0;
  visit(tree, "code", (node) => {
    if (node.lang !== language || title !== undefined && node.meta !== `title="${title}"`) return;
    matches++;
    result ??= node.value;
  });
  if (result === undefined) throw new Error(`No ${language} sample in documentation`);
  if (title !== undefined && matches !== 1) throw new Error(`Duplicate integration file: ${title}`);
  return result;
}
