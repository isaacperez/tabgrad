import { createDocumentIndex, adaptDocument } from "./content.mjs";
import { documentRoute, repositoryUrl } from "./config.mjs";
import { integrationSource } from "./integration-files.mjs";

/** @param {object} metadata @param {string} revision @param {boolean} alias @returns {string} */
function frontmatter(metadata, revision, alias, isOverview) {
  return ["---", `title: ${JSON.stringify(metadata.title)}`, `description: ${JSON.stringify(metadata.description)}`,
    `editUrl: ${JSON.stringify(`${repositoryUrl}/blob/${revision}/${metadata.source}`)}`,
    ...(alias ? ["pagefind: false"] : []), ...(isOverview ? ["tableOfContents: false"] : []), "---", ""].join("\n");
}

/** @param {Map} index @param {string} source @param {string} label @returns {string} */
function overviewLink(index, source, label) {
  const entry = index.get(source);
  return entry ? `- [${label}](${entry.route})` : "";
}

/** Validate every release presentation, including a not-yet-selected candidate.
 * @param {object} release @param {Map} index @returns {void} */
function validateSupportLinks(release, index) {
  if (!release?.support) throw new Error("Missing release support presentation");
  const links = [...release.support.capabilities, ...release.support.environments.flatMap(environment => environment.links)];
  for (const link of links) {
    const document = index.get(link.source);
    if (!document || link.fragment && !document.headings.includes(link.fragment)) throw new Error("Release support link is not available in its documentation version");
  }
}

/** The shared overview changes its links and attribution, not its reader task.
 * @param {object} group @param {Map} index @param {string} runtimeVersion @param {string} artwork @returns {string} */
function overview(group, index, runtimeVersion, artwork) {
  const current = group.version === runtimeVersion;
  return `<div class="docs-overview not-content">
<div class="docs-overview-intro"><div>

# Tabgrad docs

<p class="docs-lead">Guides and reference for Tabgrad ${group.version}.${group.candidate ? ' Candidate preview; this version has not been published.' : ''}</p>
${current ? '<p><a class="text-link" href="/playground/">Try an example in the playground&nbsp;→</a></p>' : `<p>The current playground runs Tabgrad ${runtimeVersion}.</p>`}
</div><div class="docs-overview-art">${artwork.replaceAll("\n", "")}</div></div>
<p class="documentation-notice" data-version-missing hidden>This page is not available in the selected version. Its documentation starts here.</p>
<div class="docs-paths">
<section class="docs-route">

## Add Tabgrad to your website

Load the matching files, connect Python when needed and run a calculation in your page.

${current ? '- **[Get started →](/start/)**' : ''}
${overviewLink(index, "docs/reference/browser-package.md", "JavaScript setup")}
${overviewLink(index, "docs/reference/python-host.md", "Python setup")}
${index.has("docs/reference/webgpu-runtime.md") && index.has("docs/reference/python-host.md") ? `- GPU: [JavaScript setup](${index.get("docs/reference/webgpu-runtime.md").route}) · [Python setup](${index.get("docs/reference/python-host.md").route}#acquire-a-managed-gpu-connection)` : ''}

</section>
<section class="docs-route">

## Concepts

Understand tensor shapes and how Python runs in the browser.

${overviewLink(index, "docs/concepts/tensor-shape.md", "Tensors and shapes")}
${overviewLink(index, "docs/concepts/python-in-the-browser.md", "Python in the browser")}

</section>
<section class="docs-route">

## Reference

Find supported operations, arguments, results and errors for JavaScript and Python.

${overviewLink(index, "docs/javascript-api.md", "JavaScript API")}
${overviewLink(index, "docs/reference/python-tensors.md", "Python tensors")}
${overviewLink(index, "docs/reference/backward-gradients.md", "Backward and gradients")}
${overviewLink(index, "docs/compatibility.md", "PyTorch compatibility")}

</section>
<section class="docs-route">

## Inside Tabgrad

See how the Python interface, tensor runtime and CPU and GPU backends fit together.

${overviewLink(index, "docs/architecture/README.md", "Architecture")}
${overviewLink(index, "docs/components/README.md", "Components")}
${overviewLink(index, "docs/flows/README.md", "Flows")}

</section>
</div>
<section class="docs-source">

## Source and contributing

These pages describe Tabgrad ${group.version} from its ${group.candidate ? 'candidate' : 'released'} source.${group.correction ? ' Reviewed editorial corrections have a separately recorded source.' : ''} Use GitHub to suggest a correction.

<a data-documentation-source href="${repositoryUrl}/blob/${group.baselineRevision}/docs/README.md">View this version on GitHub ↗</a>${group.correction ? ` · <a href="${repositoryUrl}/blob/${group.correction.revision}/${group.correction.path}">Documentation corrections ↗</a>` : ''} · <a href="${repositoryUrl}/blob/${group.baselineRevision}/CONTRIBUTING.md">Contribute to the docs ↗</a>

</section>
</div>
`;
}

/** @param {object} releaseData @param {string} runtimeVersion @param {string} rendererKey @param {string} artwork
 * @returns {{prepared:object[],documents:object[],diagrams:Map<string,object>,groups:object[]}} */
export function prepareDocumentationPages(releaseData, runtimeVersion, rendererKey, artwork) {
  const prepared = [], documents = [], groups = [], diagrams = new Map();
  for (const group of releaseData.groups) {
    const index = createDocumentIndex(group.entries, { version: group.version, descriptions: {} });
    validateSupportLinks(releaseData.releases.find(release => release.version === group.version), index);
    integrationSource(group);
    const overviewEntry = { source: "docs/README.md", body: overview(group, index, runtimeVersion, artwork) };
    const overviewIndex = createDocumentIndex([overviewEntry], { version: group.version, descriptions: {} });
    const overviewMetadata = { ...overviewIndex.get(overviewEntry.source), title: "Documentation", description: `Guides and reference for Tabgrad ${group.version}.` };
    const all = [...group.entries, overviewEntry];
    for (const entry of all) {
      const isOverview = entry === overviewEntry;
      const metadata = isOverview ? overviewMetadata : index.get(entry.source);
      const adapted = isOverview ? { diagrams: [], render: () => entry.body } : adaptDocument(entry, index, group.baselineRevision,
        { diagramKey: rendererKey, repositoryPaths: group.paths, repositoryDirectories: group.directories });
      for (const diagram of adapted.diagrams) diagrams.set(diagram.id, diagram);
      const context = { source: entry.source, title: metadata.title, description: metadata.description,
        headings: metadata.headings, version: group.version, baselineRevision: group.baselineRevision,
        correction: group.correction, canonicalRoute: metadata.route };
      prepared.push({ path: metadata.route.slice(1) + "index.md", frontmatter: frontmatter(metadata, group.baselineRevision, false, isOverview), adapted });
      documents.push({ ...context, route: metadata.route, alias: false });
      if (group.version === runtimeVersion) {
        const alias = documentRoute(entry.source);
        prepared.push({ path: alias.slice(1) + "index.md", frontmatter: frontmatter(metadata, group.baselineRevision, true, isOverview), adapted });
        documents.push({ ...context, route: alias, alias: true });
      }
    }
    groups.push({ version: group.version, baselineRevision: group.baselineRevision, recordRevision: group.recordRevision, correction: group.correction });
  }
  return { prepared, documents, diagrams, groups };
}
