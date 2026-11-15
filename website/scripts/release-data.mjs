import { execFileSync } from "node:child_process";
import { documentationCataloguePath, parseReleaseCatalogue, resolveReleaseCatalogue, releaseNotesSection } from "../../scripts/release-documentation.mjs";
import { readTrackedSource } from "./source-files.mjs";
import { gitDocumentationSource, admittedSourceDocuments, correctSourceDocuments } from "./documentation-source.mjs";

/** Completed baselines come from completion, never the advancing rendering checkout.
 * A new candidate is rendered only as explicitly selected validation data.
 * @param {object} entry @param {object} context @returns {{revision:string,candidate:boolean}|null} */
export function documentationBaseline(entry, { release, candidateRevision, publication = false }) {
  if (release?.version === entry.version) {
    if (entry.source !== "candidate" && entry.source !== release.sourceRevision) throw new Error("Documentation catalogue differs from completed source");
    return { revision: release.sourceRevision, candidate: false };
  }
  if (entry.source !== "candidate") return { revision: entry.source, candidate: false };
  if (publication) return null;
  if (!/^(?!0{40}$)[a-f0-9]{40}$/.test(candidateRevision)) throw new Error("Documentation candidate requires an explicit validation source");
  return { revision: candidateRevision, candidate: true };
}

/** Baseline and current metadata/corrections are separate, attributable inputs.
 * @param {string} root @param {string} selectedVersion
 * @returns {Promise<{releases:object[],groups:object[]}>} */
export async function loadReleaseData(root, selectedVersion, context = {}) {
  const catalogue = parseReleaseCatalogue(await readTrackedSource(root, documentationCataloguePath));
  const records = new Map();
  for (const entry of catalogue.releases) records.set(entry.version,
    await readTrackedSource(root, `docs/reference/release-${entry.version}.md`));
  const entries = resolveReleaseCatalogue(catalogue, records);
  const selected = entries.find(entry => entry.version === selectedVersion);
  if (!selected || selected.documentation === null) throw new Error("Selected runtime has no admitted documentation/support record");
  const currentRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const groups = [], releases = [];
  for (const entry of entries) {
    const binding = documentationBaseline(entry, context);
    if (binding === null) continue;
    const baseline = binding.revision;
    const source = gitDocumentationSource(root, baseline);
    if (JSON.parse(source.read("package.json")).version !== entry.version) throw new Error("Documentation baseline package version differs");
    const notes = releaseNotesSection(source.read("CHANGELOG.md"), entry.version);
    const baselineRecord = source.read(`docs/reference/release-${entry.version}.md`);
    if (!baselineRecord.startsWith(`# Tabgrad ${entry.version} source and support record\n`)) throw new Error("Documentation baseline support record differs");
    releases.push({ version: entry.version, title: entry.title, sourceRevision: baseline, recordRevision: currentRevision,
      recordSha256: entry.recordSha256, date: notes.date, notes: notes.body, documentationImpact: entry.documentationImpact,
      available: entry.documentation !== null, candidate: binding.candidate, support: entry.support });
    if (entry.documentation === null) continue;
    const original = admittedSourceDocuments(source, entry.documentation);
    const correctionPath = `website/content/corrections/${entry.version}.json`;
    const raw = await readTrackedSource(root, correctionPath, true);
    const correction = raw === undefined ? null : correctSourceDocuments(original, raw, entry.version, baseline);
    groups.push({ version: entry.version, baselineRevision: baseline, recordRevision: currentRevision, candidate: binding.candidate,
      correction: correction === null ? null : { path: correctionPath, revision: currentRevision, sha256: correction.sha256 },
      entries: correction?.documents ?? original, paths: source.paths, directories: source.directories, admission: entry.documentation });
  }
  if (!groups.some(group => group.version === selectedVersion)) throw new Error("Selected runtime has no completed documentation source");
  return { releases, groups };
}

/** Tutorials share the selected archive, never newer usage from the rendering checkout.
 * @param {object} releaseData @param {string} version @returns {{browser:string,python:string}} */
export function releaseIntegrationGuides(releaseData, version) {
  const group = releaseData.groups.find(entry => entry.version === version);
  const browser = group?.entries.find(entry => entry.source === "docs/reference/browser-package.md")?.body;
  const python = group?.entries.find(entry => entry.source === "docs/reference/python-host.md")?.body;
  if (browser === undefined || python === undefined) throw new Error("Selected release has no complete integration guides");
  return { browser, python };
}
