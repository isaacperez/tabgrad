import { mkdir, readFile, writeFile, cp } from "node:fs/promises";
import { join } from "node:path";
import { selectReleaseInputs, composeReleaseInputs } from "../../scripts/prepare-release.mjs";
import { publicationContext, prepareReleaseCandidate } from "../../scripts/release-publication.mjs";
import { observePublicationAuthority, publicationApprovalComment, resolvePublicationExecution } from "../../scripts/publication-authority.mjs";
import { candidateTagMessage, readCandidateReadiness, tagRequestWorkflow, tagControllerWorkflow } from "../../scripts/release-readiness.mjs";
import { releasePreparationFixture } from "./release-preparation.mjs";
import { canonicalBytes, sha256 } from "../../scripts/release-record-data.mjs";
import { publicationEnvironmentSnapshot } from "../../scripts/publication-authority.mjs";

function automaticEnvironment(fixture, id, name) {
  const environment = { id, name, can_admins_bypass: true,
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }, protection_rules: [] };
  const branches = [{ id: id + 1, type: "branch", name: "main" }];
  fixture.values.set(`/environments/${name}`, environment);
  fixture.values.set(`/environments/${name}/deployment-branch-policies?per_page=100&page=1`,
    { total_count: 1, branch_policies: branches });
  return { id: String(id), name, snapshotSha256: sha256(canonicalBytes(publicationEnvironmentSnapshot(environment, branches))) };
}

/** Same real local archive/proof fixtures, with a separately enrolled synthetic tag policy. */
export async function tagPreparationFixture(t) {
  const f = await releasePreparationFixture(t);
  f.profile.schemaVersion = 3;
  f.profile.tagDelivery = { environment: automaticEnvironment(f, 81, "tabgrad-tag-publication"),
    websiteEnvironment: automaticEnvironment(f, 91, "website-tag-publication"),
    website: { configurationSha256: "7".repeat(64), originSha256: "8".repeat(64) } };
  f.environment.TABGRAD_RELEASE_PREPARE_ONLY = "true";
  f.environment.TABGRAD_RELEASE_POLICY_JSON = canonicalBytes(f.profile).toString();
  f.environment.TABGRAD_RELEASE_POLICY_SHA256 = sha256(Buffer.from(f.environment.TABGRAD_RELEASE_POLICY_JSON));
  return f;
}

async function emptyHistory(fixture, options) {
  const result = await fixture.replay(options);
  return { ...result, recordVersion: 2, checkpoint: { ...result.checkpoint, unresolvedCalls: 0 } };
}

export async function readyFixture(t) {
  const f = await tagPreparationFixture(t);
  await selectReleaseInputs(f.root, f.environment, f); await f.receive();
  const result = await composeReleaseInputs(f.root, f.environment, f);
  const plan = JSON.parse(await readFile(join(f.root, "input/plan.json")));
  const execution = JSON.parse(await readFile(join(f.root, "input/execution.json")));
  const context = publicationContext(f.environment);
  const policy = resolvePublicationExecution(f.profile, execution, plan, context, f.now);
  const state = { plan, context, policy, planSha256: result.plan_sha256, prepareOnly: true, api: f.api,
    inputDirectory: join(f.root, "input"), fresh: () => observePublicationAuthority({ api: f.api, plan, context, policy,
      planSha256: result.plan_sha256, clock: f.clock }) };
  f.values.set("/actions/runs/301/approvals", [{ state: "approved", user: { id: 11 }, environments: [{ id: 71 }],
    comment: publicationApprovalComment(plan, result.plan_sha256, context) }]);
  f.environment.TABGRAD_RECORD_INPUT = join(f.root, "initial-history");
  await mkdir(join(f.root, "public-output"));
  const frozen = await prepareReleaseCandidate(f.root, state,
    { admission: { status: "passed", planSha256: result.plan_sha256 } }, f.environment,
    { readRecord: options => emptyHistory(f, options) });
  const selected = await readCandidateReadiness(join(f.root, "public-output"), f.environment.TABGRAD_RELEASE_POLICY_SHA256, f.now);
  const locator = { runId: "301", artifactId: "901", artifactSha256: "c".repeat(64), sha256: selected.sha256 };
  const original = f.values.get("/actions/runs/301"); original.status = "completed"; original.conclusion = "success";
  const job = name => ({ name, run_id: 301, run_attempt: 1, head_sha: context.revision, status: "completed", conclusion: "success", steps: [] });
  const admit = job("admit-publication"); admit.steps.push({ name: `Candidate ready ${locator.sha256}`, status: "completed", conclusion: "success" });
  f.values.set("/actions/runs/301/attempts/1/jobs?per_page=100", { total_count: 3,
    jobs: [job("precheck-publication"), admit, { ...job("publish-npm-archive"), conclusion: "skipped" }] });
  f.values.set("/actions/artifacts/901", { id: 901, name: "tabgrad-candidate-ready-301-1", digest: `sha256:${locator.artifactSha256}`,
    expired: false, expires_at: f.profile.operationalEvidence.expiresAt, size_in_bytes: 2000,
    workflow_run: { id: 301, head_sha: context.revision, head_branch: "main", repository_id: 17, head_repository_id: 17 } });
  return { ...f, plan, execution, state, frozen, selected, locator };
}


/** Actual provider-context models; no credential or service execution. */
export async function tagControllerFixture(t) {
  const f = await readyFixture(t);
  const tagObject = "e".repeat(40);
  const message = candidateTagMessage({ version: f.plan.candidate.version, sourceRevision: f.plan.candidate.sourceRevision, readiness: f.locator });
  f.values.set(`/git/ref/tags/${f.plan.github.tag}`, { ref: `refs/tags/${f.plan.github.tag}`, object: { type: "tag", sha: tagObject } });
  f.values.set(`/git/tags/${tagObject}`, { sha: tagObject, tag: f.plan.github.tag,
    object: { type: "commit", sha: f.plan.candidate.sourceRevision }, message: canonicalBytes(message).toString() });
  const run = (id, path, head_sha, event, status = "completed") => ({ id, path, head_sha, event, run_attempt: 1,
    head_branch: "main", status, conclusion: status === "completed" ? "success" : null,
    actor: { id: 11 }, repository: { id: 17 }, head_repository: { id: 17 } });
  f.values.set("/actions/runs/501", { ...run(501, tagRequestWorkflow, f.plan.candidate.sourceRevision, "push"), display_title: `Release tag ${f.plan.github.tag}` });
  f.values.set("/actions/runs/501/attempts/1/jobs?per_page=100", { total_count: 1, jobs: [{ run_id: 501, name: "request-tag-delivery",
    head_sha: f.plan.candidate.sourceRevision, status: "completed", conclusion: "success", steps: [] }] });
  const controller = { ...run(511, tagControllerWorkflow, f.state.context.revision, "workflow_run", "in_progress"), display_title: "Tag delivery 501" };
  f.values.set("/actions/runs/511", controller);
  f.values.set(`/actions/workflows/${encodeURIComponent(tagControllerWorkflow)}/runs?event=workflow_run&head_sha=${f.state.context.revision}&per_page=100&page=1`,
    { total_count: 1, workflow_runs: [controller] });
  const eventPath = join(f.root, "event.json");
  await writeFile(eventPath, JSON.stringify({ workflow_run: { id: 501, display_title: `Release tag ${f.plan.github.tag}` } }));
  const environment = { ...f.environment, TABGRAD_TAG_DELIVERY_ENABLED: "true", TABGRAD_RELEASE_PREPARE_ONLY: "false",
    TABGRAD_RELEASE_TAG: f.plan.github.tag, TABGRAD_TAG_REQUEST_RUN: "501", TABGRAD_TAG_CONTROLLER_RUN: "511",
    GITHUB_RUN_ID: "511", GITHUB_EVENT_NAME: "workflow_run", GITHUB_EVENT_PATH: eventPath,
    GITHUB_WORKFLOW_REF: `${f.environment.GITHUB_REPOSITORY}/${tagControllerWorkflow}@refs/heads/main` };
  const directory = join(f.root, "tag-controller");
  const receive = () => cp(join(f.root, "public-output"), join(directory, "candidate-ready"), { recursive: true });
  return { ...f, environment, directory, receive, tagObject };
}
