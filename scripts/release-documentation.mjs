/** Release-owned documentation data. No website dependencies or service effects. */
import { createHash } from "node:crypto";

export const documentationCataloguePath = "website/release-catalogue.json";
export const ordinaryVersionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const revisionPattern = /^(?!0{40}$)[a-f0-9]{40}$/;
const metadataStart = "<!-- tabgrad-release\n";
const metadataEnd = "\n-->";
const supportFields = ["summary", "capabilities", "environments", "limits"];

/** @param {unknown} value @param {string[]} required @param {string[]} optional @returns {boolean} */
function fields(value, required, optional = []) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

/** @param {unknown} value @returns {boolean} */
function text(value) {
  return typeof value === "string" && value.trim() === value && value.length > 0
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
}

/** @param {unknown} value @returns {boolean} */
function documentPath(value) {
  return typeof value === "string" && /^docs\/[a-zA-Z0-9_./-]+\.md$/.test(value)
    && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

/** @param {string} a @param {string} b @returns {number} */
export function compareReleaseVersions(a, b) {
  for (let index = 0; index < 3; index++) {
    const left = BigInt(a.split(".")[index]), right = BigInt(b.split(".")[index]);
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/** @param {string | Uint8Array} bytes @returns {{schemaVersion:number,releases:Array<{version:string,source:string,documentation:null|{directories:string[],individual:string[]}}>}} */
export function parseReleaseCatalogue(bytes) {
  const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (!fields(value, ["schemaVersion", "releases"]) || value.schemaVersion !== 1
    || !Array.isArray(value.releases) || !value.releases.length) throw new Error("Invalid release documentation catalogue");
  let previous;
  for (const entry of value.releases) {
    if (!fields(entry, ["version", "source", "documentation"]) || !ordinaryVersionPattern.test(entry.version)
      || !(revisionPattern.test(entry.source) || entry.source === "candidate")
      || previous !== undefined && compareReleaseVersions(previous, entry.version) <= 0) throw new Error("Invalid or unordered release catalogue entry");
    const admission = entry.documentation;
    if (admission !== null && (!fields(admission, ["directories", "individual"])
      || !Array.isArray(admission.directories) || !Array.isArray(admission.individual)
      || admission.directories.some(name => !/^[a-z][a-z-]*$/.test(name))
      || admission.individual.some(path => !documentPath(path))
      || new Set(admission.directories).size !== admission.directories.length
      || new Set(admission.individual).size !== admission.individual.length
      || !admission.directories.length && !admission.individual.length)) throw new Error("Invalid release documentation admission");
    previous = entry.version;
  }
  if (value.releases.filter(entry => entry.source === "candidate").length > 1
    || value.releases.some((entry, index) => entry.source === "candidate" && index !== 0)) throw new Error("Ambiguous candidate documentation");
  return value;
}

/** @param {unknown} value @param {string[]} keys @returns {boolean} */
function rows(value, keys) {
  return Array.isArray(value) && value.length > 0 && value.every(row => fields(row, keys) && keys.every(key => text(row[key])));
}

/** @param {unknown} value @returns {boolean} */
function environmentLinks(value) {
  return Array.isArray(value) && value.length > 0 && value.every(link => fields(link, ["label", "source"], ["fragment"])
    && text(link.label) && documentPath(link.source)
    && (link.fragment === undefined || typeof link.fragment === "string" && /^[a-z0-9_-]+$/.test(link.fragment)));
}

/** @param {unknown} support @param {boolean} partial @returns {boolean} */
function validSupport(support, partial) {
  return fields(support, partial ? [] : supportFields, partial ? supportFields : [])
    && (!Object.hasOwn(support, "summary") || text(support.summary))
    && (!Object.hasOwn(support, "capabilities") || rows(support.capabilities, ["title", "description", "source"]) && support.capabilities.every(row => documentPath(row.source)))
    && (!Object.hasOwn(support, "limits") || rows(support.limits, ["title", "description"]))
    && (!Object.hasOwn(support, "environments") || Array.isArray(support.environments) && support.environments.length > 0
      && support.environments.every(row => fields(row, ["title", "usage", "tested", "setup", "links"])
        && ["title", "usage", "tested", "setup"].every(key => text(row[key])) && environmentLinks(row.links)));
}

/** Metadata lives in the support record; it is not another editable capability list.
 * @param {string} body @param {string} version @returns {object} */
export function readReleaseMetadata(body, version) {
  const start = body.indexOf(metadataStart), end = body.indexOf(metadataEnd, start + metadataStart.length);
  if (start < 0 || end < 0 || body.indexOf(metadataStart, start + metadataStart.length) >= 0) throw new Error("Missing or ambiguous release support metadata");
  const value = JSON.parse(body.slice(start + metadataStart.length, end));
  if (!fields(value, ["schemaVersion", "version", "title", "documentationImpact"], ["inherits", "support"])
    || value.schemaVersion !== 1 || value.version !== version || !ordinaryVersionPattern.test(version)
    || !text(value.title) || !text(value.documentationImpact)
    || value.inherits !== undefined && (!ordinaryVersionPattern.test(value.inherits) || compareReleaseVersions(value.inherits, version) >= 0)
    || value.support !== undefined && !validSupport(value.support, value.inherits !== undefined)) throw new Error("Invalid release support metadata");
  return value;
}

/** @param {ReturnType<typeof parseReleaseCatalogue>} catalogue @param {Map<string,string>} records @returns {object[]} */
export function resolveReleaseCatalogue(catalogue, records) {
  const result = new Map();
  for (const entry of [...catalogue.releases].reverse()) {
    const body = records.get(entry.version);
    if (body === undefined) throw new Error(`Missing release support record: ${entry.version}`);
    const metadata = readReleaseMetadata(body, entry.version);
    const inherited = metadata.inherits === undefined ? undefined : result.get(metadata.inherits)?.support;
    if (metadata.inherits !== undefined && inherited === undefined) throw new Error("Missing inherited release support");
    const support = metadata.support === undefined ? inherited : { ...inherited, ...metadata.support };
    if (entry.documentation !== null && !validSupport(support, false)) throw new Error("Missing complete release support presentation");
    result.set(entry.version, { ...entry, title: metadata.title, documentationImpact: metadata.documentationImpact,
      support, recordSha256: createHash("sha256").update(body).digest("hex") });
  }
  return catalogue.releases.map(entry => result.get(entry.version));
}

/** @param {string} changelog @param {string} version @returns {{date:string,body:string}} */
export function releaseNotesSection(changelog, version) {
  if (!ordinaryVersionPattern.test(version)) throw new Error("Invalid release notes version");
  const lines = changelog.split(/\r?\n/);
  const starts = lines.flatMap((line, index) => line.startsWith(`## ${version} - `) ? [index] : []);
  if (starts.length !== 1) throw new Error("Missing or ambiguous release notes");
  const date = lines[starts[0]].slice(`## ${version} - `.length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))
    || new Date(date).toISOString().slice(0, 10) !== date) throw new Error("Invalid release notes date");
  const next = lines.findIndex((line, index) => index > starts[0] && line.startsWith("## "));
  const body = lines.slice(starts[0], next < 0 ? lines.length : next).join("\n").trim();
  if (!/^### (Added|Changed|Deprecated|Removed|Fixed|Security)$/m.test(body)
    || !/^- \S/m.test(body)) throw new Error("Release notes require user-visible changes");
  return { date, body: body + "\n" };
}

/** @param {object[]} catalogue @param {string} version @param {string} source @param {string} packageVersion @returns {object} */
export function admitReleaseDocumentation(catalogue, version, source, packageVersion) {
  const entry = catalogue.find(item => item.version === version);
  if (!entry || version !== packageVersion || !revisionPattern.test(source) || entry.documentation === null
    || entry.source !== "candidate" && entry.source !== source) throw new Error("Release documentation does not match candidate source/version");
  return { ...entry, source };
}
