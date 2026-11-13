import { canonicalBytes, sha256 } from "./release-record-data.mjs";
import { requirePublication, verifyPublicationAuthority } from "./publication-plan.mjs";

const identifier = /^[1-9][0-9]*$/;

/** Stable relevant projection, rather than volatile URLs/timestamps from the API. */
export function publicationEnvironmentSnapshot(value, branches) {
  return { id: value.id, name: value.name, can_admins_bypass: value.can_admins_bypass,
    deployment_branch_policy: value.deployment_branch_policy, protection_rules: value.protection_rules,
    branches };
}

export function publicationApprovalComment(plan, planSha256, context) {
  return `tabgrad-release-approve ${planSha256} ${plan.operation} ${context.runId}/${context.attempt}`;
}

/** Read again at the decision boundary; an earlier asynchronous read is not a clock. */
export function requireObservationTime(parameters, conservation = false) {
  const { plan, policy } = parameters;
  const now = parameters.clock ? parameters.clock() : parameters.now ?? Date.now();
  requirePublication(Number.isFinite(now)
    && (conservation || (Date.parse(plan.window.start) <= now && now < Date.parse(plan.window.deadline)))
    && now < Date.parse(policy.operationalEvidence.expiresAt), "PUBLICATION_CONTEXT_INVALID");
  return now;
}

/** Aggregate queued metadata is insufficient; the selected current role must be active. */
async function requireActivePublicationRun(run, { api, context, activeJobName }) {
  if (run.status === "in_progress") return;
  requirePublication(run.status === "queued" && typeof activeJobName === "string" && activeJobName.length > 0,
    "PUBLICATION_RUN_INVALID");
  const result = await api.request(`/actions/runs/${context.runId}/attempts/${context.attempt}/jobs?per_page=100`);
  requirePublication(Number.isSafeInteger(result?.total_count) && result.total_count >= 0 && result.total_count <= 100
    && Array.isArray(result.jobs) && result.jobs.length === result.total_count, "PUBLICATION_RUN_INVALID");
  const matches = result.jobs.filter(job => job?.name === activeJobName);
  requirePublication(matches.length === 1, "PUBLICATION_RUN_INVALID");
  const job = matches[0];
  requirePublication(Number.isSafeInteger(job.id) && job.id > 0 && String(job.run_id) === context.runId
    && job.run_attempt === Number(context.attempt) && job.head_sha === context.revision
    && job.status === "in_progress" && job.conclusion === null, "PUBLICATION_RUN_INVALID");
}

export async function checkPublicationControl(parameters, conservation = false) {
  const { api, plan, policy, context } = parameters;
  requirePublication(context.event === "workflow_dispatch" && context.ref === "refs/heads/main"
    && context.attempt === "1" && identifier.test(context.runId)
    && context.workflowRef === `${plan.publisher.repository}/${policy.workflow}@refs/heads/main`
    && context.revision === plan.publisher.revision && policy.recipeRevision === plan.publisher.revision
    && policy.workflow === plan.publisher.workflow, "PUBLICATION_CONTEXT_INVALID");
  requireObservationTime(parameters, conservation);
  const repo = await api.request("");
  requirePublication(String(repo.id) === policy.repositoryId && String(repo.owner?.id) === policy.ownerId
    && repo.full_name === plan.publisher.repository && repo.default_branch === "main"
    && repo.archived === false && repo.disabled === false,
  "PUBLICATION_REPOSITORY_INVALID");
  const run = await api.request(`/actions/runs/${context.runId}`);
  requirePublication(String(run.id) === context.runId && run.run_attempt === 1 && run.event === context.event
    && run.head_sha === context.revision && run.head_branch === "main" && run.path === policy.workflow
    && (parameters.completedPreparation ? run.status === "completed" && run.conclusion === "success" : run.conclusion === null)
    && String(run.repository?.id) === policy.repositoryId && String(run.head_repository?.id) === policy.repositoryId,
  "PUBLICATION_RUN_INVALID");
  if (!parameters.completedPreparation) await requireActivePublicationRun(run, parameters);
  requireObservationTime(parameters, conservation);
  await checkPublicationEnvironment(parameters, conservation);
}

/** The same provider review is used in its original run and when admitting its frozen readiness. */
export async function observeEnvironmentApproval(parameters) {
  const { api, plan, planSha256, policy, context } = parameters;
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
  verifyPublicationAuthority(plan, planSha256, observation, policy.writerPolicySha256, requireObservationTime(parameters));
  return observation;
}

/** Shared live environment projection; the selected profile decides whether approval is manual. */
export async function checkPublicationEnvironment(parameters, conservation = false) {
  const { api, policy } = parameters;
  const environment = await api.request(`/environments/${policy.environment.name}`);
  const branchResult = await api.request(`/environments/${policy.environment.name}/deployment-branch-policies?per_page=100&page=1`);
  const branches = branchResult.branch_policies;
  requirePublication(String(environment.id) === policy.environment.id && environment.name === policy.environment.name
    && (policy.tagAdmission ? typeof environment.can_admins_bypass === "boolean" : environment.can_admins_bypass === false)
    && environment.deployment_branch_policy?.custom_branch_policies === true
    && environment.deployment_branch_policy?.protected_branches === false
    && branchResult.total_count === 1 && Array.isArray(branches) && branches.length === 1
    && branches[0].name === "main" && branches[0].type === "branch"
    && (policy.tagAdmission ? Array.isArray(environment.protection_rules) && environment.protection_rules.length === 0
      : environment.protection_rules?.some(rule => rule.type === "required_reviewers"
      && rule.reviewers?.length > 0 && rule.reviewers.every(reviewer => reviewer.type === "User"
        && policy.maintainers.some(actor => actor.id === String(reviewer.reviewer?.id)))))
    && sha256(canonicalBytes(publicationEnvironmentSnapshot(environment, branches))) === policy.environment.snapshotSha256,
  "PUBLICATION_PROTECTION_INVALID");
  requireObservationTime(parameters, conservation);
}
