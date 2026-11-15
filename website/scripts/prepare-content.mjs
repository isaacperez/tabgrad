import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, copyFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import puppeteer from "puppeteer";
import { firstCodeBlock } from "./content.mjs";
import { websiteRoot, repositoryRoot, runtimeVersion, pyodideVersion, releaseInput } from "./config.mjs";
import { writeChanged, sha256 } from "./files.mjs";
import { loadIllustration } from "./illustrations.mjs";
import { documentationSourceContext } from "./source-context.mjs";
import { diagramSize } from "./diagram-layout.mjs";
import { prepareBlog } from "./blog.mjs";
import { integrationFiles } from "./integration-files.mjs";
import { checkGeneratedAssets } from "./generated-assets.mjs";
import { siteOrigin } from "./publication.mjs";
import { loadReleaseData, releaseIntegrationGuides } from "./release-data.mjs";
import { prepareDocumentationPages } from "./documentation-pages.mjs";

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
  const { sourceRevision, sourceLinkRevision, localChanges } = documentationSourceContext(repositoryRoot, releaseInput);
  const releaseData = await loadReleaseData(repositoryRoot, runtimeVersion, { release: releaseInput?.release,
    candidateRevision: sourceRevision, publication: process.env.TABGRAD_WEBSITE_MODE === "publish" });
  const documentation = prepareDocumentationPages(releaseData, runtimeVersion, rendererKey, await loadIllustration("learning"));
  const diagrams = documentation.diagrams;
  const diagramSizes = await prepareDiagrams(diagrams, rendererKey);
  const output = documentation.prepared.map(entry => ({
    path: join(generatedDocs, entry.path), body: entry.frontmatter + entry.adapted.render(diagramSizes),
  }));
  const livePaths = new Set(output.map((entry) => entry.path));
  for (const entry of output) await writeChanged(entry.path, entry.body);
  for (const path of await generatedFiles(generatedDocs)) if (!livePaths.has(path)) await rm(path);
  for (const path of await generatedFiles(diagramDirectory)) if (!diagrams.has(relative(diagramDirectory, path).replace(/\.svg$/, ""))) await rm(path);
  const guides = releaseIntegrationGuides(releaseData, runtimeVersion);
  const information = {
    publicOrigin: siteOrigin(process.env.TABGRAD_SITE_URL) ?? null,
    sourceRevision, sourceLinkRevision, localChanges: localChanges || releaseData.releases.some(entry => entry.candidate), runtimeVersion, pyodideVersion, posts,
    release: releaseInput?.release ?? null, recipeRevision: releaseInput?.recipeRevision ?? null,
    documents: documentation.documents, documentationGroups: documentation.groups, releases: releaseData.releases,
    diagrams: diagrams.size, rendererKey,
    integrationHtml: firstCodeBlock(guides.browser, "html"),
    integrationPythonHtml: firstCodeBlock(guides.python, "html", "index.html"),
    integrationPythonWorker: firstCodeBlock(guides.python, "javascript", "python-worker.js"),
  };
  const downloads = integrationFiles(information);
  await checkGeneratedAssets(join(websiteRoot, "public"), downloads.map(file => file.path), { allowMissing: true });
  for (const file of downloads) await writeChanged(join(websiteRoot, "public", file.path), file.body);
  await writeChanged(join(websiteRoot, ".generated/site-data.json"), JSON.stringify(information, null, 2) + "\n");
  // Use Astro's public watch hook to rebuild its route table on admission changes.
  await writeChanged(join(websiteRoot, ".generated/routes.json"), JSON.stringify([...information.documents, ...posts].map(({ route }) => route)) + "\n");
  return { documents: documentation.documents.length, diagrams: diagrams.size, sourceRevision };
}
