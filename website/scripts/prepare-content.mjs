import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, copyFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import puppeteer from "puppeteer";
import { collectDocuments, createDocumentIndex, adaptDocument, firstCodeBlock } from "./content.mjs";
import { websiteRoot, repositoryRoot, repositoryUrl, runtimeVersion, pyodideVersion, documentDescriptions } from "./config.mjs";
import { writeChanged, sha256 } from "./files.mjs";
import { loadIllustration } from "./illustrations.mjs";
import { documentationSourceContext } from "./source-context.mjs";
import { diagramSize } from "./diagram-layout.mjs";
import { prepareBlog } from "./blog.mjs";
import { integrationFiles } from "./integration-files.mjs";
import { checkGeneratedAssets } from "./generated-assets.mjs";
import { siteOrigin } from "./publication.mjs";

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

/** @param {Map<string, {id:string, definition:string}>} diagrams @param {string} rendererKey @returns {Promise<Map<string,{width:number,height:number}>>} */
async function prepareDiagrams(diagrams, rendererKey) {
  await mkdir(diagramDirectory, { recursive: true });
  const missing = [];
  const sizes = new Map();
  for (const diagram of diagrams.values()) {
    try { sizes.set(diagram.id, diagramSize(await readFile(join(diagramDirectory, `${diagram.id}.svg`), "utf8"))); }
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
        sizes.set(missing[index].id, diagramSize(await readFile(join(work, `rendered-${index + 1}.svg`), "utf8")));
        await copyFile(join(work, `rendered-${index + 1}.svg`), join(diagramDirectory, `${missing[index].id}.svg`));
      }
    } catch (error) {
      throw new Error(`Mermaid rendering failed; document updates were not published.\n${error.stderr ?? error.message}`, { cause: error });
    } finally { await rm(work, { recursive: true, force: true }); }
    console.log(`Rendered ${missing.length} documentation diagrams (renderer ${rendererKey.slice(0, 8)}).`);
  }
  return sizes;
}

/** @returns {Promise<{documents: number, diagrams: number, sourceRevision:string}>} */
export async function prepareContent() {
  const posts = await prepareBlog(repositoryRoot, join(websiteRoot, ".generated/blog"));
  const cli = JSON.parse(await readFile(join(websiteRoot, "node_modules/@mermaid-js/mermaid-cli/package.json"), "utf8"));
  const browser = JSON.parse(await readFile(join(websiteRoot, "node_modules/puppeteer/package.json"), "utf8"));
  const mermaid = JSON.parse(await readFile(join(websiteRoot, "node_modules/mermaid/package.json"), "utf8"));
  const rendererKey = sha256(JSON.stringify({ cli: cli.version, mermaid: mermaid.version, browser: browser.version, platform: process.platform, arch: process.arch, config: mermaidConfig }));
  const { sourceRevision, sourceLinkRevision, localChanges } = documentationSourceContext(repositoryRoot);
  const entries = await collectDocuments();
  const documents = createDocumentIndex(entries);
  for (const source of Object.keys(documentDescriptions)) if (!documents.has(source)) throw new Error(`Editorial summary is not an admitted document: ${source}`);
  const output = [];
  const adaptedDocuments = [];
  const diagrams = new Map();
  for (const entry of entries) {
    const adapted = adaptDocument(entry, documents, sourceLinkRevision, { diagramKey: rendererKey });
    for (const diagram of adapted.diagrams) diagrams.set(diagram.id, diagram);
    const metadata = documents.get(entry.source);
    const frontmatter = ["---", `title: ${JSON.stringify(metadata.title)}`, `description: ${JSON.stringify(metadata.description)}`, `editUrl: ${localChanges ? "false" : JSON.stringify(`${repositoryUrl}/blob/${sourceRevision}/${entry.source}`)}`, "---", ""].join("\n");
    adaptedDocuments.push({ path: join(generatedDocs, entry.source.replace(/README\.md$/i, "index.md")), frontmatter, adapted });
  }
  const diagramSizes = await prepareDiagrams(diagrams, rendererKey);
  for (const { path, frontmatter, adapted } of adaptedDocuments) output.push({ path, body: frontmatter + adapted.render(diagramSizes) });
  const overviewDescription = "Guides and reference for using Tabgrad in the browser.";
  const overview = `---
title: Documentation
description: ${JSON.stringify(overviewDescription)}
editUrl: false
tableOfContents: false
---

<div class="docs-overview not-content">
<div class="docs-overview-intro"><div>

# Tabgrad docs

<p class="docs-lead">${overviewDescription}</p>
<p><a class="text-link" href="/playground/">Try an example in the playground →</a></p>
</div><div class="docs-overview-art">${(await loadIllustration("learning")).replaceAll("\n", "")}</div></div>

<div class="docs-paths">
<section class="docs-route">

## Add Tabgrad to your website

Start with a complete HTML example for JavaScript or Python, then adapt it to your page.

- **[Get started →](/start/)**
- [JavaScript setup](/docs/reference/browser-package/)
- [Python setup](/docs/reference/python-host/)
- GPU: [requirements](/versions/#execution-options) · [JavaScript setup](/docs/reference/webgpu-runtime/) · [Python setup](/docs/reference/python-host/#acquire-a-managed-gpu-connection)

</section>
<section class="docs-route">

## Concepts

Understand tensor shapes and how Python runs in the browser.

- [Tensors and shapes](/docs/concepts/tensor-shape/)
- [Python in the browser](/docs/concepts/python-in-the-browser/)

</section>
<section class="docs-route">

## Reference

Find supported operations, arguments, results and errors for JavaScript and Python.

- [JavaScript API](/docs/javascript-api/)
- [Python tensors](/docs/reference/python-tensors/)
- [Backward and gradients](/docs/reference/backward-gradients/)
- [PyTorch compatibility](/docs/compatibility/)

</section>
<section class="docs-route">

## Inside Tabgrad

See how the Python interface, tensor runtime and CPU and GPU backends fit together.

- [Architecture](/docs/architecture/)
- [Components](/docs/components/)
- [Flows](/docs/flows/)

</section>
</div>
<section class="docs-source">

## Source and contributing

These pages come from the repository’s Markdown. They can change independently of the playground’s package version. Use GitHub to suggest a correction.

${localChanges ? "This preview includes unpublished changes. GitHub shows the published source.\n" : ""}

<a data-documentation-source href="${repositoryUrl}/blob/${sourceLinkRevision}/docs/README.md">View documentation on GitHub ↗</a> · <a href="${repositoryUrl}/blob/${sourceLinkRevision}/CONTRIBUTING.md">Contribute to the docs ↗</a>

</section>
</div>
`;
  output.push({ path: join(generatedDocs, "docs/index.md"), body: overview });
  const livePaths = new Set(output.map((entry) => entry.path));
  for (const entry of output) await writeChanged(entry.path, entry.body);
  for (const path of await generatedFiles(generatedDocs)) if (!livePaths.has(path)) await rm(path);
  for (const path of await generatedFiles(diagramDirectory)) if (!diagrams.has(relative(diagramDirectory, path).replace(/\.svg$/, ""))) await rm(path);
  const browserGuide = await readFile(join(repositoryRoot, "docs/reference/browser-package.md"), "utf8");
  const pythonGuide = await readFile(join(repositoryRoot, "docs/reference/python-host.md"), "utf8");
  const information = {
    publicOrigin: siteOrigin(process.env.TABGRAD_SITE_URL) ?? null,
    sourceRevision, sourceLinkRevision, localChanges, runtimeVersion, pyodideVersion, posts,
    documents: [...documents.values()].map(({ source, title, description, route, headings }) => ({ source, title, description, route, headings })),
    diagrams: diagrams.size, rendererKey,
    integrationHtml: firstCodeBlock(browserGuide, "html"),
    integrationPythonHtml: firstCodeBlock(pythonGuide, "html", "index.html"),
    integrationPythonWorker: firstCodeBlock(pythonGuide, "javascript", "python-worker.js"),
  };
  const downloads = integrationFiles(information);
  await checkGeneratedAssets(join(websiteRoot, "public"), downloads.map(file => file.path), { allowMissing: true });
  for (const file of downloads) await writeChanged(join(websiteRoot, "public", file.path), file.body);
  await writeChanged(join(websiteRoot, ".generated/site-data.json"), JSON.stringify(information, null, 2) + "\n");
  // Use Astro's public watch hook to rebuild its route table on admission changes.
  await writeChanged(join(websiteRoot, ".generated/routes.json"), JSON.stringify([...information.documents, ...posts].map(({ route }) => route)) + "\n");
  return { documents: documents.size, diagrams: diagrams.size, sourceRevision };
}
