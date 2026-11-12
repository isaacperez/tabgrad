import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, parseFragment } from "parse5";
import { isDeepStrictEqual } from "node:util";
import { websiteRoot } from "./config.mjs";
import { sha256, writeChanged } from "./files.mjs";
import { integrationFiles } from "./integration-files.mjs";
import { brandPaths, componentNoticePath, checkGeneratedAssets } from "./generated-assets.mjs";
import { siteOrigin, robotsTxt, articleStructuredData } from "./publication.mjs";

/** @param {string} root @param {string} directory @returns {Promise<string[]>} */
export async function outputFiles(root, directory = "") {
  const files = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const name = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symbolic link in website output: ${name}`);
    if (entry.isDirectory()) files.push(...await outputFiles(root, name));
    else if (entry.isFile()) files.push(name);
  }
  return files;
}

/** @param {object} node @param {object[]} nodes @returns {void} */
function collectNodes(node, nodes) {
  if (node.tagName) nodes.push(node);
  for (const child of node.childNodes ?? []) collectNodes(child, nodes);
}

/** @param {string} html @returns {object[]} */
function htmlNodes(html) {
  const nodes = [];
  collectNodes(parse(html), nodes);
  return nodes;
}

/** @param {object} node @param {string} name @returns {string | undefined} */
function attribute(node, name) { return node.attrs?.find((entry) => entry.name === name)?.value; }

/** @param {string} svg @param {string} path @returns {void} */
export function checkDiagram(svg, path) {
  const nodes = [];
  collectNodes(parseFragment(svg), nodes);
  if (!nodes.some((node) => node.tagName === "svg")) throw new Error(`Missing SVG root: ${path}`);
  for (const node of nodes) {
    if (["script", "foreignObject", "iframe"].includes(node.tagName)) throw new Error(`Active diagram element: ${path}`);
    for (const entry of node.attrs ?? []) {
      if (/^on/i.test(entry.name) || (["href", "xlink:href", "src"].includes(entry.name) && !entry.value.startsWith("#"))) throw new Error(`Active or external diagram reference: ${path}`);
    }
  }
  if (/@import|url\(\s*["']?(?:[a-z]+:|\/\/)/i.test(svg)) throw new Error(`External diagram style resource: ${path}`);
}

/** A content-addressed executor cannot change bytes under its immutable URL.
 * @param {Uint8Array} bytes @param {string} url @returns {void} */
export function checkExecutor(bytes, url) {
  const digest = /^\/playground\/executor-([a-f0-9]{64})\.worker\.js$/.exec(url)?.[1];
  if (!digest || sha256(bytes) !== digest) throw new Error("Executor bytes do not match its immutable URL");
}

/** @param {string} root @returns {Promise<object>} */
export async function verifyOutput(root = join(websiteRoot, "dist")) {
  const files = await outputFiles(root);
  const inventory = new Set(files);
  const data = JSON.parse(await readFile(join(websiteRoot, ".generated/site-data.json"), "utf8"));
  const assets = JSON.parse(await readFile(join(websiteRoot, ".generated/asset-data.json"), "utf8"));
  await checkGeneratedAssets(root, [...brandPaths, componentNoticePath, ...integrationFiles(data).map(file => file.path)], { authoredPaths: ["licenses/index.html"] });
  const expectedOrigin = siteOrigin(process.env.TABGRAD_SITE_URL);
  if (expectedOrigin && data.publicOrigin !== expectedOrigin) throw new Error("Build origin does not match verification origin");
  const identifiers = new Map();
  const pages = new Map();
  for (const file of files.filter((path) => path.endsWith(".html"))) {
    const html = await readFile(join(root, file), "utf8");
    if (html.includes("/Users/") || html.includes("/private/var/folders/")) throw new Error(`Private build path in ${file}`);
    const nodes = htmlNodes(html);
    const ids = new Set();
    for (const node of nodes) {
      if (node.tagName === "details" && attribute(node, "class")?.split(/\s+/).includes("diagram-source")) {
        const children = node.childNodes.filter(child => child.tagName);
        if (children.length !== 2 || children[0].tagName !== "summary" || children[1].tagName !== "pre"
          || children[1].childNodes.filter(child => child.tagName).some(child => child.tagName !== "code")) {
          throw new Error(`Diagram source contains chapter content in ${file}`);
        }
      }
      const id = attribute(node, "id");
      if (id) {
        if (ids.has(id)) throw new Error(`Duplicate HTML id in ${file}: ${id}`);
        ids.add(id);
      }
    }
    identifiers.set(file, ids); pages.set(file, nodes);
  }
  let references = 0;
  for (const [file, nodes] of pages) {
    for (const node of nodes) {
      const option = node.tagName === "option" ? attribute(node, "value") : undefined;
      const value = attribute(node, "href") ?? attribute(node, "src") ?? (option?.startsWith("/") ? option : undefined);
      if (!value) continue;
      const url = new URL(value, `https://website.invalid/${file}`);
      if (url.origin !== "https://website.invalid") {
        if (["script", "img", "source"].includes(node.tagName) && !value.startsWith("data:")) throw new Error(`External subresource in ${file}`);
        continue;
      }
      let destination = decodeURIComponent(url.pathname).replace(/^\//, "");
      if (!destination || destination.endsWith("/")) destination += "index.html";
      if (!inventory.has(destination)) throw new Error(`Missing local destination in ${file}: ${value}`);
      if (url.hash && identifiers.has(destination) && !identifiers.get(destination).has(decodeURIComponent(url.hash.slice(1)))) throw new Error(`Missing HTML fragment in ${file}: ${value}`);
      references++;
    }
  }
  for (const entry of data.documents) {
    const path = entry.route.slice(1) + "index.html";
    if (!pages.has(path)) throw new Error(`Missing admitted document: ${entry.source}`);
    for (const key of ["description", "og:description"]) {
      const summaries = pages.get(path).filter(node => node.tagName === "meta" && (attribute(node, "name") === key || attribute(node, "property") === key));
      if (!entry.description || summaries.length !== 1 || attribute(summaries[0], "content") !== entry.description) throw new Error(`Incorrect documentation summary: ${entry.source}`);
    }
    for (const id of entry.headings) if (!identifiers.get(path).has(id)) throw new Error(`Source heading identity lost in ${path}: ${id}`);
  }
  if (await readFile(join(root, "robots.txt"), "utf8") !== robotsTxt(data.publicOrigin ?? undefined)) throw new Error("Incorrect robots discovery policy");
  for (const file of integrationFiles(data)) {
    if (await readFile(join(root, file.path), "utf8") !== file.body) throw new Error(`Changed integration download: ${file.path}`);
    if (!pages.get("start/index.html").some(node => attribute(node, "href") === "/" + file.path && attribute(node, "download") === file.name)) throw new Error(`Missing named download: ${file.path}`);
  }
  for (const id of ["tabgrad", ...data.posts.map(post => `article-${post.id}`)]) {
    const bytes = await readFile(join(root, "social", `${id}.png`));
    if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || bytes.readUInt32BE(16) !== 1200 || bytes.readUInt32BE(20) !== 630) throw new Error(`Invalid social image: ${id}`);
  }
  if (data.publicOrigin) {
    const expectedPages = new Set();
    for (const [file, nodes] of pages) {
      if (file === "404.html") {
        if (!nodes.some(node => attribute(node, "name") === "robots" && attribute(node, "content") === "noindex")) throw new Error("Recovery page must not be indexed");
        continue;
      }
      const url = new URL(file.replace(/index\.html$/, ""), data.publicOrigin).href;
      expectedPages.add(url);
      const canonical = nodes.filter(node => attribute(node, "rel") === "canonical");
      if (canonical.length !== 1 || attribute(canonical[0], "href") !== url) throw new Error(`Incorrect canonical URL: ${file}`);
      const metadata = Object.fromEntries(nodes.filter(node => node.tagName === "meta").map(node => [attribute(node, "property") ?? attribute(node, "name"), attribute(node, "content")]));
      const post = data.posts.find(post => post.route.slice(1) + "index.html" === file);
      const image = new URL(`social/${post ? `article-${post.id}` : "tabgrad"}.png`, data.publicOrigin).href;
      if (metadata["og:url"] !== url || metadata["og:image"] !== image || metadata["twitter:image"] !== image || !metadata["og:image:alt"]) throw new Error(`Incorrect social metadata: ${file}`);
      if (metadata["og:type"] !== (post ? "article" : "website")) throw new Error(`Incorrect page type: ${file}`);
      if (post) {
        const structured = nodes.filter(node => node.tagName === "script" && attribute(node, "type") === "application/ld+json");
        if (structured.length !== 1 || !metadata.author || !metadata["article:published_time"]) throw new Error(`Missing article structured data: ${file}`);
        if (structured[0].parentNode?.tagName !== "head") throw new Error(`Article structured data must stay in head: ${file}`);
        const actual = JSON.parse(structured[0].childNodes.map(child => child.value ?? "").join(""));
        const expected = JSON.parse(articleStructuredData(data.publicOrigin, post.id, { title: metadata["og:title"], description: metadata.description, author: metadata.author, date: metadata["article:published_time"] }));
        if (!isDeepStrictEqual(actual, expected)) throw new Error(`Incorrect article structured data: ${file}`);
      }
    }
    const index = await readFile(join(root, "sitemap-index.xml"), "utf8");
    const seen = new Set();
    for (const [, value] of index.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const url = new URL(value);
      const file = url.pathname.slice(1);
      if (url.origin !== new URL(data.publicOrigin).origin || !inventory.has(file)) throw new Error("Invalid sitemap index");
      for (const [, page] of (await readFile(join(root, file), "utf8")).matchAll(/<loc>([^<]+)<\/loc>/g)) seen.add(page);
    }
    if (seen.size !== expectedPages.size || [...seen].some(url => !expectedPages.has(url))) throw new Error("Sitemap does not match public page routes");
  }
  // Expressive Code's Copy control stores original newlines as DEL separators;
  // rendered blank lines also contain a presentation newline of their own.
  const integrationBlocks = pages.get("start/index.html").filter((node) => node.tagName === "button")
    .map((node) => attribute(node, "data-code")?.replaceAll("\x7f", "\n"));
  for (const file of integrationFiles(data)) {
    if (!integrationBlocks.some(block => block?.trimEnd() === file.body.trimEnd())) throw new Error(`Get started cannot copy the complete integration file: ${file.path}`);
  }
  for (const file of files.filter((path) => path.startsWith("diagrams/"))) checkDiagram(await readFile(join(root, file), "utf8"), file);
  for (const [base, hashes] of [[assets.runtimeBase, assets.runtimeHashes], [assets.pyodideBase, assets.pyodideHashes]]) {
    for (const [path, expected] of Object.entries(hashes)) {
      if (sha256(await readFile(join(root, base, path))) !== expected) throw new Error(`Changed browser asset in output: ${base}${path}`);
    }
  }
  if (!inventory.has(assets.workerUrl.slice(1))) throw new Error("Missing playground worker");
  checkExecutor(await readFile(join(root, assets.workerUrl.slice(1))), assets.workerUrl);
  if (!files.some((file) => file.startsWith("pagefind/") && file.endsWith(".js"))) throw new Error("Missing local search index");
  if (files.some((file) => /(?:^|\/)(?:node_modules|\.generated|\.env|scripts)(?:\/|$)/.test(file))) throw new Error("Private/tooling input in static output");
  const report = { htmlPages: pages.size, documents: data.documents.length, diagrams: data.diagrams, localReferences: references, emittedFiles: files.length, runtimeVersion: assets.runtimeVersion, pyodideVersion: assets.pyodideVersion, sourceRevision: data.sourceRevision, localChanges: data.localChanges };
  await writeChanged(join(websiteRoot, ".generated/verification.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(await verifyOutput());
