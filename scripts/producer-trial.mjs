/** Inert on import. Compose retained package tools; never publish or request a signature. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { producerProofSubjects, readProducerInventory, verifyPackageProvenance } from "./package-provenance.mjs";
import { stagePackageArchive, verifyPackageDirectory } from "./package-artifact.mjs";
import { identifyProvenanceClient, runProvenanceClient } from "./provenance-client.mjs";
import { qualifyPackage } from "./run-package-browser-tests.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const workflow = ".github/workflows/producer-trial.yml";
const hash = (bytes, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
const digestPattern = /^[0-9a-f]{64}$/;
const commitPattern = /^[0-9a-f]{40}$/;
const idPattern = /^[1-9][0-9]{0,19}$/;
const maxRecordBytes = 2 * 1024 * 1024;
const maxPacketBytes = 128 * 1024 * 1024;
const clientArchiveSha256 = "bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386";

export class ProducerTrialError extends Error {
  constructor(code) { super(code); this.name = "ProducerTrialError"; this.code = code; }
}
function check(condition, code) { if (!condition) throw new ProducerTrialError(code); }
function sameId(value, expected) {
  return Number.isSafeInteger(value) && value > 0 && String(value) === expected;
}
function json(bytes) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new ProducerTrialError("TRIAL_JSON"); }
}
async function regularFile(path, limit) {
  const metadata = await lstat(path);
  check(metadata.isFile() && metadata.size <= limit, "TRIAL_FILE");
  return metadata;
}
async function original(path, limit = maxRecordBytes) {
  const metadata = await regularFile(path, limit);
  const bytes = await readFile(path);
  check(bytes.length === metadata.size && bytes.length <= limit, "TRIAL_FILE");
  return bytes;
}
async function save(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
async function outputs(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  for (const [key, value] of Object.entries(values)) {
    check(/^[a-z_]+$/.test(key) && typeof value === "string" && !/[\r\n]/.test(value), "TRIAL_OUTPUT");
    await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

/** Provider context is expected input, not learned from a bundle or candidate. */
export function trialContext(environment, now = Date.now(), allowExpired = false) {
  const e = environment;
  check(e.TABGRAD_TRIAL_ENABLED === "true" && e.TABGRAD_TRIAL_CONFIRMATION === "producer-trial"
    && e.GITHUB_EVENT_NAME === "workflow_dispatch"
    && e.GITHUB_REF === "refs/heads/main" && e.GITHUB_RUN_ATTEMPT === "1", "TRIAL_ADMISSION");
  check(typeof e.GITHUB_REPOSITORY === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(e.GITHUB_REPOSITORY)
    && !e.GITHUB_REPOSITORY.split("/").some(x => x === "." || x === "..")
    && commitPattern.test(e.GITHUB_SHA ?? "") && e.TABGRAD_TRIAL_SOURCE === e.GITHUB_SHA
    && [e.GITHUB_REPOSITORY_ID, e.GITHUB_REPOSITORY_OWNER_ID, e.GITHUB_RUN_ID]
      .every(x => typeof x === "string" && idPattern.test(x))
    && e.GITHUB_WORKFLOW_REF === `${e.GITHUB_REPOSITORY}/${workflow}@refs/heads/main`, "TRIAL_IDENTITY");
  check(typeof e.TABGRAD_TRIAL_DEADLINE === "string"
    && Number.isFinite(Date.parse(e.TABGRAD_TRIAL_DEADLINE))
    && new Date(e.TABGRAD_TRIAL_DEADLINE).toISOString() === e.TABGRAD_TRIAL_DEADLINE
    && (allowExpired || Date.parse(e.TABGRAD_TRIAL_DEADLINE) > now)
    && digestPattern.test(e.TABGRAD_TRIAL_TRUST_ROOT ?? ""), "TRIAL_DEADLINE_OR_ROOT");
  return { identity: { repository: e.GITHUB_REPOSITORY, repositoryId: e.GITHUB_REPOSITORY_ID,
    ownerId: e.GITHUB_REPOSITORY_OWNER_ID, sourceRevision: e.GITHUB_SHA, sourceRef: e.GITHUB_REF,
    workflowPath: workflow, workflowRevision: e.GITHUB_SHA,
    signerUri: `https://github.com/${e.GITHUB_WORKFLOW_REF}`, signerRevision: e.GITHUB_SHA,
    runId: e.GITHUB_RUN_ID, runAttempt: e.GITHUB_RUN_ATTEMPT, event: e.GITHUB_EVENT_NAME },
  expiresAt: e.TABGRAD_TRIAL_DEADLINE, trustRootSha256: e.TABGRAD_TRIAL_TRUST_ROOT };
}

export function producerSubjects(candidate, inventoryBytes) {
  const subjects = producerProofSubjects(candidate, inventoryBytes);
  return { archive: { name: subjects.archive.name, digest: `sha512:${subjects.archive.digest.sha512}` },
    inventory: { name: subjects.inventory.name, digest: `sha256:${subjects.inventory.digest.sha256}` } };
}

export function validateTrialQualification(report, candidate, inventorySha256) {
  const required = ["archive-identity", "archive-structure", "metadata-and-source", "installed-inventory",
    "public-entries", "public-types", "cpu-assets", "static-inventory"];
  check(report?.status === "passed" && report.input === "supplied-archive"
    && report.expectedEvidenceSha256 === inventorySha256 && report.requested?.gpu === false
    && JSON.stringify(report.requested.browsers) === JSON.stringify(["Chrome", "Firefox"])
    && JSON.stringify(report.requested.profiles) === JSON.stringify(["direct", "python", "prerequisite"])
    && Array.isArray(report.checks) && required.every(x => report.checks.includes(x))
    && Array.isArray(report.profiles) && report.profiles.length === 6
    && report.candidate?.sourceRevision === candidate.sourceRevision
    && report.candidate.name === candidate.name && report.candidate.version === candidate.version
    && report.candidate.private === candidate.private && report.candidate.files === candidate.files.length
    && report.candidate.archive?.sha256 === candidate.tarball.sha256
    && report.candidate.archive.integrity === candidate.tarball.integrity
    && report.candidate.archive.byteLength === candidate.tarball.byteLength
    && !report.cleanupFailure && !report.preparationCleanupFailure, "TRIAL_QUALIFICATION");
  for (const browser of ["Chrome", "Firefox"]) for (const mode of ["direct", "python", "prerequisite"]) {
    check(report.profiles.filter(p => p.browser === browser && p.mode === mode && p.status === "passed"
      && typeof p.version === "string" && p.version.length > 0).length === 1, "TRIAL_QUALIFICATION");
  }
}

// Original producer encoding is fixed independently of a consumer's JSON key
// order (for example a canonical publication plan). Values are still exact.
function orderedTrialIdentity(identity) {
  return Object.fromEntries(["repository", "repositoryId", "ownerId", "sourceRevision", "sourceRef", "workflowPath",
    "workflowRevision", "signerUri", "signerRevision", "runId", "runAttempt", "event"].map(key => [key, identity[key]]));
}

async function inspectCandidate(directory, context) {
  const inventory = await original(join(directory, "candidate.json"));
  const candidate = readProducerInventory(inventory);
  check(candidate.sourceRevision === context.identity.sourceRevision, "TRIAL_SOURCE");
  const temporary = await mkdtemp(join(tmpdir(), "tabgrad-producer-inspect-"));
  try {
    await regularFile(join(directory, candidate.tarball.path), maxPacketBytes);
    await stagePackageArchive(join(directory, candidate.tarball.path), candidate, temporary);
    await verifyPackageDirectory(join(directory, "package"), candidate.files);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return { candidate, inventory, subjects: producerSubjects(candidate, inventory) };
}

export async function inspectTrialPacket(directory, context) {
  const selected = await inspectCandidate(directory, context);
  const qualification = await original(join(directory, "qualification.json"));
  const qualificationReport = json(qualification);
  validateTrialQualification(qualificationReport, selected.candidate, hash(selected.inventory));
  const raw = await original(join(directory, "producer.json"));
  const expected = { schemaVersion: 1, identity: orderedTrialIdentity(context.identity), expiresAt: context.expiresAt,
    inventorySha256: hash(selected.inventory), archiveSha512: selected.subjects.archive.digest.slice(7),
    qualificationSha256: hash(qualification) };
  check(raw.equals(Buffer.from(`${JSON.stringify(expected, null, 2)}\n`)), "TRIAL_PACKET");
  const names = (await readdir(directory)).sort();
  check(JSON.stringify(names) === JSON.stringify([selected.candidate.tarball.path, "candidate.json", "package",
    "producer.json", "qualification.json"].sort()), "TRIAL_PACKET_FILES");
  return { ...selected, producer: expected, qualification: qualificationReport };
}

async function prepare(directory, context) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
  check(head === context.identity.sourceRevision, "TRIAL_SOURCE");
  execFileSync("npm", ["run", "package", "--", directory], { cwd: repository, stdio: "inherit" });
  await outputs({ data_exists: "true" });
  const selected = await inspectCandidate(directory, context);
  const report = await qualifyPackage({ tarball: join(directory, selected.candidate.tarball.path),
    expected: join(directory, "candidate.json"), gpu: false });
  await save(join(directory, "qualification.json"), report);
  validateTrialQualification(report, selected.candidate, hash(selected.inventory));
  const qualification = await original(join(directory, "qualification.json"));
  await save(join(directory, "producer.json"), { schemaVersion: 1, identity: context.identity,
    expiresAt: context.expiresAt, inventorySha256: hash(selected.inventory),
    archiveSha512: selected.subjects.archive.digest.slice(7), qualificationSha256: hash(qualification) });
  await inspectTrialPacket(directory, context);
  await outputs({ qualified: "true" });
}

/** Authenticated, fixed-endpoint service observations; no retry, wire parser or sandbox. */
export async function githubRecord(context, route, token, fetcher = fetch) {
  check(typeof token === "string" && token.length > 0 && route.startsWith("/") && !route.includes(".."), "TRIAL_CI_ACCESS");
  const response = await fetcher(`https://api.github.com/repos/${context.identity.repository}${route}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    redirect: "error", signal: AbortSignal.timeout(30000) });
  check(response.status === 200 && response.body, "TRIAL_CI_RESPONSE");
  const reader = response.body.getReader(); const chunks = []; let bytes = 0; let failure;
  try {
    while (true) {
      const result = await reader.read(); if (result.done) break;
      bytes += result.value.length; check(bytes <= maxRecordBytes, "TRIAL_CI_LIMIT"); chunks.push(result.value);
    }
  } catch (error) { failure = error; }
  try { await reader.cancel(); } catch (error) { if (failure) failure.cleanupError = error; else failure = error; }
  try { reader.releaseLock(); } catch (error) { if (failure) failure.cleanupError = error; else failure = error; }
  if (failure) throw failure;
  const raw = Buffer.concat(chunks); return { raw, value: json(raw) };
}

export function checkTrialArtifact(artifact, context, kind, expectedId, expectedDigest) {
  check(idPattern.test(expectedId ?? "") && digestPattern.test(expectedDigest ?? "")
    && sameId(artifact?.id, expectedId)
    && artifact.name === `tabgrad-producer-${kind}-${context.identity.runId}-${context.identity.runAttempt}`
    && artifact.digest === `sha256:${expectedDigest}` && artifact.expired === false
    && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= maxPacketBytes
    && Date.parse(artifact.expires_at) >= Date.parse(context.expiresAt)
    && sameId(artifact.workflow_run?.id, context.identity.runId)
    && sameId(artifact.workflow_run.repository_id, context.identity.repositoryId)
    && sameId(artifact.workflow_run.head_repository_id, context.identity.repositoryId)
    && artifact.workflow_run.head_sha === context.identity.sourceRevision
    && artifact.workflow_run.head_branch === "main", "TRIAL_ARTIFACT");
}

async function observeArtifact(context, kind, environment, token, fetcher = fetch, destination) {
  const id = environment[`TABGRAD_TRIAL_${kind.toUpperCase()}_ID`];
  check(idPattern.test(id ?? ""), "TRIAL_ARTIFACT");
  const observed = await githubRecord(context, `/actions/artifacts/${id}`, token, fetcher);
  if (destination) await writeFile(join(destination, `api-${kind}.json`), observed.raw, { flag: "wx", mode: 0o600 });
  checkTrialArtifact(observed.value, context, kind, id, environment[`TABGRAD_TRIAL_${kind.toUpperCase()}_DIGEST`]);
  return observed;
}

async function announce(directory, context, environment) {
  const packet = await inspectTrialPacket(directory, context);
  const artifact = await observeArtifact(context, "data", environment, environment.GH_TOKEN);
  if (environment.GITHUB_STEP_SUMMARY) await appendFile(environment.GITHUB_STEP_SUMMARY,
    `Candidate ready for separately authorized signing:\n\n\`\`\`json\n${JSON.stringify({ producer: packet.producer,
      data: { id: artifact.value.id, digest: artifact.value.digest, expiresAt: artifact.value.expires_at } }, null, 2)}\n\`\`\`\n`);
}

export async function subjects(directory, context, environment, fetcher = fetch) {
  await observeArtifact(context, "data", environment, environment.GH_TOKEN, fetcher);
  const packet = await inspectTrialPacket(directory, context);
  check(Date.parse(context.expiresAt) > Date.now(), "TRIAL_DEADLINE_OR_ROOT");
  await outputs({ archive_subject: packet.subjects.archive.name, archive_digest: packet.subjects.archive.digest,
    inventory_subject: packet.subjects.inventory.name, inventory_digest: packet.subjects.inventory.digest });
}

export async function retainTrialProofs(archivePath, inventoryPath, directory) {
  await mkdir(directory, { mode: 0o700 }); const files = {}; let failure;
  for (const [kind, path] of [["archive", archivePath], ["inventory", inventoryPath]]) {
    if (path === "") { files[kind] = { present: false }; continue; }
    try {
      const bytes = await original(path, 16 * 1024 * 1024);
      await writeFile(join(directory, `${kind}-proof.json`), bytes, { flag: "wx", mode: 0o600 });
      files[kind] = { present: true, sha256: hash(bytes), bytes: bytes.length };
    } catch (error) {
      failure ??= error;
      files[kind] = { present: false, code: error.code ?? "TRIAL_PROOF_READ" };
    }
  }
  const report = { schemaVersion: 1, complete: files.archive.present && files.inventory.present, files };
  await save(join(directory, "proofs.json"), report);
  if (failure) throw failure;
  return report;
}

export function checkTrialJobs(run, jobs, context) {
  check(sameId(run?.id, context.identity.runId) && run.head_sha === context.identity.sourceRevision
    && run.head_branch === "main" && run.event === "workflow_dispatch" && run.run_attempt === 1
    && run.path === workflow && sameId(run.repository?.id, context.identity.repositoryId)
    && sameId(run.repository?.owner?.id, context.identity.ownerId)
    && jobs.total_count === 3 && Array.isArray(jobs.jobs) && jobs.jobs.length === 3
    && jobs.jobs.filter(job => job.name === "verify-retained-proofs"
      && sameId(job.run_id, context.identity.runId)
      && job.head_sha === context.identity.sourceRevision).length === 1, "TRIAL_CI_IDENTITY");
  for (const name of ["prepare-and-qualify", "sign-qualified-candidate"]) {
    const matching = jobs.jobs.filter(job => job.name === name && job.status === "completed"
      && job.conclusion === "success" && sameId(job.run_id, context.identity.runId)
      && job.head_sha === context.identity.sourceRevision);
    check(matching.length === 1, "TRIAL_CI_QUALIFICATION");
  }
}

export async function verifyTrial(directory, proofs, clientDirectory, destination, context, environment, fetcher = fetch) {
  await mkdir(destination, { mode: 0o700 }); let failure;
  try {
    const packet = await inspectTrialPacket(directory, context);
    await observeArtifact(context, "data", environment, environment.GH_TOKEN, fetcher, destination);
    await observeArtifact(context, "proofs", environment, environment.GH_TOKEN, fetcher, destination);
    const run = await githubRecord(context, `/actions/runs/${context.identity.runId}`, environment.GH_TOKEN, fetcher);
    await writeFile(join(destination, "api-run.json"), run.raw, { flag: "wx", mode: 0o600 });
    const jobs = await githubRecord(context, `/actions/runs/${context.identity.runId}/attempts/1/jobs?per_page=100`, environment.GH_TOKEN, fetcher);
    await writeFile(join(destination, "api-jobs.json"), jobs.raw, { flag: "wx", mode: 0o600 });
    checkTrialJobs(run.value, jobs.value, context);
    const proofReport = json(await original(join(proofs, "proofs.json")));
    check(proofReport.complete === true
      && JSON.stringify((await readdir(proofs)).sort()) === JSON.stringify(["archive-proof.json", "inventory-proof.json", "proofs.json"]), "TRIAL_PROOFS");
    for (const kind of ["archive", "inventory"]) {
      const raw = await original(join(proofs, `${kind}-proof.json`), 16 * 1024 * 1024);
      check(proofReport.files[kind]?.present === true && proofReport.files[kind].sha256 === hash(raw)
        && proofReport.files[kind].bytes === raw.length, "TRIAL_PROOFS");
    }
    const preparedClient = json(await original(join(clientDirectory, "client.json")));
    check(preparedClient.sourceArchiveSha256 === clientArchiveSha256
      && preparedClient.path === join(clientDirectory, "gh") && preparedClient.version === "2.102.0", "TRIAL_CLIENT");
    const client = { path: preparedClient.path, version: preparedClient.version, sha256: preparedClient.sha256 };
    const limits = { timeoutMs: 30000, maxOutputBytes: maxRecordBytes };
    const temporary = await mkdtemp(join(tmpdir(), "tabgrad-trial-client-"));
    let root;
    try {
      await writeFile(join(temporary, "empty-gitconfig"), "");
      await identifyProvenanceClient(client, limits, temporary);
      root = Buffer.from(await runProvenanceClient(client.path,
        ["attestation", "trusted-root", "--hostname", "github.com"], { directory: temporary, ...limits }));
    } finally { await rm(temporary, { recursive: true, force: true }); }
    check(hash(root) === context.trustRootSha256, "TRIAL_TRUST_ROOT");
    await writeFile(join(destination, "trusted-root.jsonl"), root, { flag: "wx", mode: 0o600 });
    const candidate = { inventorySha256: packet.producer.inventorySha256, archiveSha512: packet.producer.archiveSha512 };
    const ci = { schemaVersion: 1, identity: context.identity, candidate, tools: packet.candidate.tools,
      qualification: { status: "passed", evidenceSha256: packet.producer.qualificationSha256 } };
    await save(join(destination, "ci-evidence.json"), ci);
    const plan = { schemaVersion: 1, expiresAt: context.expiresAt, trustRootSha256: context.trustRootSha256,
      client, limits, identity: context.identity, candidate,
      ciEvidenceSha256: hash(await original(join(destination, "ci-evidence.json"))), inventorySubject: "candidate.json" };
    await save(join(destination, "plan.json"), plan);
    const report = await verifyPackageProvenance({ plan, archive: join(directory, packet.candidate.tarball.path),
      inventory: join(directory, "candidate.json"), staticDirectory: join(directory, "package/dist"),
      archiveBundle: join(proofs, "archive-proof.json"), inventoryBundle: join(proofs, "inventory-proof.json"),
      trustRoot: join(destination, "trusted-root.jsonl"), ciEvidence: join(destination, "ci-evidence.json") });
    await save(join(destination, "verification.json"), report);
  } catch (error) { failure = error; }
  if (failure) {
    await save(join(destination, "failure.json"), { status: "failed", code: failure.code ?? "TRIAL_VERIFICATION",
      report: failure.report, releaseAdmission: "unqualified" });
    throw failure;
  }
}

async function main(arguments_) {
  const [command, ...args] = arguments_;
  const context = trialContext(process.env, Date.now(), command === "retain");
  if (command === "admit" && args.length === 0) return;
  if (command === "prepare" && args.length === 1) return prepare(resolve(args[0]), context);
  if (command === "announce" && args.length === 1) return announce(resolve(args[0]), context, process.env);
  if (command === "subjects" && args.length === 1) return subjects(resolve(args[0]), context, process.env);
  if (command === "retain" && args.length === 3) {
    const report = await retainTrialProofs(args[0], args[1], resolve(args[2]));
    check(report.complete, "TRIAL_PARTIAL_PROOFS"); return;
  }
  if (command === "verify" && args.length === 4) return verifyTrial(...args.map(x => resolve(x)), context, process.env);
  throw new ProducerTrialError("TRIAL_ARGUMENTS");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof ProducerTrialError ? error.code : "TRIAL_FAILED"}\n`); process.exitCode = 1; }
}
