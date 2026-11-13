import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const hash = /^[a-f0-9]{64}$/, revision = /^[a-f0-9]{40}$/;

/** One public release binding is shared by generated pages, checked output and hosting. */
export function releaseIdentity(value) {
  if (!value || Object.keys(value).sort().join() !== "archiveSha512,attempt,completionSha256,inventorySha256,operation,planSha256,recipeRevision,runId,schemaVersion,sourceRevision,version"
    || value.schemaVersion !== 1 || value.attempt !== "1" || !/^[1-9][0-9]*$/.test(value.runId)
    || ![value.completionSha256, value.inventorySha256, value.planSha256].every(value => hash.test(value))
    || ![value.sourceRevision, value.recipeRevision].every(value => revision.test(value))
    || !/^[a-f0-9]{128}$/.test(value.archiveSha512) || !hash.test(value.operation)
    || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value.version)) throw new Error("Invalid website release identity");
  return structuredClone(value);
}

/** CI writes this owned input after observing completion and installing the exact registry package.
 * @param {string | undefined} path @returns {object | undefined} */
export function readReleaseInput(path) {
  if (path === undefined || path === "") return undefined;
  if (!isAbsolute(path)) throw new Error("Release input must be absolute");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error("Invalid release input file");
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (Object.keys(value).sort().join() !== "inventory,packageDirectory,recipeRevision,release,schemaVersion,sourceRevision" || value.schemaVersion !== 1
    || !revision.test(value.recipeRevision) || !revision.test(value.sourceRevision) || value.packageDirectory !== join(dirname(path), "package") || !Array.isArray(value.inventory)) throw new Error("Invalid acquired runtime input");
  return { ...value, release: releaseIdentity(value.release) };
}

/** Only the two integration guides bind their explicit package specifier to the selected release.
 * Versioned support/history prose and unrelated numbers retain their original meaning. */
export function bindIntegrationVersion(source, body, referenceVersion, selectedVersion) {
  if (!["docs/reference/browser-package.md", "docs/reference/python-host.md"].includes(source)) return body;
  const token = `@tabgrad/tabgrad@${referenceVersion}`;
  return body.replaceAll(token, (match, offset) => {
    const next = body[offset + match.length];
    return next === undefined || "/ \t\r\n\"'`".includes(next) ? `@tabgrad/tabgrad@${selectedVersion}` : match;
  });
}
