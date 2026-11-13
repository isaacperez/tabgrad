import { randomBytes } from "node:crypto";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalBytes, sha256 } from "./release-record-data.mjs";
import { exactPublicationKeys, requirePublication, validatePublicationPlan, verifyPublicationAuthority } from "./publication-plan.mjs";
import { publicationFile } from "./publication-admission.mjs";
import { checkPublicationControl, observeEnvironmentApproval } from "./publication-control.mjs";

export const tagRequestWorkflow = ".github/workflows/tag-request.yml";
export const tagControllerWorkflow = ".github/workflows/tag-delivery.yml";
const id = value => typeof value === "string" && /^[1-9][0-9]*$/.test(value);
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const revision = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const inputNames = ["plan.json", "execution.json", "notes.md", "qualification.json", "producer-evidence.json", "release-checksums.txt"];

/** A readiness file is an identity to corroborate, never a self-authenticating approval. */
export function validateCandidateReadiness(value, plan, policySha256) {
  requirePublication(exactPublicationKeys(value, ["schemaVersion", "kind", "planSha256", "policySha256",
    "executionSha256", "approvalSha256", "preparation", "nonce"])
    && value.schemaVersion === 1 && value.kind === "tabgrad-release-candidate"
    && plan.schemaVersion === 3 && value.planSha256 === sha256(canonicalBytes(plan))
    && value.policySha256 === policySha256 && [value.policySha256, value.executionSha256, value.approvalSha256, value.nonce].every(hash)
    && exactPublicationKeys(value.preparation, ["revision", "runId", "attempt"])
    && value.preparation.revision === plan.publisher.revision && id(value.preparation.runId) && value.preparation.attempt === "1",
  "PUBLICATION_CANDIDATE_READINESS_INVALID");
  return value;
}

/** Freeze only already admitted data; callers own provider approval and the no-effect record check. */
export async function freezeCandidateReadiness({ input, output, plan, policySha256, context, authority, nonce = randomBytes(32).toString("hex") }) {
  validatePublicationPlan(plan);
  verifyPublicationAuthority(plan, sha256(canonicalBytes(plan)), authority, authority.writerPolicySha256);
  requirePublication(authority.schemaVersion === 1 && authority.runId === context.runId
    && authority.runAttempt === context.attempt && authority.revision === context.revision, "PUBLICATION_CANDIDATE_APPROVAL_INVALID");
  const execution = await publicationFile(join(input, "execution.json"), 65536);
  const ready = { schemaVersion: 1, kind: "tabgrad-release-candidate", planSha256: sha256(canonicalBytes(plan)), policySha256,
    executionSha256: sha256(execution), approvalSha256: sha256(canonicalBytes(authority)),
    preparation: { revision: context.revision, runId: context.runId, attempt: context.attempt }, nonce };
  validateCandidateReadiness(ready, plan, policySha256);
  requirePublication((await publicationFile(join(input, "plan.json"), 65536)).equals(canonicalBytes(plan)), "PUBLICATION_PLAN_IDENTITY");
  await mkdir(join(output, "input"), { mode: 0o700 });
  for (const name of inputNames) await cp(join(input, name), join(output, "input", name), { force: false, errorOnExist: true });
  await writeFile(join(output, "candidate-approval.json"), canonicalBytes(authority), { flag: "wx", mode: 0o600 });
  await writeFile(join(output, "candidate-ready.json"), canonicalBytes(ready), { flag: "wx", mode: 0o600 });
  return { ready, sha256: sha256(canonicalBytes(ready)) };
}

export function candidateTagMessage({ version, sourceRevision, readiness }) {
  requirePublication(typeof version === "string" && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)
    && revision(sourceRevision) && exactPublicationKeys(readiness, ["runId", "artifactId", "artifactSha256", "sha256"])
    && id(readiness.runId) && id(readiness.artifactId) && hash(readiness.artifactSha256) && hash(readiness.sha256),
  "PUBLICATION_TAG_MESSAGE_INVALID");
  return { schemaVersion: 1, kind: "tabgrad-release", version, sourceRevision, readiness };
}

/** Only the closed annotation is accepted; mutable commit labels cannot stand in for it. */
export function parseCandidateTagMessage(raw) {
  requirePublication(typeof raw === "string" && Buffer.byteLength(raw) <= 65536, "PUBLICATION_TAG_MESSAGE_INVALID");
  let value;
  try { value = JSON.parse(raw); } catch { requirePublication(false, "PUBLICATION_TAG_MESSAGE_INVALID"); }
  requirePublication(exactPublicationKeys(value, ["schemaVersion", "kind", "version", "sourceRevision", "readiness"])
    && value.schemaVersion === 1 && value.kind === "tabgrad-release"
    && canonicalBytes(candidateTagMessage(value)).toString() === raw, "PUBLICATION_TAG_MESSAGE_INVALID");
  return value;
}

export async function observeCandidateTag(api, tag) {
  const ref = await api.request(`/git/ref/tags/${encodeURIComponent(tag)}`);
  requirePublication(ref.ref === `refs/tags/${tag}` && ref.object?.type === "tag" && revision(ref.object.sha), "PUBLICATION_TAG_INVALID");
  const object = await api.request(`/git/tags/${ref.object.sha}`);
  requirePublication(object.sha === ref.object.sha && object.tag === tag
    && object.object?.type === "commit" && revision(object.object.sha), "PUBLICATION_TAG_INVALID");
  const message = parseCandidateTagMessage(object.message);
  requirePublication(tag === `v${message.version}` && object.object.sha === message.sourceRevision, "PUBLICATION_TAG_CONFLICT");
  return { objectSha: object.sha, message };
}

function requireRun(run, { runId, workflow, source, branch, event, policy }) {
  requirePublication(String(run?.id) === runId && run.run_attempt === 1 && run.path === workflow
    && run.head_sha === source && (branch === undefined || run.head_branch === branch) && run.event === event
    && run.status === "completed" && run.conclusion === "success"
    && String(run.repository?.id) === policy.repositoryId && String(run.head_repository?.id) === policy.repositoryId,
  "PUBLICATION_TAG_RUN_INVALID");
}

async function completedJob(api, runId, source, name) {
  const result = await api.request(`/actions/runs/${runId}/attempts/1/jobs?per_page=100`);
  requirePublication(Number.isSafeInteger(result?.total_count) && result.total_count <= 100 && Array.isArray(result.jobs)
    && result.total_count === result.jobs.length, "PUBLICATION_TAG_JOBS_INVALID");
  const jobs = result.jobs.filter(job => job.name === name);
  requirePublication(jobs.length === 1 && String(jobs[0].run_id) === runId && jobs[0].head_sha === source
    && jobs[0].status === "completed" && jobs[0].conclusion === "success", "PUBLICATION_TAG_JOBS_INVALID");
  return { job: jobs[0], jobs: result.jobs };
}

export async function observeReadinessArtifact(api, locator, plan, policy, now = Date.now()) {
  const artifact = await api.request(`/actions/artifacts/${locator.artifactId}`);
  requirePublication(String(artifact.id) === locator.artifactId && artifact.name === `tabgrad-candidate-ready-${locator.runId}-1`
    && artifact.digest === `sha256:${locator.artifactSha256}` && artifact.expired === false
    && Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 128 * 1024 * 1024
    && Date.parse(artifact.expires_at) >= Date.parse(plan.window.deadline) && now < Date.parse(artifact.expires_at)
    && String(artifact.workflow_run?.id) === locator.runId && artifact.workflow_run.head_sha === plan.publisher.revision
    && artifact.workflow_run.head_branch === "main" && String(artifact.workflow_run.repository_id) === policy.repositoryId
    && String(artifact.workflow_run.head_repository_id) === policy.repositoryId, "PUBLICATION_READINESS_ARTIFACT_INVALID");
  return artifact;
}

/** Reconstruct the original execution from the current binding, without editing its approved plan. */
export function preparationExecution(execution) {
  const { tag, ...base } = execution;
  return { ...base, schemaVersion: 1, publisher: tag.ready.preparation };
}

/** Actual pre-tag protected approval, completed jobs and nonce marker authenticate the frozen data. */
export async function observePreparedCandidate({ api, plan, planSha256, profile, ready, locator, policySha256, clock = Date.now }) {
  validateCandidateReadiness(ready, plan, policySha256);
  requirePublication(locator.sha256 === sha256(canonicalBytes(ready)) && locator.runId === ready.preparation.runId,
    "PUBLICATION_CANDIDATE_READINESS_INVALID");
  const context = { event: "workflow_dispatch", ref: "refs/heads/main", revision: ready.preparation.revision,
    runId: ready.preparation.runId, attempt: "1", repositoryId: profile.repositoryId,
    workflowRef: `${plan.publisher.repository}/${profile.workflow}@refs/heads/main` };
  const policy = { ...profile, environment: profile.originalEnvironment ?? profile.environment, recipeRevision: plan.publisher.revision };
  delete policy.tagAdmission;
  const parameters = { api, plan, planSha256, policy, context, clock, completedPreparation: true };
  await checkPublicationControl(parameters);
  const run = await api.request(`/actions/runs/${context.runId}`);
  requirePublication(policy.maintainers.some(actor => actor.id === String(run.actor?.id) && actor.ownerSha256 === plan.owner),
    "PUBLICATION_CANDIDATE_APPROVAL_INVALID");
  await completedJob(api, context.runId, context.revision, "precheck-publication");
  const { job, jobs } = await completedJob(api, context.runId, context.revision, "admit-publication");
  requirePublication(Array.isArray(job.steps) && job.steps.some(step => step.name === `Candidate ready ${locator.sha256}`
    && step.status === "completed" && step.conclusion === "success")
    && jobs.filter(value => !["precheck-publication", "admit-publication"].includes(value.name))
      .every(value => value.conclusion === "skipped"), "PUBLICATION_CANDIDATE_JOBS_INVALID");
  const authority = await observeEnvironmentApproval(parameters);
  requirePublication(sha256(canonicalBytes(authority)) === ready.approvalSha256, "PUBLICATION_CANDIDATE_APPROVAL_INVALID");
  await observeReadinessArtifact(api, locator, plan, profile, clock());
  return authority;
}

/** Authenticate the actual tag request and the main controller's correlated successful dispatch. */
export async function observeTagAuthority({ api, plan, planSha256, policy, context, policySha256, clock = Date.now }) {
  const tag = policy.tagAdmission;
  requirePublication(tag !== undefined, "PUBLICATION_TAG_EXECUTION_REQUIRED");
  const observed = await observeCandidateTag(api, plan.github.tag);
  requirePublication(observed.objectSha === tag.objectSha && observed.message.sourceRevision === plan.candidate.sourceRevision
    && observed.message.version === plan.candidate.version
    && canonicalBytes(observed.message.readiness).equals(canonicalBytes(tag.locator)), "PUBLICATION_TAG_CONFLICT");
  const request = await api.request(`/actions/runs/${tag.requestRun}`);
  requireRun(request, { runId: tag.requestRun, workflow: tagRequestWorkflow, source: plan.candidate.sourceRevision,
    event: "push", policy });
  requirePublication(request.display_title === `Release tag ${plan.github.tag}`
    && policy.maintainers.some(actor => actor.id === String(request.actor?.id) && actor.ownerSha256 === plan.owner),
    "PUBLICATION_TAG_ACTOR_INVALID");
  await completedJob(api, tag.requestRun, plan.candidate.sourceRevision, "request-tag-delivery");
  const controller = await api.request(`/actions/runs/${tag.controllerRun}`);
  requireRun(controller, { runId: tag.controllerRun, workflow: tagControllerWorkflow, source: plan.publisher.revision,
    branch: "main", event: "workflow_run", policy });
  const { job } = await completedJob(api, tag.controllerRun, plan.publisher.revision, "dispatch-tag-delivery");
  requirePublication(controller.display_title === `Tag delivery ${tag.requestRun}` && Array.isArray(job.steps)
    && job.steps.some(step => step.name === `Dispatched release ${context.runId} ${planSha256} ${tag.objectSha} ${tag.locator.sha256}`
      && step.status === "completed" && step.conclusion === "success"), "PUBLICATION_TAG_DISPATCH_INVALID");
  const original = await observePreparedCandidate({ api, plan, planSha256, profile: policy, ready: tag.ready, locator: tag.locator, policySha256, clock });
  const observation = { schemaVersion: 2, planSha256, authority: plan.authority, owner: plan.owner, window: plan.window,
    writerPolicySha256: policy.writerPolicySha256, repository: plan.publisher.repository, workflow: policy.workflow,
    revision: context.revision, runId: context.runId, runAttempt: context.attempt, approved: true,
    preparation: { runId: tag.ready.preparation.runId, readinessSha256: tag.locator.sha256,
      approvalSha256: sha256(canonicalBytes(original)), requestRun: tag.requestRun, controllerRun: tag.controllerRun, tagObjectSha: tag.objectSha } };
  verifyPublicationAuthority(plan, planSha256, observation, policy.writerPolicySha256, clock());
  return observation;
}

/** Known file identities are checked before deriving another execution from a ready artifact. */
export async function readCandidateReadiness(directory, policySha256, now = Date.now()) {
  const raw = await publicationFile(join(directory, "input/plan.json"), 65536);
  const plan = validatePublicationPlan(JSON.parse(raw), now);
  requirePublication(canonicalBytes(plan).equals(raw) && plan.schemaVersion === 3, "PUBLICATION_PLAN_IDENTITY");
  const readyRaw = await publicationFile(join(directory, "candidate-ready.json"), 65536);
  const ready = validateCandidateReadiness(JSON.parse(readyRaw), plan, policySha256);
  requirePublication(canonicalBytes(ready).equals(readyRaw), "PUBLICATION_CANDIDATE_READINESS_INVALID");
  const execution = await publicationFile(join(directory, "input/execution.json"), 65536);
  const approval = await publicationFile(join(directory, "candidate-approval.json"), 65536);
  requirePublication(sha256(execution) === ready.executionSha256 && sha256(approval) === ready.approvalSha256,
    "PUBLICATION_CANDIDATE_READINESS_INVALID");
  for (const [name, expected, limit] of [["notes.md", plan.github.notesSha256, 1024 * 1024],
    ["qualification.json", plan.qualification.evidenceSha256, 4 * 1024 * 1024],
    ...["evidence", "checksums"].map(kind => {
      const asset = plan.github.assets.find(value => value.kind === kind);
      return [kind === "evidence" ? "producer-evidence.json" : "release-checksums.txt", asset.sha256, asset.byteLength];
    })]) {
    requirePublication(sha256(await publicationFile(join(directory, "input", name), limit)) === expected,
      "PUBLICATION_CANDIDATE_INPUT_CHANGED");
  }
  return { plan, ready, sha256: sha256(readyRaw), execution: JSON.parse(execution) };
}
