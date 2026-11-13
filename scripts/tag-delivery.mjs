/** Tag requests carry data; dispatch runs only from the admitted default-branch controller. */
import { execFileSync } from "node:child_process";
import { appendFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalBytes, sha256 } from "./release-record-data.mjs";
import { requirePublication } from "./publication-plan.mjs";
import { publicationFile } from "./publication-admission.mjs";
import { githubCollection, publicationGithub } from "./publication-github.mjs";
import { admitPublicationPolicy, corroboratePublicationExecution, observePublicationProducer, resolvePublicationExecution } from "./publication-authority.mjs";
import { checkPublicationEnvironment } from "./publication-control.mjs";
import { observeCandidateTag, observePreparedCandidate, readCandidateReadiness, candidateTagMessage,
  tagRequestWorkflow, tagControllerWorkflow } from "./release-readiness.mjs";

const id = value => typeof value === "string" && /^[1-9][0-9]*$/.test(value);
const revision = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const versionTag = value => typeof value === "string" && /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value);

async function outputs(values, environment) {
  if (!environment.GITHUB_OUTPUT) return;
  for (const [key, value] of Object.entries(values)) {
    requirePublication(/^[a-z_][a-z0-9_]*$/.test(key) && typeof value === "string" && !/[\r\n]/.test(value), "PUBLICATION_OUTPUT_INVALID");
    await appendFile(environment.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

function profileForTag(environment, clock) {
  requirePublication(environment.TABGRAD_TAG_DELIVERY_ENABLED === "true" && environment.TABGRAD_PUBLICATION_ENABLED === "true",
    "PUBLICATION_TAG_DISABLED");
  const profile = admitPublicationPolicy(Buffer.from(environment.TABGRAD_RELEASE_POLICY_JSON ?? ""), environment.TABGRAD_RELEASE_POLICY_SHA256, clock());
  requirePublication(profile.schemaVersion === 3 && environment.GITHUB_REPOSITORY_ID === profile.repositoryId
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(environment.GITHUB_REPOSITORY ?? ""), "PUBLICATION_TAG_POLICY_REQUIRED");
  requirePublication(sha256(Buffer.from(environment.TABGRAD_RELEASE_QUALIFICATION_JSON ?? "")) === profile.operationalEvidence.sha256,
    "PUBLICATION_OPERATIONAL_EVIDENCE_UNAVAILABLE");
  return profile;
}

function mainContext(environment, workflow) {
  requirePublication(environment.GITHUB_EVENT_NAME === (workflow === tagControllerWorkflow ? "workflow_run" : "workflow_dispatch")
    && environment.GITHUB_REF === "refs/heads/main" && environment.GITHUB_RUN_ATTEMPT === "1"
    && id(environment.GITHUB_RUN_ID) && revision(environment.GITHUB_SHA)
    && environment.GITHUB_WORKFLOW_REF === `${environment.GITHUB_REPOSITORY}/${workflow}@refs/heads/main`,
  "PUBLICATION_TAG_CONTEXT_INVALID");
  return { event: environment.GITHUB_EVENT_NAME, ref: environment.GITHUB_REF, revision: environment.GITHUB_SHA,
    runId: environment.GITHUB_RUN_ID, attempt: "1", workflowRef: environment.GITHUB_WORKFLOW_REF,
    repositoryId: environment.GITHUB_REPOSITORY_ID };
}

async function tagRequest(api, profile, repository, runId, tag) {
  requirePublication(id(runId) && versionTag(tag), "PUBLICATION_TAG_REQUEST_INVALID");
  const run = await api.request(`/actions/runs/${runId}`);
  requirePublication(String(run.id) === runId && run.path === tagRequestWorkflow && run.event === "push"
    && run.run_attempt === 1 && run.display_title === `Release tag ${tag}` && revision(run.head_sha) && run.status === "completed" && run.conclusion === "success"
    && String(run.repository?.id) === profile.repositoryId && String(run.head_repository?.id) === profile.repositoryId
    && profile.maintainers.some(actor => actor.id === String(run.actor?.id)), "PUBLICATION_TAG_REQUEST_INVALID");
  const jobs = await api.request(`/actions/runs/${runId}/attempts/1/jobs?per_page=100`);
  requirePublication(jobs.total_count === 1 && jobs.jobs?.length === 1 && jobs.jobs[0].name === "request-tag-delivery"
    && String(jobs.jobs[0].run_id) === runId && jobs.jobs[0].head_sha === run.head_sha
    && jobs.jobs[0].status === "completed" && jobs.jobs[0].conclusion === "success", "PUBLICATION_TAG_JOBS_INVALID");
  const observed = await observeCandidateTag(api, tag);
  requirePublication(observed.message.sourceRevision === run.head_sha, "PUBLICATION_TAG_CONFLICT");
  const locator = observed.message.readiness;
  const artifact = await api.request(`/actions/artifacts/${locator.artifactId}`);
  requirePublication(String(artifact.id) === locator.artifactId && artifact.name === `tabgrad-candidate-ready-${locator.runId}-1`
    && artifact.digest === `sha256:${locator.artifactSha256}` && artifact.expired === false
    && Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 128 * 1024 * 1024
    && String(artifact.workflow_run?.id) === locator.runId && artifact.workflow_run.head_branch === "main"
    && String(artifact.workflow_run.repository_id) === profile.repositoryId && String(artifact.workflow_run.head_repository_id) === profile.repositoryId,
  "PUBLICATION_READINESS_ARTIFACT_INVALID");
  return { requestRun: runId, repository, tag, objectSha: observed.objectSha, message: observed.message,
    requestActor: String(run.actor.id), readinessRevision: artifact.workflow_run.head_sha };
}

/** Both controller and receiver select the same public artifact, without executing any of its contents. */
export async function selectTagCandidate(root, environment, { api: supplied, clock = Date.now, controller = false } = {}) {
  requirePublication(isAbsolute(root), "PUBLICATION_PREPARATION_ROOT");
  const profile = profileForTag(environment, clock);
  const context = mainContext(environment, controller ? tagControllerWorkflow : profile.workflow);
  const api = supplied ?? publicationGithub({ repository: environment.GITHUB_REPOSITORY, token: environment.GH_TOKEN, readOnly: true });
  let runId = environment.TABGRAD_TAG_REQUEST_RUN, tag = environment.TABGRAD_RELEASE_TAG;
  if (controller) {
    const event = JSON.parse(await publicationFile(environment.GITHUB_EVENT_PATH, 1024 * 1024));
    requirePublication(Number.isSafeInteger(event.workflow_run?.id) && event.workflow_run.id > 0, "PUBLICATION_TAG_REQUEST_INVALID");
    runId = String(event.workflow_run.id);
    requirePublication(typeof event.workflow_run.display_title === "string" && event.workflow_run.display_title.startsWith("Release tag "),
      "PUBLICATION_TAG_REQUEST_INVALID");
    tag = event.workflow_run.display_title.slice("Release tag ".length);
  }
  const selected = await tagRequest(api, profile, environment.GITHUB_REPOSITORY, runId, tag);
  if (!controller) requirePublication(environment.TABGRAD_TAG_OBJECT === selected.objectSha, "PUBLICATION_TAG_SELECTION_CHANGED");
  requirePublication(selected.readinessRevision === context.revision, "PUBLICATION_TAG_RECIPE_STALE");
  await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, "tag-selection.json"), canonicalBytes({ ...selected, context }), { flag: "wx", mode: 0o600 });
  return { mode: "tag", readiness_id: selected.message.readiness.artifactId, readiness_run: selected.message.readiness.runId, readiness_sha256: selected.message.readiness.sha256, tag_object: selected.objectSha };
}

async function admittedCandidate(root, environment, api, profile, context, clock) {
  const selected = JSON.parse(await publicationFile(join(root, "tag-selection.json"), 65536));
  requirePublication(selected.context.runId === context.runId && selected.context.revision === context.revision
    && selected.context.workflowRef === context.workflowRef, "PUBLICATION_TAG_CONTEXT_INVALID");
  const current = await tagRequest(api, profile, environment.GITHUB_REPOSITORY, selected.requestRun, selected.tag);
  requirePublication(canonicalBytes(current).equals(canonicalBytes(Object.fromEntries(Object.keys(current).map(key => [key, selected[key]])))),
    "PUBLICATION_TAG_SELECTION_CHANGED");
  const candidate = await readCandidateReadiness(join(root, "candidate-ready"), environment.TABGRAD_RELEASE_POLICY_SHA256, clock());
  const { ready, plan } = candidate;
  requirePublication(plan.publisher.revision === context.revision && plan.github.tag === current.tag
    && plan.candidate.sourceRevision === current.message.sourceRevision && candidate.sha256 === current.message.readiness.sha256
    && profile.maintainers.some(actor => actor.id === current.requestActor && actor.ownerSha256 === plan.owner),
  "PUBLICATION_TAG_SELECTION_CHANGED");
  await observePreparedCandidate({ api, plan, planSha256: ready.planSha256, profile, ready,
    locator: current.message.readiness, policySha256: environment.TABGRAD_RELEASE_POLICY_SHA256, clock });
  const preparation = { ...context, runId: ready.preparation.runId, revision: ready.preparation.revision,
    event: "workflow_dispatch", workflowRef: `${environment.GITHUB_REPOSITORY}/${profile.workflow}@refs/heads/main` };
  const policy = resolvePublicationExecution(profile, candidate.execution, plan, preparation, clock());
  await corroboratePublicationExecution({ api, policy, execution: candidate.execution, plan, context: preparation, initial: true, clock });
  await observePublicationProducer(api, plan);
  for (const environment of [profile.tagDelivery.environment, profile.tagDelivery.websiteEnvironment]) {
    await checkPublicationEnvironment({ api, plan, policy: { ...profile, environment, tagAdmission: true }, clock });
  }
  requirePublication(clock() < Date.parse(plan.window.deadline), "PUBLICATION_WINDOW_EXPIRED");
  return { ...candidate, selected: current };
}

/** One dispatch, after its immutable intent is retained. A lost/malformed response stays unknown. */
export async function dispatchTagCandidate(root, environment, { api: supplied, clock = Date.now } = {}) {
  const profile = profileForTag(environment, clock), context = mainContext(environment, tagControllerWorkflow);
  const api = supplied ?? publicationGithub({ repository: environment.GITHUB_REPOSITORY, token: environment.GH_TOKEN });
  const candidate = await admittedCandidate(root, environment, api, profile, context, clock);
  const { selected, plan, ready } = candidate;
  const main = await api.request("/git/ref/heads/main");
  requirePublication(main.object?.type === "commit" && main.object.sha === context.revision, "PUBLICATION_TAG_RECIPE_STALE");
  const current = await api.request(`/actions/runs/${context.runId}`);
  requirePublication(current.path === tagControllerWorkflow && current.event === "workflow_run" && current.head_sha === context.revision
    && current.head_branch === "main" && current.run_attempt === 1 && current.status === "in_progress"
    && String(current.repository?.id) === profile.repositoryId && String(current.head_repository?.id) === profile.repositoryId,
  "PUBLICATION_TAG_CONTEXT_INVALID");
  const runs = await githubCollection(api, `/actions/workflows/${encodeURIComponent(tagControllerWorkflow)}/runs?event=workflow_run&head_sha=${context.revision}`, "workflow_runs");
  const same = runs.filter(run => run.display_title === `Tag delivery ${selected.requestRun}` && run.path === tagControllerWorkflow);
  requirePublication(same.length === 1 && String(same[0].id) === context.runId, "PUBLICATION_TAG_DISPATCH_DUPLICATE");
  for (const prior of runs.filter(run => String(run.id) !== context.runId)) {
    requirePublication(Number.isSafeInteger(prior.id) && Number.isSafeInteger(prior.run_attempt) && prior.run_attempt >= 1 && prior.path === tagControllerWorkflow
      && prior.event === "workflow_run" && prior.head_sha === context.revision, "PUBLICATION_TAG_DISPATCH_DUPLICATE");
    const jobs = await api.request(`/actions/runs/${prior.id}/attempts/1/jobs?per_page=100`);
    requirePublication(jobs.total_count <= 100 && jobs.jobs?.length === jobs.total_count, "PUBLICATION_TAG_DISPATCH_DUPLICATE");
    requirePublication(!jobs.jobs.some(job => job.name === "dispatch-tag-delivery" && String(job.run_id) === String(prior.id) && job.head_sha === context.revision
      && job.steps?.some(step => typeof step.name === "string" && step.name.startsWith(`Selected candidate ${candidate.sha256} `) && step.status === "completed" && step.conclusion === "success")),
    "PUBLICATION_TAG_DISPATCH_DUPLICATE");
  }
  requirePublication(clock() < Date.parse(plan.window.deadline), "PUBLICATION_WINDOW_EXPIRED");
  await mkdir(join(root, "public-output"), { mode: 0o700 });
  const intent = { schemaVersion: 1, requestRun: selected.requestRun, controllerRun: context.runId,
    planSha256: ready.planSha256, tagObjectSha: selected.objectSha };
  await writeFile(join(root, "public-output/dispatch-intent.json"), canonicalBytes(intent), { flag: "wx", mode: 0o600 });
  let outcome = "unknown", runId = null, failure, called = false;
  try {
    requirePublication(clock() < Date.parse(plan.window.deadline), "PUBLICATION_WINDOW_EXPIRED");
    called = true;
    const response = await api.request(`/actions/workflows/${encodeURIComponent(profile.workflow)}/dispatches`, {
      method: "POST", workflowDispatch: true, body: { ref: "main", inputs: { confirmation: "release-publication",
        release_tag: selected.tag, tag_request_run: selected.requestRun, tag_controller_run: context.runId, tag_object: selected.objectSha } } });
    requirePublication(Number.isSafeInteger(response?.workflow_run_id) && response.workflow_run_id > 0
      && response.run_url === `https://api.github.com/repos/${environment.GITHUB_REPOSITORY}/actions/runs/${response.workflow_run_id}`
      && response.html_url === `https://github.com/${environment.GITHUB_REPOSITORY}/actions/runs/${response.workflow_run_id}`,
    "PUBLICATION_TAG_DISPATCH_RESPONSE");
    runId = String(response.workflow_run_id); outcome = "confirmed-dispatch";
  } catch (error) { failure = error; if (!called || error.dispatched === false) outcome = "verified-no-dispatch"; }
  await writeFile(join(root, "public-output/dispatch-result.json"), canonicalBytes({ ...intent, outcome, runId,
    code: failure?.code ?? null }), { flag: "wx", mode: 0o600 });
  if (failure) throw failure;
  return { run_id: runId, plan_sha256: ready.planSha256, tag_object: selected.objectSha, readiness_sha256: candidate.sha256 };
}

/** Short completion handoff only; no controller runner waits for the publication itself. */
async function completedController(api, runId, plan, { clock, pause }) {
  requirePublication(id(runId), "PUBLICATION_TAG_DISPATCH_INVALID");
  const deadline = Math.min(Date.parse(plan.window.deadline), clock() + 600000);
  while (clock() < deadline) {
    const run = await api.request(`/actions/runs/${runId}`);
    requirePublication(run.run_attempt === 1 && run.path === tagControllerWorkflow
      && ["completed", "queued", "in_progress", "waiting", "pending", "requested"].includes(run.status)
      && (run.status === "completed" ? run.conclusion === "success" : run.conclusion === null), "PUBLICATION_TAG_DISPATCH_INVALID");
    if (run.status === "completed") {
      requirePublication(run.conclusion === "success" && clock() < deadline, "PUBLICATION_TAG_DISPATCH_INVALID");
      return;
    }
    await pause(Math.min(15000, Math.max(1, deadline - clock())));
  }
  requirePublication(false, "PUBLICATION_TAG_DISPATCH_DEADLINE");
}

/** Frozen plan bytes are copied unchanged; only the new actual execution binding is derived. */
export async function activateTagCandidate(root, environment, { api: supplied, clock = Date.now, pause = delay } = {}) {
  const profile = profileForTag(environment, clock), context = mainContext(environment, profile.workflow);
  const api = supplied ?? publicationGithub({ repository: environment.GITHUB_REPOSITORY, token: environment.GH_TOKEN, readOnly: true });
  const candidate = await admittedCandidate(root, environment, api, profile, context, clock);
  await completedController(api, environment.TABGRAD_TAG_CONTROLLER_RUN, candidate.plan, { clock, pause });
  const tag = { objectSha: candidate.selected.objectSha, locator: candidate.selected.message.readiness,
    ready: candidate.ready, requestRun: candidate.selected.requestRun, controllerRun: environment.TABGRAD_TAG_CONTROLLER_RUN };
  const execution = { ...candidate.execution, schemaVersion: 2,
    publisher: { revision: context.revision, runId: context.runId, attempt: context.attempt }, tag };
  const policy = resolvePublicationExecution(profile, execution, candidate.plan, context, clock());
  const { observeTagAuthority } = await import("./release-readiness.mjs");
  await observeTagAuthority({ api, plan: candidate.plan, planSha256: candidate.ready.planSha256, policy, context,
    policySha256: environment.TABGRAD_RELEASE_POLICY_SHA256, clock });
  await mkdir(join(root, "input"), { mode: 0o700 });
  for (const name of ["plan.json", "notes.md", "qualification.json", "producer-evidence.json", "release-checksums.txt"]) {
    await cp(join(root, "candidate-ready/input", name), join(root, "input", name), { errorOnExist: true, force: false });
  }
  await writeFile(join(root, "input/execution.json"), canonicalBytes(execution), { flag: "wx", mode: 0o600 });
  const p = candidate.plan;
  return { mode: "tag", plan_sha256: candidate.ready.planSha256, data_id: p.producer.data.id,
    proofs_id: p.producer.proofs.id, verification_id: p.producer.corroboration.id,
    producer_run: p.producer.verification.identity.runId, history_id: candidate.execution.history.id, history_run: candidate.execution.history.runId };
}

async function main() {
  const [command, directory, metadata, destination] = process.argv.slice(2), environment = process.env;
  if (command === "message") {
    requirePublication(process.argv.length === 6, "PUBLICATION_TAG_USAGE");
    const ready = JSON.parse(await publicationFile(join(resolve(directory), "candidate-ready.json"), 65536));
    const selected = await readCandidateReadiness(resolve(directory), ready.policySha256);
    const artifact = JSON.parse(await publicationFile(resolve(metadata), 65536));
    const message = candidateTagMessage({ version: selected.plan.candidate.version, sourceRevision: selected.plan.candidate.sourceRevision,
      readiness: { runId: selected.ready.preparation.runId, artifactId: String(artifact.id),
        artifactSha256: artifact.digest?.slice(7), sha256: selected.sha256 } });
    requirePublication(artifact.digest === `sha256:${message.readiness.artifactSha256}`
      && artifact.name === `tabgrad-candidate-ready-${message.readiness.runId}-1`, "PUBLICATION_READINESS_ARTIFACT_INVALID");
    await writeFile(resolve(destination), canonicalBytes(message), { flag: "wx", mode: 0o600 });
    return { status: "tag-message-prepared", tag: `v${message.version}`, sourceRevision: message.sourceRevision };
  }
  if (command === "request") {
    requirePublication(process.argv.length === 3, "PUBLICATION_TAG_USAGE");
    requirePublication(environment.TABGRAD_TAG_DELIVERY_ENABLED === "true" && environment.GITHUB_EVENT_NAME === "push"
      && environment.GITHUB_RUN_ATTEMPT === "1" && versionTag(environment.GITHUB_REF?.slice(10)), "PUBLICATION_TAG_CONTEXT_INVALID");
    const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
    const source = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const version = JSON.parse(await readFile(join(root, "package.json"))).version;
    requirePublication(environment.GITHUB_REF === `refs/tags/v${version}` && source === environment.GITHUB_SHA, "PUBLICATION_TAG_CONFLICT");
    return { status: "tag-requested", tag: `v${version}`, sourceRevision: source };
  }
  requirePublication(process.argv.length === 4, "PUBLICATION_TAG_USAGE");
  requirePublication(process.execArgv.length === 0 && ["NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY"].every(key => !environment[key]),
    "PUBLICATION_RECIPE_RUNTIME");
  requirePublication(environment.NODE_TLS_REJECT_UNAUTHORIZED !== "0", "PUBLICATION_PROCESS_PROFILE");
  const profile = profileForTag(environment, Date.now);
  requirePublication(process.version === "v22.12.0" && sha256(await readFile(process.execPath)) === profile.clients.controller,
    "PUBLICATION_RECIPE_RUNTIME");
  const root = resolve(directory);
  const result = command === "select" ? await selectTagCandidate(root, environment, { controller: true })
    : command === "dispatch" ? await dispatchTagCandidate(root, environment) : null;
  requirePublication(result !== null, "PUBLICATION_TAG_USAGE"); await outputs(result, environment);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await main())}\n`); }
  catch (error) { process.stdout.write(`${JSON.stringify({ status: "failed", code: error.code ?? "PUBLICATION_TAG_DELIVERY_FAILED" })}\n`); process.exitCode = 1; }
}
