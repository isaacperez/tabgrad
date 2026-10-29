import assert from "node:assert/strict";
import test from "node:test";
import { publicationPlanFixture } from "../../fixtures/publication.mjs";
import { canonicalBytes, sha256 } from "../../../scripts/release-record-data.mjs";
import { admitPublicationPolicy, observePublicationAuthority, observePublicationPrecheck, observePublicationProducer,
  publicationApprovalComment, publicationEnvironmentSnapshot } from "../../../scripts/publication-authority.mjs";

/** Provider-policy model; actual HTTP/client and live-service qualification are distinct. */
function fixture() {
  const f = publicationPlanFixture(), plan = f.publicationPlan;
  const context = { event: "workflow_dispatch", ref: "refs/heads/main", revision: plan.publisher.revision,
    workflowRef: `${plan.publisher.repository}/${plan.publisher.workflow}@refs/heads/main`, runId: "301", attempt: "1" };
  const environment = { id: 71, name: "tabgrad-npm-publication", can_admins_bypass: false,
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    protection_rules: [{ id: 72, type: "required_reviewers", prevent_self_review: false,
      reviewers: [{ type: "User", reviewer: { id: 11 } }] }] };
  const branches = [{ id: 73, type: "branch", name: "main" }];
  const policy = { schemaVersion: 1, repositoryId: "17", ownerId: "23", workflow: plan.publisher.workflow,
    recipeRevision: plan.publisher.revision, writerPolicySha256: "c".repeat(64),
    maintainers: [{ id: "11", ownerSha256: plan.owner }], humanControllerSha256: "d".repeat(64),
    environment: { id: "71", name: environment.name, snapshotSha256: sha256(canonicalBytes(publicationEnvironmentSnapshot(environment, branches))) },
    operationalEvidence: { sha256: "e".repeat(64), expiresAt: plan.producer.verification.expiresAt },
    record: { root: "f".repeat(40), location: `https://github.com/${plan.publisher.repository}.git`, protocol: "https", ref: "refs/heads/release-control" },
    history: { id: "201", sha256: "f".repeat(64), expiresAt: plan.producer.verification.expiresAt,
      runId: "200", revision: "a".repeat(40), name: "tabgrad-enrolled-history" } };
  const values = new Map([
    ["/actions/artifacts/201", { id: 201, name: policy.history.name, digest: `sha256:${policy.history.sha256}`,
      expired: false, size_in_bytes: 100, expires_at: policy.history.expiresAt,
      workflow_run: { id: 200, repository_id: 17, head_repository_id: 17, head_sha: policy.history.revision } }],
    ["", { id: 17, owner: { id: 23 }, full_name: plan.publisher.repository, default_branch: "main", archived: false, disabled: false }],
    ["/actions/runs/301", { id: 301, run_attempt: 1, event: context.event, head_sha: context.revision, head_branch: "main",
      path: plan.publisher.workflow, status: "in_progress", conclusion: null, repository: { id: 17 }, head_repository: { id: 17 } }],
    [`/environments/${environment.name}`, environment],
    [`/environments/${environment.name}/deployment-branch-policies?per_page=100&page=1`, { total_count: 1, branch_policies: branches }],
    ["/actions/runs/301/approvals", [{ state: "approved", comment: publicationApprovalComment(plan, f.planSha256, context),
      user: { id: 11 }, environments: [{ id: 71 }] }]],
  ]);
  const requests = [];
  const api = { request: async route => { requests.push(route); assert.ok(values.has(route), route); return structuredClone(values.get(route)); } };
  return { ...f, plan, policy, context, values, requests, api };
}

test("provider model: precheck never produces an approved observation", async () => {
  const f = fixture();
  assert.deepEqual(await observePublicationPrecheck(f), { schemaVersion: 1, status: "unapproved-precheck" });
  assert.equal(f.requests.includes("/actions/runs/301/approvals"), false);
  const authority = await observePublicationAuthority(f);
  assert.equal(authority.approved, true); assert.equal(authority.planSha256, f.planSha256);
});

test("enrolled policy bytes have an external digest, complete schema and finite qualification", () => {
  const f = fixture(), raw = canonicalBytes(f.policy);
  assert.deepEqual(admitPublicationPolicy(raw, sha256(raw), f.now), f.policy);
  assert.throws(() => admitPublicationPolicy(raw, "0".repeat(64), f.now), { code: "PUBLICATION_POLICY_IDENTITY" });
  for (const change of [p => { p.approved = true; }, p => { p.operationalEvidence.expiresAt = f.plan.window.start; },
    p => { p.maintainers.push(p.maintainers[0]); }]) {
    const p = structuredClone(f.policy); change(p); const bytes = canonicalBytes(p);
    assert.throws(() => admitPublicationPolicy(bytes, sha256(bytes), f.now));
  }
});

for (const [name, route, change] of [
  ["foreign repository", "", r => { r.id = 18; }],
  ["changed owner", "", r => { r.owner.id = 24; }],
  ["rerun", "/actions/runs/301", r => { r.run_attempt = 2; }],
  ["other workflow", "/actions/runs/301", r => { r.path = ".github/workflows/other.yml"; }],
  ["supplied source cannot replace recipe", "/actions/runs/301", r => { r.head_sha = "a".repeat(40); }],
  ["canceled execution", "/actions/runs/301", r => { r.status = "completed"; r.conclusion = "cancelled"; }],
  ["missing bypass observation", "/environments/tabgrad-npm-publication", r => { delete r.can_admins_bypass; }],
  ["administrator bypass", "/environments/tabgrad-npm-publication", r => { r.can_admins_bypass = true; }],
  ["missing required review", "/environments/tabgrad-npm-publication", r => { r.protection_rules = []; }],
  ["new unadmitted reviewer", "/environments/tabgrad-npm-publication", r => { r.protection_rules[0].reviewers[0].reviewer.id = 12; }],
  ["wildcard branch", "/environments/tabgrad-npm-publication/deployment-branch-policies?per_page=100&page=1", r => { r.branch_policies[0].name = "*"; }],
  ["wrong reviewing actor", "/actions/runs/301/approvals", r => { r[0].user.id = 12; }],
  ["another waiting execution's approval", "/actions/runs/301/approvals", r => { r[0].comment = r[0].comment.replace("301/1", "300/1"); }],
  ["rejected review", "/actions/runs/301/approvals", r => { r[0].state = "rejected"; }],
]) test(`provider model rejects ${name}`, async () => {
  const f = fixture(); change(f.values.get(route));
  await assert.rejects(observePublicationAuthority(f));
});

test("a matching self-supplied approved sidecar cannot replace the actual review query", async () => {
  const f = fixture(); f.values.set("/actions/runs/301/approvals", []);
  await assert.rejects(observePublicationAuthority({ ...f, observation: f.authority }), { code: "PUBLICATION_ENVIRONMENT_REVIEW_INVALID" });
});

test("expired window fails before consulting provider or renewing authority", async () => {
  const f = fixture();
  await assert.rejects(observePublicationAuthority({ ...f, now: Date.parse(f.plan.window.deadline) }), { code: "PUBLICATION_CONTEXT_INVALID" });
  assert.equal(f.requests.length, 0);
});

test("producer model requires a completed successful run, verification job and both exact outputs", async () => {
  const f = fixture(), p = f.plan;
  p.producer.verification.identity.workflowPath = ".github/workflows/producer-trial.yml";
  p.producer.verification.identity.runAttempt = "1";
  const i = p.producer.verification.identity;
  const run = { id: Number(i.runId), run_attempt: 1, head_sha: i.sourceRevision, head_branch: "main", event: "workflow_dispatch",
    path: i.workflowPath, status: "completed", conclusion: "success", repository: { id: 17, owner: { id: 23 } } };
  const jobs = { total_count: 3, jobs: ["prepare-and-qualify", "sign-qualified-candidate", "verify-retained-proofs"]
    .map(name => ({ name, run_id: Number(i.runId), head_sha: i.sourceRevision, status: "completed", conclusion: "success" })) };
  f.values.set(`/actions/runs/${i.runId}`, run);
  f.values.set(`/actions/runs/${i.runId}/attempts/1/jobs?per_page=100`, jobs);
  for (const kind of ["data", "proofs", "corroboration"]) {
    const out = p.producer[kind];
    f.values.set(`/actions/artifacts/${out.id}`, { id: Number(out.id), digest: `sha256:${out.sha256}`,
      name: `tabgrad-producer-${kind === "corroboration" ? "verification" : kind}-${i.runId}-1`, expired: false, size_in_bytes: 100,
      expires_at: out.expiresAt, workflow_run: { id: Number(i.runId), repository_id: 17, head_repository_id: 17,
        head_sha: i.sourceRevision, head_branch: "main" } });
  }
  await observePublicationProducer(f.api, p);
  for (const change of [() => { f.values.get(`/actions/runs/${i.runId}`).conclusion = "failure"; },
    () => { f.values.get(`/actions/runs/${i.runId}/attempts/1/jobs?per_page=100`).jobs[2].conclusion = "failure"; },
    () => { f.values.get(`/actions/artifacts/${p.producer.proofs.id}`).digest = `sha256:${"f".repeat(64)}`; }]) {
    const saved = structuredClone([...f.values]); change();
    await assert.rejects(observePublicationProducer(f.api, p));
    f.values.clear(); for (const [route, value] of saved) f.values.set(route, value);
  }
});
