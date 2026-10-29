import { isDeepStrictEqual } from "node:util";
import { canonicalBytes, sha256 } from "./release-record-data.mjs";
import { exactPublicationKeys, requirePublication, verifyPublicationAuthority } from "./publication-plan.mjs";
import { checkTrialArtifact, checkTrialJobs } from "./producer-trial.mjs";

const digest = /^[0-9a-f]{64}$/;
const identifier = /^[1-9][0-9]*$/;

/** This digest comes from separately enrolled protected configuration, never dispatch. */
export function admitPublicationPolicy(bytes, expectedSha256, now = Date.now()) {
  requirePublication(typeof expectedSha256 === "string" && digest.test(expectedSha256)
    && bytes.length <= 65536 && sha256(bytes) === expectedSha256, "PUBLICATION_POLICY_IDENTITY");
  const policy = JSON.parse(bytes);
  requirePublication(exactPublicationKeys(policy, ["schemaVersion", "repositoryId", "ownerId", "workflow", "recipeRevision",
    "writerPolicySha256", "maintainers", "environment", "operationalEvidence", "humanControllerSha256", "record", "history"])
    && policy.schemaVersion === 1 && identifier.test(policy.repositoryId) && identifier.test(policy.ownerId)
    && typeof policy.workflow === "string" && typeof policy.recipeRevision === "string"
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
    && exactPublicationKeys(policy.history, ["id", "sha256", "expiresAt", "runId", "revision", "name"])
    && identifier.test(policy.history.id) && identifier.test(policy.history.runId)
    && digest.test(policy.history.sha256) && /^[0-9a-f]{40}$/.test(policy.history.revision)
    && typeof policy.history.name === "string" && /^[a-z0-9-]{1,128}$/.test(policy.history.name)
    && new Date(policy.history.expiresAt).toISOString() === policy.history.expiresAt
    && now < Date.parse(policy.history.expiresAt), "PUBLICATION_POLICY_INVALID");
  return policy;
}

/** Stable relevant projection, rather than volatile URLs/timestamps from the API. */
export function publicationEnvironmentSnapshot(value, branches) {
  return { id: value.id, name: value.name, can_admins_bypass: value.can_admins_bypass,
    deployment_branch_policy: value.deployment_branch_policy, protection_rules: value.protection_rules,
    branches };
}

/**
 * Authenticated GitHub observations bind the enrolled controller, live dispatch,
 * explicit plan approval in this run's actual environment review. No matching
 * caller-supplied approved=true document can replace these queries.
 */
export function publicationApprovalComment(plan, planSha256, context) {
  return `tabgrad-release-approve ${planSha256} ${plan.operation} ${context.runId}/${context.attempt}`;
}

async function checkPublicationControl({ api, plan, policy, context, now = Date.now() }, conservation = false) {
  requirePublication(context.event === "workflow_dispatch" && context.ref === "refs/heads/main"
    && context.attempt === "1" && identifier.test(context.runId)
    && context.workflowRef === `${plan.publisher.repository}/${policy.workflow}@refs/heads/main`
    && context.revision === plan.publisher.revision && policy.recipeRevision === plan.publisher.revision
    && policy.workflow === plan.publisher.workflow
    && (conservation || (Date.parse(plan.window.start) <= now && now < Date.parse(plan.window.deadline)))
    && now < Date.parse(policy.operationalEvidence.expiresAt), "PUBLICATION_CONTEXT_INVALID");
  const repo = await api.request("");
  requirePublication(String(repo.id) === policy.repositoryId && String(repo.owner?.id) === policy.ownerId
    && repo.full_name === plan.publisher.repository && repo.default_branch === "main"
    && repo.archived === false && repo.disabled === false,
  "PUBLICATION_REPOSITORY_INVALID");
  const run = await api.request(`/actions/runs/${context.runId}`);
  requirePublication(String(run.id) === context.runId && run.run_attempt === 1 && run.event === context.event
    && run.head_sha === context.revision && run.head_branch === "main" && run.path === policy.workflow
    && run.status === "in_progress" && run.conclusion === null
    && String(run.repository?.id) === policy.repositoryId && String(run.head_repository?.id) === policy.repositoryId,
  "PUBLICATION_RUN_INVALID");
  const environment = await api.request(`/environments/${policy.environment.name}`);
  const branchResult = await api.request(`/environments/${policy.environment.name}/deployment-branch-policies?per_page=100&page=1`);
  const branches = branchResult.branch_policies;
  requirePublication(String(environment.id) === policy.environment.id && environment.name === policy.environment.name
    && environment.can_admins_bypass === false
    && environment.deployment_branch_policy?.custom_branch_policies === true
    && environment.deployment_branch_policy?.protected_branches === false
    && branchResult.total_count === 1 && Array.isArray(branches) && branches.length === 1
    && branches[0].name === "main" && branches[0].type === "branch"
    && environment.protection_rules?.some(rule => rule.type === "required_reviewers"
      && rule.reviewers?.length > 0 && rule.reviewers.every(reviewer => reviewer.type === "User"
        && policy.maintainers.some(actor => actor.id === String(reviewer.reviewer?.id))))
    && sha256(canonicalBytes(publicationEnvironmentSnapshot(environment, branches))) === policy.environment.snapshotSha256,
  "PUBLICATION_PROTECTION_INVALID");
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
  return { schemaVersion: 1, status: "unapproved-precheck" };
}

/** Existing-call facts only; this result cannot authorize a new distribution effect. */
export async function observePublicationConservation(parameters) {
  await checkPublicationControl(parameters, true);
  return { schemaVersion: 1, status: "conservation-only" };
}

export async function observePublicationAuthority(parameters) {
  const { api, plan, planSha256, policy, context, now = Date.now() } = parameters;
  await checkPublicationControl(parameters);
  const reviews = await api.request(`/actions/runs/${context.runId}/approvals`);
  requirePublication(Array.isArray(reviews) && reviews.some(review => review.state === "approved"
      && policy.maintainers.some(actor => actor.id === String(review.user?.id) && actor.ownerSha256 === plan.owner)
      && review.comment === publicationApprovalComment(plan, planSha256, context)
      && review.environments?.some(value => String(value.id) === policy.environment.id))
      && !reviews.some(review => review.state === "rejected"
        && review.environments?.some(value => String(value.id) === policy.environment.id)), "PUBLICATION_ENVIRONMENT_REVIEW_INVALID");
  const observation = { schemaVersion: 1, planSha256, authority: plan.authority, owner: plan.owner,
    window: plan.window, writerPolicySha256: policy.writerPolicySha256, repository: plan.publisher.repository,
    workflow: policy.workflow, revision: context.revision, runId: context.runId, runAttempt: context.attempt, approved: true };
  verifyPublicationAuthority(plan, planSha256, observation, policy.writerPolicySha256, now);
  return observation;
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
