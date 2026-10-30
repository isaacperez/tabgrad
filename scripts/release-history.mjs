/** Initial original-evidence transport. Imports do not access files or services. */
import { appendFile, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalBytes, sha256 } from "./release-record-data.mjs";
import { publicationHistoryFiles, publicationHistoryLimits } from "./publication-controller.mjs";
import { publicationGithub } from "./publication-github.mjs";
import { exactPublicationKeys, PublicationError, requirePublication } from "./publication-plan.mjs";

export const historyInputLimit = 65535;
const workflow = ".github/workflows/release-history.yml";
const commit = /^[0-9a-f]{40}$/;
const digest = /^[0-9a-f]{64}$/;
const identifier = /^[1-9][0-9]*$/;
const ascii = /^[\x00-\x7f]*$/;

function validateHistoryIdentity(source, expiresAt, now, allowExpired = false) {
  requirePublication(typeof source === "string" && commit.test(source)
    && typeof expiresAt === "string" && Number.isFinite(Date.parse(expiresAt))
    && new Date(expiresAt).toISOString() === expiresAt
    && (allowExpired || now < Date.parse(expiresAt)), "PUBLICATION_HISTORY_CONTEXT");
}

/** Count the entire serialized REST request conservatively, including escaping. */
export function historyDispatch(packet, source, expiresAt, now = Date.now()) {
  validateHistoryIdentity(source, expiresAt, now);
  requirePublication(typeof packet === "string" && ascii.test(packet), "PUBLICATION_HISTORY_PACKET");
  const inputs = { source_revision: source, expires_at: expiresAt, history_json: packet,
    history_sha256: sha256(Buffer.from(packet)), confirmation: "release-history" };
  const dispatch = { ref: "main", inputs };
  requirePublication(canonicalBytes(dispatch).length <= historyInputLimit, "PUBLICATION_HISTORY_INPUT_LIMIT");
  return dispatch;
}

function decodeHistoryPacket(raw, expectedSha256) {
  requirePublication(Buffer.isBuffer(raw) && raw.length <= historyInputLimit
    && typeof expectedSha256 === "string" && digest.test(expectedSha256)
    && sha256(raw) === expectedSha256 && ascii.test(raw.toString("utf8")), "PUBLICATION_HISTORY_PACKET");
  let packet;
  try { packet = JSON.parse(raw); } catch (cause) { throw new PublicationError("PUBLICATION_HISTORY_PACKET", { cause }); }
  requirePublication(exactPublicationKeys(packet, ["schemaVersion", "files"]) && packet.schemaVersion === 1
    && Array.isArray(packet.files) && packet.files.length > 0 && packet.files.length <= publicationHistoryLimits.files,
  "PUBLICATION_HISTORY_PACKET");
  let previous = "";
  const files = [];
  for (const file of packet.files) {
    requirePublication(exactPublicationKeys(file, ["sha256", "base64"])
      && typeof file.sha256 === "string" && digest.test(file.sha256) && previous < file.sha256
      && typeof file.base64 === "string" && file.base64.length <= 4 * Math.ceil(publicationHistoryLimits.fileBytes / 3),
    "PUBLICATION_HISTORY_PACKET");
    const bytes = Buffer.from(file.base64, "base64");
    requirePublication(bytes.length <= publicationHistoryLimits.fileBytes && bytes.toString("base64") === file.base64
      && sha256(bytes) === file.sha256, "PUBLICATION_HISTORY_PACKET");
    previous = file.sha256;
    files.push({ sha256: file.sha256, bytes });
  }
  // Check only the closed primitive shape, never recurse through unadmitted data.
  requirePublication(canonicalBytes(packet).equals(raw), "PUBLICATION_HISTORY_PACKET");
  return files;
}

/** The only removable directory is the new output this call actually created. */
export async function writeHistoryOutput(directory, files, io = { mkdir, writeFile, readFile, rm }) {
  requirePublication(isAbsolute(directory) && Array.isArray(files) && files.length > 0
    && files.every(file => Array.isArray(file) && file.length === 2 && typeof file[0] === "string"
      && /^(?:history|dispatch|[0-9a-f]{64})\.json$/.test(file[0]) && Buffer.isBuffer(file[1]))
    && new Set(files.map(file => file[0])).size === files.length, "PUBLICATION_HISTORY_OUTPUT");
  let created = false;
  try {
    await io.mkdir(directory, { mode: 0o700 });
    created = true;
    for (const [name, bytes] of files) {
      const path = join(directory, name);
      await io.writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      requirePublication((await io.readFile(path)).equals(bytes), "PUBLICATION_HISTORY_CHANGED");
    }
  } catch (cause) {
    const error = new PublicationError("PUBLICATION_HISTORY_OUTPUT", { cause });
    if (created) {
      try { await io.rm(directory, { recursive: true }); error.cleanup = "confirmed"; }
      catch { error.cleanup = "unconfirmed"; }
    }
    throw error;
  }
}

export async function prepareHistory({ directory, source, expiresAt, output, now = Date.now() }) {
  validateHistoryIdentity(source, expiresAt, now);
  requirePublication(isAbsolute(directory) && isAbsolute(output), "PUBLICATION_HISTORY_OUTPUT");
  const selected = await realpath(directory);
  const target = join(await realpath(dirname(output)), basename(output));
  const relationship = relative(selected, target);
  requirePublication(relationship === ".." || relationship.startsWith(`..${sep}`) || isAbsolute(relationship),
    "PUBLICATION_HISTORY_OUTPUT");
  const originals = await publicationHistoryFiles(directory);
  const files = [];
  let packetBytes = canonicalBytes({ schemaVersion: 1, files: [] }).length;
  for (const identity of Object.keys(originals).sort()) {
    const bytes = await readFile(originals[identity]);
    requirePublication(bytes.length <= publicationHistoryLimits.fileBytes && sha256(bytes) === identity, "PUBLICATION_HISTORY_CHANGED");
    const file = { sha256: identity, base64: bytes.toString("base64") };
    packetBytes += canonicalBytes(file).length - 1 + (files.length ? 1 : 0);
    requirePublication(packetBytes <= historyInputLimit, "PUBLICATION_HISTORY_INPUT_LIMIT");
    files.push(file);
  }
  const packet = canonicalBytes({ schemaVersion: 1, files });
  const dispatch = canonicalBytes(historyDispatch(packet.toString("utf8"), source, expiresAt, now));
  decodeHistoryPacket(packet, sha256(packet));
  await writeHistoryOutput(output, [["history.json", packet], ["dispatch.json", dispatch]]);
  return { schemaVersion: 1, status: "prepared", files: files.length, packetSha256: sha256(packet),
    dispatchCharacters: dispatch.length, sourceRevision: source, expiresAt };
}

export function historyContext(environment, now = Date.now(), allowExpired = false) {
  const source = environment.TABGRAD_HISTORY_SOURCE, expiresAt = environment.TABGRAD_HISTORY_DEADLINE;
  validateHistoryIdentity(source, expiresAt, now, allowExpired);
  requirePublication(environment.TABGRAD_HISTORY_ENABLED === "true"
    && environment.TABGRAD_HISTORY_CONFIRMATION === "release-history"
    && environment.GITHUB_EVENT_NAME === "workflow_dispatch" && environment.GITHUB_REF === "refs/heads/main"
    && environment.GITHUB_RUN_ATTEMPT === "1" && environment.GITHUB_SHA === source
    && typeof environment.GITHUB_REPOSITORY === "string"
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(environment.GITHUB_REPOSITORY)
    && environment.GITHUB_WORKFLOW_REF === `${environment.GITHUB_REPOSITORY}/${workflow}@refs/heads/main`
    && identifier.test(environment.GITHUB_RUN_ID ?? "") && identifier.test(environment.GITHUB_REPOSITORY_ID ?? ""),
  "PUBLICATION_HISTORY_CONTEXT");
  return { source, expiresAt, name: `tabgrad-publication-history-${environment.GITHUB_RUN_ID}-1` };
}

export async function materializeHistory({ output, environment, now = Date.now() }) {
  const { source, expiresAt } = historyContext(environment, now);
  const dispatch = historyDispatch(environment.TABGRAD_HISTORY_JSON, source, expiresAt, now);
  requirePublication(dispatch.inputs.history_sha256 === environment.TABGRAD_HISTORY_SHA256,
    "PUBLICATION_HISTORY_PACKET");
  const files = decodeHistoryPacket(Buffer.from(dispatch.inputs.history_json), dispatch.inputs.history_sha256);
  await writeHistoryOutput(output, files.map(file => [`${file.sha256}.json`, file.bytes]));
  return { schemaVersion: 1, status: "materialized", files: files.length,
    packetSha256: dispatch.inputs.history_sha256 };
}

/** A read-only metadata convenience; neither a packet hash nor this receipt is authority. */
export async function observeHistoryArtifact({ environment, api, now = Date.now() }) {
  const { source, name } = historyContext(environment, now, true);
  const id = environment.TABGRAD_HISTORY_ARTIFACT_ID, expected = environment.TABGRAD_HISTORY_ARTIFACT_DIGEST;
  requirePublication(identifier.test(id ?? "") && digest.test(expected ?? ""), "PUBLICATION_HISTORY_ARTIFACT");
  const artifact = await api.request(`/actions/artifacts/${id}`);
  requirePublication(artifact !== null && typeof artifact === "object" && !Array.isArray(artifact)
    && String(artifact.id) === id && artifact.name === name && artifact.digest === `sha256:${expected}`
    && artifact.expired === false && Number.isSafeInteger(artifact.size_in_bytes)
    && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 128 * 1024 * 1024
    && String(artifact.workflow_run?.id) === environment.GITHUB_RUN_ID
    && String(artifact.workflow_run?.repository_id) === environment.GITHUB_REPOSITORY_ID
    && String(artifact.workflow_run?.head_repository_id) === environment.GITHUB_REPOSITORY_ID
    && artifact.workflow_run?.head_sha === source && typeof artifact.expires_at === "string"
    && Number.isFinite(Date.parse(artifact.expires_at))
    && now < Date.parse(artifact.expires_at), "PUBLICATION_HISTORY_ARTIFACT");
  return { id, sha256: expected, expiresAt: new Date(artifact.expires_at).toISOString(),
    runId: environment.GITHUB_RUN_ID, revision: source, name };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let result;
    if (process.argv[2] === "prepare") {
      requirePublication(process.argv.length === 7, "PUBLICATION_HISTORY_USAGE");
      result = await prepareHistory({ directory: process.argv[3], source: process.argv[4],
        expiresAt: process.argv[5], output: process.argv[6] });
    } else if (process.argv[2] === "materialize") {
      requirePublication(process.argv.length === 4, "PUBLICATION_HISTORY_USAGE");
      result = await materializeHistory({ output: process.argv[3], environment: process.env });
    } else if (process.argv[2] === "observe") {
      requirePublication(process.argv.length === 3, "PUBLICATION_HISTORY_USAGE");
      historyContext(process.env, Date.now(), true);
      const api = publicationGithub({ repository: process.env.GITHUB_REPOSITORY,
        token: process.env.GH_TOKEN, readOnly: true });
      const history = await observeHistoryArtifact({ environment: process.env, api });
      result = { schemaVersion: 1, status: "observed", history };
      if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
        `Initial history metadata (inspect independently before enrollment):\n\n\`\`\`json\n${canonicalBytes(history)}\`\`\`\n`);
    } else throw new PublicationError("PUBLICATION_HISTORY_USAGE");
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: "failed",
      code: error instanceof PublicationError ? error.code : "PUBLICATION_HISTORY_FAILED",
      ...(error.cleanup ? { cleanup: error.cleanup } : {}) })}\n`);
    process.exitCode = 1;
  }
}
