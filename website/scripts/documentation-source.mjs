import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const revisionPattern = /^(?!0{40}$)[a-f0-9]{40}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const gitTreeLimitBytes = 8 * 1024 * 1024;
const sourceFileLimitBytes = 1024 * 1024;

/** @param {string} root @param {string[]} args @returns {string} */
function sourceGit(root, args) {
  const bytes = execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], maxBuffer: gitTreeLimitBytes });
  const value = bytes.toString("utf8");
  if (!Buffer.from(value).equals(bytes)) throw new Error("Documentation source is not valid UTF-8");
  return value;
}

/** @param {string} root @param {Map<string,string>} entries @param {string} path @returns {string} */
function sourceBlob(root, entries, path) {
  if (!safeSourcePath(path) || !entries.has(path)) throw new Error(`Missing regular source document: ${path}`);
  const size = Number(sourceGit(root, ["cat-file", "-s", entries.get(path)]).trim());
  if (!Number.isSafeInteger(size) || size < 0 || size > sourceFileLimitBytes) throw new Error("Documentation source file exceeds the admission limit");
  return sourceGit(root, ["cat-file", "blob", entries.get(path)]);
}

/** @param {string} path @returns {boolean} */
export function safeSourcePath(path) {
  return typeof path === "string" && !/[\u0000-\u001f\\:]/.test(path) && !path.startsWith("/")
    && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

/** Only committed regular blobs are admitted; no old script is ever imported.
 * Missing Git objects require explicit source preparation, not network during rendering.
 * @param {string} root @param {string} revision
 * @returns {{revision:string,paths:Set<string>,directories:Set<string>,nonRegularPaths:Set<string>,read:(path:string)=>string}} */
export function gitDocumentationSource(root, revision) {
  if (!revisionPattern.test(revision)) throw new Error("Documentation source requires an exact commit");
  if (sourceGit(root, ["cat-file", "-t", revision]).trim() !== "commit") throw new Error("Documentation source is not a commit");
  const entries = new Map();
  const directories = new Set();
  const nonRegularPaths = new Set();
  for (const line of sourceGit(root, ["ls-tree", "-r", "-z", "--full-tree", revision]).split("\0").filter(Boolean)) {
    const match = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(line);
    if (!match || !safeSourcePath(match[4])) throw new Error("Unsafe documentation source inventory");
    const parts = match[4].split("/");
    for (let count = 1; count < parts.length; count++) directories.add(parts.slice(0, count).join("/"));
    if (match[2] === "blob" && ["100644", "100755"].includes(match[1])) entries.set(match[4], match[3]);
    else nonRegularPaths.add(match[4]);
  }
  return { revision, paths: new Set([...entries.keys(), ...directories]), directories, nonRegularPaths, read: path => sourceBlob(root, entries, path) };
}

/** @param {ReturnType<typeof gitDocumentationSource>} source
 * @param {{directories:string[],individual:string[]}} admission
 * @returns {{source:string,body:string}[]} */
export function admittedSourceDocuments(source, admission) {
  for (const path of source.nonRegularPaths) if (admission.individual.includes(path)
    || admission.directories.some(name => path.startsWith(`docs/${name}/`))) throw new Error("Nonregular admitted documentation source");
  for (const path of admission.individual) if (!source.paths.has(path)) throw new Error(`Missing admitted source document: ${path}`);
  const paths = [...source.paths].filter(path => !source.directories.has(path) && path.endsWith(".md") && (admission.individual.includes(path)
    || admission.directories.some(name => path.startsWith(`docs/${name}/`)))).sort();
  if (!paths.length) throw new Error("Empty documentation source admission");
  return paths.map(path => ({ source: path, body: source.read(path) }));
}

/** Exact textual corrections are data, not executable patches or another copied tree.
 * @param {{source:string,body:string}[]} documents @param {string} raw
 * @param {string} version @param {string} revision
 * @returns {{documents:{source:string,body:string}[],sha256:string}} */
export function correctSourceDocuments(documents, raw, version, revision) {
  const value = JSON.parse(raw);
  if (!value || Object.keys(value).sort().join() !== "baseline,documents,schemaVersion,version"
    || value.schemaVersion !== 1 || value.version !== version || value.baseline !== revision
    || !Array.isArray(value.documents) || !value.documents.length) throw new Error("Invalid documentation corrections");
  const remaining = new Map(documents.map(entry => [entry.source, entry]));
  const result = new Map(remaining);
  for (const change of value.documents) {
    if (!change || Object.keys(change).sort().join() !== "baselineSha256,replacements,source"
      || !safeSourcePath(change.source) || !digestPattern.test(change.baselineSha256)
      || !Array.isArray(change.replacements) || !change.replacements.length || !remaining.has(change.source)) throw new Error("Invalid or repeated corrected document");
    let body = remaining.get(change.source).body;
    if (createHash("sha256").update(body).digest("hex") !== change.baselineSha256) throw new Error("Documentation correction baseline changed");
    for (const replacement of change.replacements) {
      if (!replacement || Object.keys(replacement).sort().join() !== "find,replace"
        || typeof replacement.find !== "string" || !replacement.find.length || typeof replacement.replace !== "string") throw new Error("Invalid textual documentation correction");
      const index = body.indexOf(replacement.find);
      if (index < 0 || body.indexOf(replacement.find, index + 1) >= 0) throw new Error("Ambiguous or absent documentation correction text");
      body = body.slice(0, index) + replacement.replace + body.slice(index + replacement.find.length);
    }
    result.set(change.source, { source: change.source, body });
    remaining.delete(change.source);
  }
  return { documents: documents.map(entry => result.get(entry.source)), sha256: createHash("sha256").update(raw).digest("hex") };
}
