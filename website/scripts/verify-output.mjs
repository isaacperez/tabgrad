import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, parseFragment } from "parse5";
import { websiteRoot } from "./config.mjs";
import { sha256, writeChanged } from "./files.mjs";

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

/** @param {string} root @returns {Promise<object>} */
export async function verifyOutput(root = join(websiteRoot, "dist")) {
  const files = await outputFiles(root);
  const inventory = new Set(files);
  const data = JSON.parse(await readFile(join(websiteRoot, ".generated/site-data.json"), "utf8"));
  const assets = JSON.parse(await readFile(join(websiteRoot, ".generated/asset-data.json"), "utf8"));
  const identifiers = new Map();
  const pages = new Map();
  for (const file of files.filter((path) => path.endsWith(".html"))) {
    const html = await readFile(join(root, file), "utf8");
    if (html.includes("/Users/") || html.includes("/private/var/folders/")) throw new Error(`Private build path in ${file}`);
    const nodes = htmlNodes(html);
    const ids = new Set();
    for (const node of nodes) {
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
    for (const id of entry.headings) if (!identifiers.get(path).has(id)) throw new Error(`Source heading identity lost in ${path}: ${id}`);
  }
  // Expressive Code's Copy control stores original newlines as DEL separators;
  // rendered blank lines also contain a presentation newline of their own.
  const integrationBlocks = pages.get("start/index.html").filter((node) => node.tagName === "button")
    .map((node) => attribute(node, "data-code")?.replaceAll("\x7f", "\n"));
  if (!integrationBlocks.includes(data.integrationHtml)) throw new Error("Get started cannot copy the documented HTML/CDN example exactly");
  for (const file of files.filter((path) => path.startsWith("diagrams/"))) checkDiagram(await readFile(join(root, file), "utf8"), file);
  for (const [base, hashes] of [[assets.runtimeBase, assets.runtimeHashes], [assets.pyodideBase, assets.pyodideHashes]]) {
    for (const [path, expected] of Object.entries(hashes)) {
      if (sha256(await readFile(join(root, base, path))) !== expected) throw new Error(`Changed browser asset in output: ${base}${path}`);
    }
  }
  if (!inventory.has(assets.workerUrl.slice(1))) throw new Error("Missing playground worker");
  if (!files.some((file) => file.startsWith("pagefind/") && file.endsWith(".js"))) throw new Error("Missing local search index");
  if (files.some((file) => /(?:^|\/)(?:node_modules|\.generated|\.env|scripts)(?:\/|$)/.test(file))) throw new Error("Private/tooling input in static output");
  const report = { htmlPages: pages.size, documents: data.documents.length, diagrams: data.diagrams, localReferences: references, emittedFiles: files.length, runtimeVersion: assets.runtimeVersion, pyodideVersion: assets.pyodideVersion, sourceRevision: data.sourceRevision, localChanges: data.localChanges };
  await writeChanged(join(websiteRoot, ".generated/verification.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(await verifyOutput());
