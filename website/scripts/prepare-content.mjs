import { execFile, execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, copyFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import puppeteer from "puppeteer";
import { collectDocuments, createDocumentIndex, adaptDocument, firstCodeBlock } from "./content.mjs";
import { websiteRoot, repositoryRoot, repositoryUrl, runtimeVersion, pyodideVersion } from "./config.mjs";
import { writeChanged, sha256 } from "./files.mjs";
import { loadIllustration } from "./illustrations.mjs";

const execFileAsync = promisify(execFile);
const generatedDocs = join(websiteRoot, "src/content/docs");
const diagramDirectory = join(websiteRoot, "public/diagrams");
const mermaidConfig = {
  theme: "neutral", securityLevel: "strict", fontFamily: "Arial, sans-serif",
  htmlLabels: false,
};

/** @param {string} root @returns {Promise<string[]>} */
async function generatedFiles(root) {
  const result = [];
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isSymbolicLink()) throw new Error("A generated website directory contains a symbolic link");
      if (entry.isDirectory()) result.push(...await generatedFiles(path));
      else if (entry.isFile()) result.push(path);
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return result;
}

/** @param {Map<string, {id:string, definition:string}>} diagrams @param {string} rendererKey @returns {Promise<void>} */
async function prepareDiagrams(diagrams, rendererKey) {
  await mkdir(diagramDirectory, { recursive: true });
  const missing = [];
  for (const diagram of diagrams.values()) {
    try { await readFile(join(diagramDirectory, `${diagram.id}.svg`)); }
    catch (error) { if (error.code !== "ENOENT") throw error; missing.push(diagram); }
  }
  if (missing.length) {
    const work = join(websiteRoot, ".generated/mermaid");
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    await writeChanged(join(work, "input.md"), missing.map((diagram) => `\`\`\`mermaid\n${diagram.definition}\n\`\`\`\n`).join("\n"));
    await writeChanged(join(work, "config.json"), JSON.stringify(mermaidConfig));
    await writeChanged(join(work, "browser.json"), JSON.stringify({ executablePath: await puppeteer.executablePath(), headless: true }));
    try {
      await execFileAsync(process.execPath, [
        join(websiteRoot, "node_modules/.bin/mmdc"), "-i", join(work, "input.md"),
        "-o", join(work, "rendered.md"), "-c", join(work, "config.json"), "-p", join(work, "browser.json"),
        "--no-font-embed", "--jobs", "1", "--svgId", "tabgrad-diagram", "--quiet",
      ], { cwd: websiteRoot });
      for (let index = 0; index < missing.length; index++) {
        await copyFile(join(work, `rendered-${index + 1}.svg`), join(diagramDirectory, `${missing[index].id}.svg`));
      }
    } catch (error) {
      throw new Error(`Mermaid rendering failed; document updates were not published.\n${error.stderr ?? error.message}`, { cause: error });
    } finally { await rm(work, { recursive: true, force: true }); }
    console.log(`Rendered ${missing.length} documentation diagrams (renderer ${rendererKey.slice(0, 8)}).`);
  }
}

/** @returns {Promise<{documents: number, diagrams: number, sourceRevision:string}>} */
export async function prepareContent() {
  const cli = JSON.parse(await readFile(join(websiteRoot, "node_modules/@mermaid-js/mermaid-cli/package.json"), "utf8"));
  const browser = JSON.parse(await readFile(join(websiteRoot, "node_modules/puppeteer/package.json"), "utf8"));
  const mermaid = JSON.parse(await readFile(join(websiteRoot, "node_modules/mermaid/package.json"), "utf8"));
  const rendererKey = sha256(JSON.stringify({ cli: cli.version, mermaid: mermaid.version, browser: browser.version, platform: process.platform, arch: process.arch, config: mermaidConfig }));
  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  const localChanges = execFileSync("git", ["status", "--porcelain", "--", "docs", "website", "README.md", "assets/brand"], { cwd: repositoryRoot, encoding: "utf8" }).length > 0;
  const entries = await collectDocuments();
  const documents = createDocumentIndex(entries);
  const output = [];
  const diagrams = new Map();
  for (const entry of entries) {
    const adapted = adaptDocument(entry, documents, sourceRevision, { diagramKey: rendererKey });
    for (const diagram of adapted.diagrams) diagrams.set(diagram.id, diagram);
    const metadata = documents.get(entry.source);
    const frontmatter = ["---", `title: ${JSON.stringify(metadata.title)}`, `editUrl: ${localChanges ? "false" : JSON.stringify(`${repositoryUrl}/blob/${sourceRevision}/${entry.source}`)}`, "---", ""].join("\n");
    output.push({ path: join(generatedDocs, entry.source.replace(/README\.md$/i, "index.md")), body: frontmatter + adapted.markdown });
  }
  await prepareDiagrams(diagrams, rendererKey);
  const overview = `---
title: Documentation
editUrl: false
tableOfContents: false
---

<div class="docs-overview not-content">
<div class="docs-overview-intro"><div>

# Tabgrad docs

<p class="docs-lead">Run an example, integrate Tabgrad into a page, or look up the API. Start with the task you have in mind.</p>
</div><div class="docs-overview-art">${(await loadIllustration("learning")).replaceAll("\n", "")}</div></div>

<div class="docs-paths">
<section class="docs-route">

## Learn by running code

Change an input and see what happens. The playground includes Python, JavaScript and an explanation of each result.

- [Open the playground](/playground/)
- [Understand tensors and shapes](/docs/concepts/tensor-shape/)
- [Learn how browser Python works](/docs/concepts/python-in-the-browser/)

</section>
<section class="docs-route">

## Add Tabgrad to an app

Start with an HTML module import, or serve the files yourself. Add Python when you need it.

- [Get started](/start/)
- [Use HTML/CDN or serve your own files](/docs/reference/browser-package/)
- [Set up Python](/docs/reference/python-host/)
- [Enable GPU execution](/docs/reference/webgpu-runtime/)

</section>
<section class="docs-route">

## Find an API

Find supported operations, their arguments and the behavior you can rely on.

- [JavaScript API](/docs/javascript-api/)
- [Backward and gradients](/docs/reference/backward-gradients/)
- [PyTorch compatibility](/docs/compatibility/)

</section>
<section class="docs-route">

## Explore the design

Understand the decisions behind Tabgrad and follow how its parts work together.

- [Architecture](/docs/architecture/) and [concepts](/docs/concepts/)
- [Components](/docs/components/) and [flows](/docs/flows/)
- [Versions and compatibility](/versions/)

</section>
</div>
<section class="docs-source">

## Source and contributing

These pages are built from the repository’s Markdown. Documentation can update independently of the package used by the playground.

${localChanges ? "This local preview includes unpublished edits. The source link shows their base revision.\n" : ""}

<a data-documentation-source href="${repositoryUrl}/blob/${sourceRevision}/docs/README.md">View documentation on GitHub ↗</a> · <a href="${repositoryUrl}/blob/${sourceRevision}/CONTRIBUTING.md">Contribute to the docs ↗</a>

</section>
</div>
`;
  output.push({ path: join(generatedDocs, "docs/index.md"), body: overview });
  const livePaths = new Set(output.map((entry) => entry.path));
  for (const entry of output) await writeChanged(entry.path, entry.body);
  for (const path of await generatedFiles(generatedDocs)) if (!livePaths.has(path)) await rm(path);
  for (const path of await generatedFiles(diagramDirectory)) if (!diagrams.has(relative(diagramDirectory, path).replace(/\.svg$/, ""))) await rm(path);
  const browserGuide = await readFile(join(repositoryRoot, "docs/reference/browser-package.md"), "utf8");
  const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");
  const information = {
    sourceRevision, localChanges, runtimeVersion, pyodideVersion,
    documents: [...documents.values()].map(({ source, title, route, headings }) => ({ source, title, route, headings })),
    diagrams: diagrams.size, rendererKey,
    integrationJavaScript: firstCodeBlock(browserGuide, "javascript"),
    integrationHtml: firstCodeBlock(browserGuide, "html"),
    introductoryPython: firstCodeBlock(readme, "python"),
  };
  await writeChanged(join(websiteRoot, ".generated/site-data.json"), JSON.stringify(information, null, 2) + "\n");
  // Use Astro's public watch hook to rebuild its route table on admission changes.
  await writeChanged(join(websiteRoot, ".generated/routes.json"), JSON.stringify(information.documents.map(({ route }) => route)) + "\n");
  return { documents: documents.size, diagrams: diagrams.size, sourceRevision };
}
