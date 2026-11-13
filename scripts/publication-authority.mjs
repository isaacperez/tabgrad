import { isDeepStrictEqual } from "node:util";
import { canonicalBytes, sha256 } from "./release-record-data.mjs";
import { exactPublicationKeys, requirePublication, verifyPublicationAuthority } from "./publication-plan.mjs";
import { checkTrialArtifact, checkTrialJobs } from "./producer-trial.mjs";
import { observeTagAuthority, preparationExecution, validateCandidateReadiness } from "./release-readiness.mjs";

export { publicationEnvironmentSnapshot, publicationApprovalComment } from "./publication-control.mjs";
import { checkPublicationControl, requireObservationTime, observeEnvironmentApproval } from "./publication-control.mjs";

const digest = /^[0-9a-f]{64}$/;
const identifier = /^[1-9][0-9]*$/;

function validHistory(history, now) {
  return exactPublicationKeys(history, ["id", "sha256", "expiresAt", "runId", "revision", "name"])
    && identifier.test(history.id) && identifier.test(history.runId)
    && digest.test(history.sha256) && /^[0-9a-f]{40}$/.test(history.revision)
    && typeof history.name === "string" && /^[a-z0-9-]{1,128}$/.test(history.name)
    && new Date(history.expiresAt).toISOString() === history.expiresAt
    && now < Date.parse(history.expiresAt);
}

/** This digest comes from separately enrolled protected configuration, never dispatch. */
export function admitPublicationPolicy(bytes, expectedSha256, now = Date.now()) {
  requirePublication(typeof expectedSha256 === "string" && digest.test(expectedSha256)
    && bytes.length <= 65536 && sha256(bytes) === expectedSha256, "PUBLICATION_POLICY_IDENTITY");
  const policy = JSON.parse(bytes);
  const shared = ["schemaVersion", "repositoryId", "ownerId", "workflow", "writerPolicySha256", "maintainers",
    "environment", "operationalEvidence", "humanControllerSha256", "record"];
  const legacy = policy.schemaVersion === 1;
  requirePublication((legacy || [2, 3].includes(policy.schemaVersion))
    && exactPublicationKeys(policy, [...shared, ...(legacy ? ["recipeRevision", "history"] : ["clients"]),
      ...(policy.schemaVersion === 3 ? ["tagDelivery"] : [])])
    && identifier.test(policy.repositoryId) && identifier.test(policy.ownerId)
    && typeof policy.workflow === "string" && (legacy ? typeof policy.recipeRevision === "string"
      : exactPublicationKeys(policy.clients, ["npm", "controller", "provenance", "trustRoot"])
        && Object.values(policy.clients).every(value => typeof value === "string" && digest.test(value)))
    && digest.test(policy.writerPolicySha256)
    && (policy.humanControllerSha256 === null || (typeof policy.humanControllerSha256 === "string" && digest.test(policy.humanControllerSha256)))
    && Array.isArray(policy.maintainers) && policy.maintainers.length > 0
    && policy.maintainers.every(actor => exactPublicationKeys(actor, ["id", "ownerSha256"])
      && identifier.test(actor.id) && digest.test(actor.ownerSha256))
    && new Set(policy.maintainers.map(actor => actor.id)).size === policy.maintainers.length
    && exactPublicationKeys(policy.environment, ["id", "name", "snapshotSha256"])
    && identifier.test(policy.environment.id) && policy.environment.name === "tabgrad-npm-publication"
    && digest.test(policy.environment.snapshotSha256)
    && exactPublicationKeys(policy.operationalEvidence, ["sha256", "expiresAt"])
    && digest.test(policy.operationalEvidence.sha256)
    && new Date(policy.operationalEvidence.expiresAt).toISOString() === policy.operationalEvidence.expiresAt
    && now < Date.parse(policy.operationalEvidence.expiresAt)
    && exactPublicationKeys(policy.record, ["root", "location", "ref", "protocol"])
    && (!legacy || validHistory(policy.history, now)), "PUBLICATION_POLICY_INVALID");
  if (policy.schemaVersion === 3) {
    requirePublication(policy.workflow === ".github/workflows/release-publication.yml"
      && exactPublicationKeys(policy.tagDelivery, ["environment", "websiteEnvironment", "website"])
      && [policy.tagDelivery.environment, policy.tagDelivery.websiteEnvironment].every(value =>
        exactPublicationKeys(value, ["id", "name", "snapshotSha256"]) && identifier.test(value.id) && digest.test(value.snapshotSha256))
      && policy.tagDelivery.environment.name === "tabgrad-tag-publication"
      && policy.tagDelivery.websiteEnvironment.name === "website-tag-publication"
      && exactPublicationKeys(policy.tagDelivery.website, ["configurationSha256", "originSha256"])
      && Object.values(policy.tagDelivery.website).every(value => typeof value === "string" && digest.test(value)),
    "PUBLICATION_TAG_POLICY_INVALID");
  }
  return policy;
}

/** Structural resolution only; provider corroboration and protected approval are separate. */
export function resolvePublicationExecution(profile, execution, plan, context, now = Date.now(), conservation = false) {
  const tagged = execution?.schemaVersion === 2;
  requirePublication([2, 3].includes(profile.schemaVersion)
    && exactPublicationKeys(execution, ["schemaVersion", "planSha256", "publisher", "sourceChecks", "history", "recordHead", "physical", ...(tagged ? ["tag"] : [])])
    && (tagged ? profile.schemaVersion === 3 && plan.schemaVersion === 3 : execution.schemaVersion === 1)
    && execution.planSha256 === sha256(canonicalBytes(plan))
    && exactPublicationKeys(execution.publisher, ["revision", "runId", "attempt"])
    && execution.publisher.revision === context.revision && context.revision === plan.publisher.revision
    && execution.publisher.runId === context.runId && execution.publisher.attempt === context.attempt
    && context.attempt === "1" && identifier.test(context.runId)
    && context.event === "workflow_dispatch" && context.ref === "refs/heads/main"
    && context.workflowRef === `${plan.publisher.repository}/${profile.workflow}@refs/heads/main`
    && profile.repositoryId === context.repositoryId && profile.workflow === plan.publisher.workflow
    && profile.record.location === `https://github.com/${plan.publisher.repository}.git`
    && profile.maintainers.some(actor => actor.ownerSha256 === plan.owner)
    && Date.parse(plan.window.start) <= now && (conservation || now < Date.parse(plan.window.deadline))
    && /^[a-f0-9]{40}$/.test(execution.recordHead) && validHistory(execution.history, now)
    && Date.parse(plan.window.deadline) <= Date.parse(execution.history.expiresAt)
    && now < Date.parse(profile.operationalEvidence.expiresAt)
    && Date.parse(plan.window.deadline) <= Date.parse(profile.operationalEvidence.expiresAt), "PUBLICATION_EXECUTION_INVALID");
  requirePublication(["history", "observation", "completion"].some(kind =>
    execution.history.name === `tabgrad-publication-${kind}-${execution.history.runId}-1`), "PUBLICATION_HISTORY_LAYOUT");
  requirePublication(plan.publisher.clientSha256 === profile.clients.npm
    && plan.publisher.githubClientSha256 === profile.clients.controller
    && plan.producer.verification.client.sha256 === profile.clients.provenance
    && plan.producer.verification.trustRootSha256 === profile.clients.trustRoot,
  "PUBLICATION_ENROLLED_CLIENT_MISMATCH");
  const revisions = new Set([plan.candidate.sourceRevision, plan.publisher.revision]);
  requirePublication(Array.isArray(execution.sourceChecks) && execution.sourceChecks.length === revisions.size,
    "PUBLICATION_SOURCE_CHECKS_INVALID");
  for (const check of execution.sourceChecks) {
    requirePublication(exactPublicationKeys(check, ["revision", "runId", "attempt"])
      && revisions.delete(check.revision) && identifier.test(check.runId) && identifier.test(check.attempt),
    "PUBLICATION_SOURCE_CHECKS_INVALID");
  }
  requirePublication(plan.qualification.gpu ? exactPublicationKeys(execution.physical, ["issue", "commentId", "sha256"])
    && identifier.test(execution.physical.issue) && identifier.test(execution.physical.commentId)
    && digest.test(execution.physical.sha256) : execution.physical === null, "PUBLICATION_PHYSICAL_INPUT_INVALID");
  if (plan.schemaVersion === 3) requirePublication(profile.schemaVersion === 3
    && isDeepStrictEqual(plan.website, profile.tagDelivery.website), "PUBLICATION_WEBSITE_INVALID");
  if (tagged) {
    const tag = execution.tag;
    requirePublication(exactPublicationKeys(tag, ["objectSha", "locator", "ready", "requestRun", "controllerRun"])
      && /^[a-f0-9]{40}$/.test(tag.objectSha) && identifier.test(tag.requestRun) && identifier.test(tag.controllerRun)
      && exactPublicationKeys(tag.locator, ["runId", "artifactId", "artifactSha256", "sha256"])
      && [tag.locator.runId, tag.locator.artifactId].every(value => typeof value === "string" && identifier.test(value))
      && [tag.locator.artifactSha256, tag.locator.sha256].every(value => typeof value === "string" && digest.test(value)),
    "PUBLICATION_TAG_EXECUTION_INVALID");
    validateCandidateReadiness(tag.ready, plan, tag.ready.policySha256);
    requirePublication(sha256(canonicalBytes(tag.ready)) === tag.locator.sha256
      && tag.locator.runId === tag.ready.preparation.runId
      && sha256(canonicalBytes(preparationExecution(execution))) === tag.ready.executionSha256,
    "PUBLICATION_TAG_EXECUTION_INVALID");
    return { ...profile, recipeRevision: plan.publisher.revision, history: execution.history,
      originalEnvironment: profile.originalEnvironment ?? profile.environment,
      environment: profile.tagDelivery.environment, tagAdmission: tag };
  }
  return { ...profile, recipeRevision: plan.publisher.revision, history: execution.history };
}

/** Authenticated facts cannot approve a plan or replace the enrolled protection baseline. */
export async function corroboratePublicationExecution({ api, policy, execution, plan, context,
  initial = false, conservation = false, clock = Date.now }) {
  // Re-resolve at the decision boundary, including after every asynchronous read.
  const fresh = () => resolvePublicationExecution(policy, execution, plan, context, clock(), conservation);
  fresh();
  if (conservation) return { status: "conservation-only", epoch: policy.schemaVersion };
  for (const check of execution.sourceChecks) {
    const run = await api.request(`/actions/runs/${check.runId}`);
    fresh();
    requirePublication(String(run.id) === check.runId && String(run.run_attempt) === check.attempt
      && run.head_sha === check.revision && run.head_branch === "main" && run.event === "push"
      && run.path === ".github/workflows/repository-checks.yml" && run.status === "completed" && run.conclusion === "success"
      && String(run.repository?.id) === policy.repositoryId && String(run.head_repository?.id) === policy.repositoryId,
    "PUBLICATION_SOURCE_CHECKS_INVALID");
    const jobs = await api.request(`/actions/runs/${check.runId}/attempts/${check.attempt}/jobs?per_page=100`);
    fresh();
    requirePublication(Array.isArray(jobs.jobs) && jobs.total_count === jobs.jobs.length && jobs.total_count === 5
      && ["repository-consistency", "runtime", "browser-Chrome", "browser-Firefox", "publication-client"].every(name =>
        jobs.jobs.filter(job => job.name === name && String(job.run_id) === check.runId
          && String(job.run_attempt) === check.attempt && job.head_sha === check.revision && job.status === "completed"
          && (job.conclusion === "success" || (name === "publication-client" && job.conclusion === "skipped"))).length === 1),
    "PUBLICATION_SOURCE_CHECKS_INVALID");
  }
  if (execution.physical !== null) {
    const comment = await api.request(`/issues/comments/${execution.physical.commentId}`);
    fresh();
    const prefix = `tabgrad-release-qualification ${plan.producer.verification.identity.runId}/1 ${plan.candidate.inventorySha256}\n`;
    requirePublication(String(comment.id) === execution.physical.commentId && typeof comment.body === "string"
      && comment.body.startsWith(prefix) && sha256(Buffer.from(comment.body)) === execution.physical.sha256
      && policy.maintainers.some(actor => actor.id === String(comment.user?.id) && actor.ownerSha256 === plan.owner)
      && comment.issue_url === `https://api.github.com/repos/${plan.publisher.repository}/issues/${execution.physical.issue}`,
    "PUBLICATION_PHYSICAL_INPUT_INVALID");
  }
  if (initial) {
    const record = await api.request(`/git/ref/${policy.record.ref.slice(5)}`);
    fresh();
    requirePublication(record.ref === policy.record.ref && record.object?.type === "commit"
      && record.object.sha === execution.recordHead, "PUBLICATION_HISTORY_HEAD_CHANGED");
  }
  return { status: "corroborated-unapproved", epoch: policy.schemaVersion };
}

/** Read-only preparation checks the enrolled baseline before any protected job exists. */
export async function observePublicationPreparation({ api, profile, context, window, repository, clock = Date.now }) {
  requirePublication([2, 3].includes(profile.schemaVersion) && profile.record.location === `https://github.com/${repository}.git`
    && context.repositoryId === profile.repositoryId, "PUBLICATION_PREPARATION_CONTEXT");
  const plan = { publisher: { repository, workflow: profile.workflow, revision: context.revision }, window };
  await checkPublicationControl({ api, plan, policy: { ...profile, recipeRevision: context.revision }, context,
    activeJobName: "precheck-publication", clock });
  const head = await api.request("/git/ref/heads/main");
  requirePublication(head.ref === "refs/heads/main" && head.object?.type === "commit" && head.object.sha === context.revision,
    "PUBLICATION_MAIN_MOVED");
  requireObservationTime({ plan, policy: profile, clock });
  return { status: "unapproved-preparation" };
}

/** Runs before naming the environment in a job; missing protection cannot auto-create it. */
export async function observePublicationPrecheck(parameters) {
  await checkPublicationControl(parameters);
  const { policy, plan } = parameters;
  const artifact = await parameters.api.request(`/actions/artifacts/${policy.history.id}`);
  requirePublication(String(artifact.id) === policy.history.id && artifact.digest === `sha256:${policy.history.sha256}`
    && artifact.name === policy.history.name && artifact.expired === false && artifact.size_in_bytes > 0
    && artifact.size_in_bytes <= 128 * 1024 * 1024 && String(artifact.workflow_run?.id) === policy.history.runId
    && String(artifact.workflow_run.repository_id) === policy.repositoryId
    && String(artifact.workflow_run.head_repository_id) === policy.repositoryId
    && artifact.workflow_run.head_sha === policy.history.revision
    && new Date(artifact.expires_at).toISOString() === policy.history.expiresAt
    && Date.parse(plan.window.deadline) <= Date.parse(policy.history.expiresAt), "PUBLICATION_HISTORY_HANDOFF_INVALID");
  requireObservationTime(parameters);
  return { schemaVersion: 1, status: "unapproved-precheck" };
}

/** Existing-call facts only; this result cannot authorize a new distribution effect. */
export async function observePublicationConservation(parameters) {
  await checkPublicationControl(parameters, true);
  return { schemaVersion: 1, status: "conservation-only" };
}

export async function observePublicationAuthority(parameters) {
  await checkPublicationControl(parameters);
  if (parameters.policy.tagAdmission) return observeTagAuthority(parameters);
  return observeEnvironmentApproval(parameters);
}

export async function observePublicationProducer(api, plan) {
  const identity = plan.producer.verification.identity;
  requirePublication(identity.workflowPath === ".github/workflows/producer-trial.yml" && identity.runAttempt === "1",
    "PUBLICATION_PRODUCER_PROFILE");
  const context = { identity, expiresAt: plan.window.deadline };
  const run = await api.request(`/actions/runs/${identity.runId}`);
  const jobs = await api.request(`/actions/runs/${identity.runId}/attempts/${identity.runAttempt}/jobs?per_page=100`);
  checkTrialJobs(run, jobs, context);
  requirePublication(run.status === "completed" && run.conclusion === "success" && jobs.total_count <= 100
    && jobs.jobs.filter(job => job.name === "verify-retained-proofs" && job.status === "completed"
      && job.conclusion === "success" && String(job.run_id) === identity.runId
      && job.head_sha === identity.sourceRevision).length === 1, "PUBLICATION_PRODUCER_NOT_COMPLETE");
  for (const kind of ["data", "proofs", "corroboration"]) {
    const expected = plan.producer[kind];
    const artifact = await api.request(`/actions/artifacts/${expected.id}`);
    checkTrialArtifact(artifact, context, kind === "corroboration" ? "verification" : kind, expected.id, expected.sha256);
    requirePublication(new Date(artifact.expires_at).toISOString() === expected.expiresAt,
      "PUBLICATION_ARTIFACT_EXPIRY_CHANGED");
  }
  return { run, jobs };
}

export function requireEnrolledRecord(config, policy) {
  requirePublication(isDeepStrictEqual(Object.fromEntries(Object.keys(policy.record).map(key => [key, config[key]])), policy.record)
    && config.writerPolicy === policy.writerPolicySha256, "PUBLICATION_RECORD_LOCATION");
}
