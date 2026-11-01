/** Read-only release preparation. Importing this module performs no service operation. */
import { appendFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalBytes, sha256 } from "./release-record-data.mjs";
import { requirePublication } from "./publication-plan.mjs";
import { admitPublicationPolicy, observePublicationPreparation, observePublicationPrecheck, observePublicationProducer,
  resolvePublicationExecution, corroboratePublicationExecution } from "./publication-authority.mjs";
import { publicationGithub } from "./publication-github.mjs";
import { publicationRegistry } from "./publication-registry.mjs";
import { publicationFile, validatePublicationQualification } from "./publication-admission.mjs";
import { preparePublicationPlan } from "./prepare-publication-plan.mjs";
import { publicationContext } from "./release-publication.mjs";
import { readProducerInventory } from "./package-provenance.mjs";
import { publicationHistoryInput, publicationRecordConfig, transferPublicationHistory } from "./publication-controller.mjs";
import { releaseRecord } from "./release-record.mjs";

const id = value => typeof value === "string" && /^[1-9][0-9]*$/.test(value);
const commit = value => typeof value === "string" && /^(?!0{40}$)[a-f0-9]{40}$/.test(value);
const version = value => typeof value === "string" && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value);
const producerWorkflow = ".github/workflows/producer-trial.yml";
const sourceWorkflow = ".github/workflows/repository-checks.yml";

/** Whole keyed collections, rejecting changing/incomplete totals and duplicate identifiers. */
export async function releasePreparationPages(api, route, key) {
  const values = [], seen = new Set(); let expected;
  for (let page = 1; page <= 100; page++) {
    const result = await api.request(`${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const rows = result?.[key];
    requirePublication(Number.isSafeInteger(result?.total_count) && result.total_count >= 0 && result.total_count <= 10000
      && Array.isArray(rows) && rows.length <= 100 && (expected === undefined || expected === result.total_count),
    "PUBLICATION_PREPARATION_PAGINATION");
    expected = result.total_count;
    for (const row of rows) {
      requirePublication(Number.isSafeInteger(row?.id) && row.id > 0 && !seen.has(row.id), "PUBLICATION_PREPARATION_PAGINATION");
      seen.add(row.id); values.push(row);
    }
    requirePublication(values.length <= expected, "PUBLICATION_PREPARATION_PAGINATION");
    if (values.length === expected) return values;
    requirePublication(rows.length === 100, "PUBLICATION_PREPARATION_PAGINATION");
  }
  throw Object.assign(new Error("PUBLICATION_PREPARATION_PAGINATION"), { code: "PUBLICATION_PREPARATION_PAGINATION" });
}

export function selectReleaseProducer(runs, source, repositoryId, explicit = "") {
  requirePublication(commit(source) && (explicit === "" || id(explicit)), "PUBLICATION_PREPARATION_INTENT");
  const eligible = runs.filter(run => Number.isSafeInteger(run.id) && run.id > 0 && (explicit === "" || String(run.id) === explicit)
    && run.head_sha === source && run.head_branch === "main" && run.event === "workflow_dispatch"
    && run.run_attempt === 1 && run.path === producerWorkflow && run.status === "completed" && run.conclusion === "success"
    && String(run.repository?.id) === repositoryId && String(run.head_repository?.id) === repositoryId);
  requirePublication(eligible.length === 1, "PUBLICATION_PRODUCER_SELECTION");
  return eligible[0];
}

export function releaseArtifact(artifact, runId, repositoryId, revision, now = Date.now()) {
  requirePublication(id(runId) && id(repositoryId) && commit(revision)
    && Number.isSafeInteger(artifact?.id) && artifact.id > 0 && artifact.expired === false
    && Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 128 * 1024 * 1024
    && /^sha256:[a-f0-9]{64}$/.test(artifact.digest) && Date.parse(artifact.expires_at) > now
    && String(artifact.workflow_run?.id) === runId && artifact.workflow_run.head_sha === revision
    && artifact.workflow_run.head_branch === "main"
    && String(artifact.workflow_run.repository_id) === repositoryId && String(artifact.workflow_run.head_repository_id) === repositoryId,
  "PUBLICATION_PREPARATION_ARTIFACT");
  return { id: String(artifact.id), sha256: artifact.digest.slice(7), expiresAt: new Date(artifact.expires_at).toISOString() };
}

/** Selection is only a transfer hint; complete replay against the actual enrolled head is mandatory. */
export function selectReleaseHistory(artifacts, repositoryId, explicit = "", now = Date.now()) {
  requirePublication(explicit === "" || id(explicit), "PUBLICATION_HISTORY_SELECTION");
  const eligible = artifacts.filter(a => {
    const run = String(a.workflow_run?.id);
    return (explicit === "" || String(a.id) === explicit) && a.expired === false && Date.parse(a.expires_at) > now
      && ["history", "observation", "completion"].some(kind => a.name === `tabgrad-publication-${kind}-${run}-1`);
  }).sort((a, b) => b.id - a.id);
  requirePublication(eligible.length > 0 && (explicit === "" || eligible.length === 1), "PUBLICATION_HISTORY_SELECTION");
  const a = eligible[0], runId = String(a.workflow_run.id), revision = a.workflow_run.head_sha;
  return { ...releaseArtifact(a, runId, repositoryId, revision, now), runId, revision, name: a.name };
}

async function sourceFile(api, path, revision) {
  const file = await api.request(`/contents/${path}?ref=${revision}`);
  requirePublication(file.type === "file" && file.encoding === "base64" && typeof file.content === "string"
    && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= 1024 * 1024, "PUBLICATION_SOURCE_FILE");
  const raw = Buffer.from(file.content.replace(/\n/g, ""), "base64");
  requirePublication(raw.length === file.size, "PUBLICATION_SOURCE_FILE");
  return raw;
}

export function releaseNotes(changelog, selectedVersion, repository, source) {
  const lines = changelog.split(/\r?\n/), starts = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].startsWith(`## ${selectedVersion} - `)) starts.push(i);
  requirePublication(starts.length === 1, "PUBLICATION_SOURCE_NOTES");
  const end = lines.findIndex((line, index) => index > starts[0] && line.startsWith("## "));
  const text = lines.slice(starts[0], end < 0 ? lines.length : end).join("\n").trim();
  requirePublication(text.length > lines[starts[0]].length, "PUBLICATION_SOURCE_NOTES");
  return text.replace(/\]\((?![a-z]+:|#)([^\s)]+)\)/gi,
    (_match, path) => `](https://github.com/${repository}/blob/${source}/${path})`) + "\n";
}

async function sourceCheck(api, revision, repositoryId) {
  const runs = await releasePreparationPages(api,
    `/actions/workflows/${encodeURIComponent(sourceWorkflow)}/runs?branch=main&event=push&head_sha=${revision}`, "workflow_runs");
  const matches = runs.filter(run => run.head_sha === revision && run.path === sourceWorkflow && run.head_branch === "main"
    && run.event === "push" && run.status === "completed" && run.conclusion === "success"
    && String(run.repository?.id) === repositoryId && String(run.head_repository?.id) === repositoryId);
  requirePublication(matches.length === 1, "PUBLICATION_SOURCE_CHECKS_INVALID");
  return { revision, runId: String(matches[0].id), attempt: String(matches[0].run_attempt) };
}

async function sourceChecks(api, revisions, repositoryId) {
  const results = await Promise.allSettled([...new Set(revisions)].map(revision => sourceCheck(api, revision, repositoryId)));
  const failure = results.find(result => result.status === "rejected");
  if (failure) throw failure.reason;
  return results.map(result => result.value);
}

async function preparationState(environment, clock) {
  requirePublication(environment.TABGRAD_PUBLICATION_ENABLED === "true"
    && environment.TABGRAD_PUBLICATION_CONFIRMATION === "release-publication", "PUBLICATION_DISABLED");
  const profile = admitPublicationPolicy(Buffer.from(environment.TABGRAD_RELEASE_POLICY_JSON ?? ""),
    environment.TABGRAD_RELEASE_POLICY_SHA256, clock());
  const intent = environment.TABGRAD_RELEASE_VERSION ?? "", source = environment.TABGRAD_RELEASE_SOURCE ?? "";
  if (profile.schemaVersion === 1) {
    requirePublication(intent === "" && source === "", "PUBLICATION_MIXED_EPOCHS"); return { legacy: true };
  }
  requirePublication(version(intent) && commit(source) && !environment.TABGRAD_PUBLICATION_PLAN_JSON
    && !environment.TABGRAD_PUBLICATION_PLAN_SHA256 && !environment.TABGRAD_PUBLICATION_NOTES
    && !environment.TABGRAD_PUBLICATION_QUALIFICATION_JSON, "PUBLICATION_PREPARATION_INTENT");
  const repository = environment.GITHUB_REPOSITORY, context = publicationContext(environment);
  requirePublication(typeof repository === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), "PUBLICATION_PREPARATION_CONTEXT");
  const evidence = Buffer.from(environment.TABGRAD_RELEASE_QUALIFICATION_JSON ?? "");
  requirePublication(sha256(evidence) === profile.operationalEvidence.sha256, "PUBLICATION_OPERATIONAL_EVIDENCE_UNAVAILABLE");
  return { legacy: false, profile, version: intent, source, repository, context };
}

/** No provider write, npm identity, artifact execution or approval. */
export async function selectReleaseInputs(root, environment, { clock = Date.now, api: suppliedApi } = {}) {
  const state = await preparationState(environment, clock);
  if (state.legacy) return { mode: "legacy" };
  requirePublication(isAbsolute(root), "PUBLICATION_PREPARATION_ROOT");
  const { profile, context, repository, source } = state;
  const api = suppliedApi ?? publicationGithub({ repository, token: environment.GH_TOKEN, readOnly: true });
  const start = new Date(clock()).toISOString();
  await observePublicationPreparation({ api, profile, context, repository, clock,
    window: { start, deadline: profile.operationalEvidence.expiresAt } });
  const current = await api.request(`/actions/runs/${context.runId}`);
  const owner = profile.maintainers.find(actor => actor.id === String(current.actor?.id));
  requirePublication(owner !== undefined, "PUBLICATION_PREPARATION_OWNER");
  const metadata = JSON.parse(await sourceFile(api, "package.json", source));
  requirePublication(metadata.version === state.version && metadata.private !== true
    && typeof metadata.name === "string", "PUBLICATION_DRAFT_SOURCE_MISMATCH");
  const notes = releaseNotes((await sourceFile(api, "CHANGELOG.md", source)).toString(), state.version, repository, source);
  const explicit = environment.TABGRAD_RELEASE_PRODUCER_RUN ?? "";
  requirePublication(explicit === "" || id(explicit), "PUBLICATION_PRODUCER_SELECTION");
  const runs = explicit ? [await api.request(`/actions/runs/${explicit}`)]
    : await releasePreparationPages(api, `/actions/workflows/${encodeURIComponent(producerWorkflow)}/runs?branch=main&event=workflow_dispatch&status=success&head_sha=${source}`, "workflow_runs");
  const producer = selectReleaseProducer(runs, source, profile.repositoryId, explicit);
  const artifacts = await releasePreparationPages(api, `/actions/runs/${producer.id}/artifacts`, "artifacts");
  const outputs = {};
  for (const [key, kind] of [["data", "data"], ["proofs", "proofs"], ["corroboration", "verification"]]) {
    const matches = artifacts.filter(a => a.name === `tabgrad-producer-${kind}-${producer.id}-1`);
    requirePublication(matches.length === 1, "PUBLICATION_PREPARATION_ARTIFACT");
    outputs[key] = releaseArtifact(matches[0], String(producer.id), profile.repositoryId, source, clock());
  }
  const history = selectReleaseHistory(await releasePreparationPages(api, "/actions/artifacts", "artifacts"),
    profile.repositoryId, environment.TABGRAD_RELEASE_HISTORY_ARTIFACT ?? "", clock());
  const head = await api.request(`/git/ref/${profile.record.ref.slice(5)}`);
  requirePublication(head.ref === profile.record.ref && head.object?.type === "commit" && commit(head.object.sha), "PUBLICATION_RECORD_HEAD");
  const checks = await sourceChecks(api, [source, context.revision], profile.repositoryId);
  const issue = environment.TABGRAD_RECEIPT_ISSUE;
  requirePublication(id(issue), "PUBLICATION_PHYSICAL_CHANNEL_REQUIRED");
  const selection = { schemaVersion: 1, publisher: { revision: context.revision, runId: context.runId, attempt: context.attempt },
    source, version: state.version, name: metadata.name, owner: owner.ownerSha256, notesSha256: sha256(Buffer.from(notes)), start,
    producerRun: String(producer.id), outputs, history, recordHead: head.object.sha, sourceChecks: checks,
    issue, physicalComment: environment.TABGRAD_RELEASE_PHYSICAL_COMMENT ?? "" };
  await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, "selection.json"), canonicalBytes(selection), { flag: "wx", mode: 0o600 });
  return { mode: "intent", data_id: outputs.data.id, proofs_id: outputs.proofs.id, verification_id: outputs.corroboration.id,
    producer_run: selection.producerRun, history_id: history.id, history_run: history.runId };
}

export async function composeReleaseInputs(root, environment, { clock = Date.now, api: suppliedApi, registry: suppliedRegistry,
  replay = releaseRecord } = {}) {
  const state = await preparationState(environment, clock);
  requirePublication(!state.legacy, "PUBLICATION_MIXED_EPOCHS");
  const { profile, context, repository } = state;
  const api = suppliedApi ?? publicationGithub({ repository, token: environment.GH_TOKEN, readOnly: true });
  const s = JSON.parse(await publicationFile(join(root, "selection.json"), 65536));
  requirePublication(s.source === state.source && s.version === state.version && s.publisher.revision === context.revision
    && s.publisher.runId === context.runId && s.publisher.attempt === context.attempt, "PUBLICATION_PREPARATION_CHANGED");
  const metadata = JSON.parse(await sourceFile(api, "package.json", state.source));
  const notes = releaseNotes((await sourceFile(api, "CHANGELOG.md", state.source)).toString(), state.version, repository, state.source);
  const current = await api.request(`/actions/runs/${context.runId}`);
  requirePublication(metadata.name === s.name && metadata.version === s.version && metadata.private !== true
    && s.notesSha256 === sha256(Buffer.from(notes)) && profile.maintainers.some(actor => actor.id === String(current.actor?.id) && actor.ownerSha256 === s.owner),
  "PUBLICATION_PREPARATION_CHANGED");
  const data = join(root, "data"), verification = join(root, "verification");
  const candidate = readProducerInventory(await publicationFile(join(data, "candidate.json"), 2 * 1024 * 1024));
  requirePublication(candidate.name === s.name && candidate.version === s.version && candidate.sourceRevision === s.source,
    "PUBLICATION_DRAFT_SOURCE_MISMATCH");
  const proofPlan = JSON.parse(await publicationFile(join(verification, "plan.json"), 65536));
  delete proofPlan.client.path;
  requirePublication(proofPlan.identity.runId === s.producerRun && proofPlan.identity.sourceRevision === s.source,
    "PUBLICATION_PRODUCER_SELECTION");
  const producer = JSON.parse(await publicationFile(join(data, "producer.json"), 65536));
  const deadline = new Date(Math.min(...[profile.operationalEvidence.expiresAt, producer.expiresAt, proofPlan.expiresAt,
    s.history.expiresAt, ...Object.values(s.outputs).map(a => a.expiresAt)].map(Date.parse))).toISOString();
  await observePublicationPreparation({ api, profile, context, repository, clock, window: { start: s.start, deadline } });
  const inventorySha = sha256(await readFile(join(data, "candidate.json")));
  const prefix = `tabgrad-release-qualification ${s.producerRun}/1 ${inventorySha}\n`;
  const comments = s.physicalComment ? [await api.request(`/issues/comments/${id(s.physicalComment) ? s.physicalComment : "invalid"}`)]
    : await api.pages(`/issues/${s.issue}/comments`);
  const matches = comments.filter(c => (!s.physicalComment || String(c.id) === s.physicalComment)
    && typeof c.body === "string" && c.body.startsWith(prefix)
    && c.issue_url === `https://api.github.com/repos/${repository}/issues/${s.issue}`
    && profile.maintainers.some(actor => actor.id === String(c.user?.id) && actor.ownerSha256 === s.owner));
  requirePublication(matches.length === 1, "PUBLICATION_PHYSICAL_EVIDENCE_REQUIRED");
  const comment = matches[0], gpu = JSON.parse(comment.body.slice(prefix.length));
  const cpu = JSON.parse(await publicationFile(join(data, "qualification.json"), 4 * 1024 * 1024));
  const qualification = [cpu, gpu];
  const registry = suppliedRegistry ?? publicationRegistry();
  const before = await registry.startingState(candidate.name, candidate.version, "latest");
  const draft = { schemaVersion: 1, owner: s.owner, window: { start: s.start, deadline },
    candidate: { name: s.name, version: s.version, sourceRevision: s.source },
    producer: { verification: proofPlan, ...s.outputs },
    publisher: { repository, workflow: profile.workflow, revision: context.revision,
      clientSha256: profile.clients.npm, githubClientSha256: profile.clients.controller },
    npm: { registry: "https://registry.npmjs.org/", channel: "latest", access: "public", mode: "oidc", before },
    github: { repository, tag: `v${s.version}`, latest: true, prerelease: false, before: { tagRevision: null, releaseId: null },
      assets: [["archive", candidate.tarball.path], ["inventory", "candidate.json"], ["archive-proof", "archive-proof.json"],
        ["inventory-proof", "inventory-proof.json"], ["evidence", "producer-evidence.json"], ["checksums", "release-checksums.txt"]]
        .map(([kind, name]) => ({ kind, name })) },
    qualification: { browsers: ["Chrome", "Firefox"], gpu: true }, continuation: null };
  await mkdir(join(root, "input"), { mode: 0o700 });
  await writeFile(join(root, "input/notes.md"), notes, { flag: "wx", mode: 0o600 });
  await writeFile(join(root, "input/qualification.json"), canonicalBytes(qualification), { flag: "wx", mode: 0o600 });
  await writeFile(join(root, "draft.json"), canonicalBytes(draft), { flag: "wx", mode: 0o600 });
  const prepared = await preparePublicationPlan(root, join(root, "composed"));
  const plan = JSON.parse(await readFile(join(root, "composed/input/plan.json")));
  validatePublicationQualification(qualification, candidate, plan);
  const execution = { schemaVersion: 1, planSha256: prepared.planSha256, publisher: s.publisher,
    sourceChecks: s.sourceChecks, history: s.history, recordHead: s.recordHead,
    physical: { issue: s.issue, commentId: String(comment.id), sha256: sha256(Buffer.from(comment.body)) } };
  const policy = resolvePublicationExecution(profile, execution, plan, context, clock());
  await corroboratePublicationExecution({ api, policy, execution, plan, context, initial: true, clock });
  await observePublicationPrecheck({ api, policy, plan, context, activeJobName: "precheck-publication", clock });
  await observePublicationProducer(api, plan); await api.prerequisites(plan);
  const source = await publicationHistoryInput(root, join(root, "initial-history"), policy.history);
  await transferPublicationHistory(source, join(root, "preparation-evidence"));
  const config = await publicationRecordConfig(join(root, "preparation-evidence"), policy);
  const journal = await replay({ command: "read", config, expectedHead: execution.recordHead });
  requirePublication(journal.head === execution.recordHead && journal.checkpoint.activeOperation === null
    && journal.checkpoint.blockingUnresolvedCalls === 0 && journal.checkpoint.conflictingCalls === 0, "PUBLICATION_RECORD_BLOCKED");
  await writeFile(join(root, "composed/input/execution.json"), canonicalBytes(execution), { flag: "wx", mode: 0o600 });
  for (const name of ["plan.json", "notes.md", "qualification.json", "producer-evidence.json", "release-checksums.txt", "execution.json"]) {
    await cp(join(root, "composed/input", name), join(root, "input", name));
  }
  return { plan_sha256: prepared.planSha256, mode: "oidc" };
}

async function main() {
  const [command, root] = process.argv.slice(2);
  requirePublication(process.argv.length === 4 && ["select", "compose"].includes(command), "PUBLICATION_PREPARATION_USAGE");
  requirePublication(process.execArgv.length === 0 && ["NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY"]
    .every(key => !process.env[key]) && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0", "PUBLICATION_PROCESS_PROFILE");
  requirePublication(process.env.TABGRAD_PUBLICATION_ENABLED === "true"
    && process.env.TABGRAD_PUBLICATION_CONFIRMATION === "release-publication", "PUBLICATION_DISABLED");
  const profile = admitPublicationPolicy(Buffer.from(process.env.TABGRAD_RELEASE_POLICY_JSON ?? ""), process.env.TABGRAD_RELEASE_POLICY_SHA256);
  if (profile.schemaVersion === 2) requirePublication(process.version === "v22.12.0"
    && sha256(await readFile(process.execPath)) === profile.clients.controller, "PUBLICATION_RECIPE_RUNTIME");
  process.env.GIT_ASKPASS = fileURLToPath(new URL("./release-record-askpass.mjs", import.meta.url));
  if (process.env.GH_TOKEN) process.env.GITHUB_TOKEN = process.env.GH_TOKEN;
  const result = command === "select" ? await selectReleaseInputs(root, process.env) : await composeReleaseInputs(root, process.env);
  if (process.env.GITHUB_OUTPUT) for (const [key, value] of Object.entries(result)) {
    requirePublication(/^[a-z_]+$/.test(key) && typeof value === "string" && !/[\r\n]/.test(value), "PUBLICATION_OUTPUT_INVALID");
    await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { await main(); }
  catch (error) { process.stdout.write(`${JSON.stringify({ status: "failed", code: error.code ?? "PUBLICATION_PREPARATION_FAILED" })}\n`); process.exitCode = 1; }
}
