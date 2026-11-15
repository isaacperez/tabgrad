import { ordinaryVersionPattern } from "../../scripts/release-documentation.mjs";

export const documentationIndexName = "documentation.json";
const revision = /^(?!0{40}$)[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;

/** @param {object} data @returns {object} */
export function createDocumentationIndex(data) {
  return validateDocumentationIndex({ schemaVersion: 1, stableVersion: data.runtimeVersion, renderingRevision: data.sourceRevision,
    versions: data.documentationGroups.map(group => {
      const release = data.releases.find(entry => entry.version === group.version);
      if (!release) throw new Error("Documentation group has no release record");
      return { version: group.version, baselineRevision: group.baselineRevision, recordRevision: group.recordRevision,
        recordSha256: release.recordSha256, correction: group.correction,
        documents: data.documents.filter(entry => !entry.alias && entry.version === group.version).map(entry => ({ source: entry.source, route: entry.canonicalRoute })) };
    }),
  });
}

/** @param {unknown} value @returns {object} */
export function validateDocumentationIndex(value) {
  if (!value || Object.keys(value).sort().join() !== "renderingRevision,schemaVersion,stableVersion,versions"
    || value.schemaVersion !== 1 || !ordinaryVersionPattern.test(value.stableVersion) || !revision.test(value.renderingRevision)
    || !Array.isArray(value.versions) || !value.versions.length) throw new Error("Invalid public documentation index");
  const seen = new Set();
  for (const entry of value.versions) {
    if (!entry || Object.keys(entry).sort().join() !== "baselineRevision,correction,documents,recordRevision,recordSha256,version"
      || !ordinaryVersionPattern.test(entry.version) || seen.has(entry.version)
      || !revision.test(entry.baselineRevision) || !revision.test(entry.recordRevision) || !digest.test(entry.recordSha256)
      || !Array.isArray(entry.documents) || !entry.documents.length) throw new Error("Invalid documentation version index");
    if (entry.correction !== null && (!entry.correction || Object.keys(entry.correction).sort().join() !== "path,revision,sha256"
      || entry.correction.path !== `website/content/corrections/${entry.version}.json`
      || !revision.test(entry.correction.revision) || !digest.test(entry.correction.sha256))) throw new Error("Invalid documentation correction identity");
    const paths = new Set();
    for (const document of entry.documents) {
      if (!document || Object.keys(document).sort().join() !== "route,source" || typeof document.source !== "string"
        || !/^docs\/[a-zA-Z0-9_./-]+\.md$/.test(document.source) || document.source.split("/").some(part => !part || part === "." || part === "..")
        || typeof document.route !== "string" || !document.route.startsWith(`/docs/${entry.version}/`)
        || !/^\/docs\/\d+\.\d+\.\d+\/(?:[a-z0-9_-]+\/)*$/.test(document.route)
        || paths.has(document.route)) throw new Error("Invalid documentation route inventory");
      paths.add(document.route);
    }
    if (!paths.has(`/docs/${entry.version}/`)) throw new Error("Documentation version has no indexed overview");
    seen.add(entry.version);
  }
  if (!seen.has(value.stableVersion)) throw new Error("Stable documentation is not indexed");
  return value;
}

/** Updates and rollback may change presentation/corrections, never forget an admitted archive.
 * @param {object} previous @param {object} current @returns {void} */
export function preserveDocumentationArchives(previous, current) {
  validateDocumentationIndex(previous); validateDocumentationIndex(current);
  for (const old of previous.versions) {
    const next = current.versions.find(entry => entry.version === old.version);
    if (!next || next.baselineRevision !== old.baselineRevision) throw new Error("Published documentation archive disappeared or changed baseline");
    const routes = new Set(next.documents.map(document => document.route));
    if (old.documents.some(document => !routes.has(document.route))) throw new Error("Published documentation route disappeared");
  }
}
