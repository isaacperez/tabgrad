import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { publicationPlanFixture } from "../../fixtures/publication.mjs";
import { canonicalBytes, sha256 } from "../../../scripts/release-record-data.mjs";
import { admitPublicationPolicy, observePublicationAuthority, observePublicationPrecheck, observePublicationProducer,
  observePublicationConservation, publicationApprovalComment, publicationEnvironmentSnapshot } from "../../../scripts/publication-authority.mjs";
import { resolvePublicationExecution, corroboratePublicationExecution } from "../../../scripts/publication-authority.mjs";
import { publicationRole } from "../../../scripts/release-publication.mjs";

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

function queuedRole(f, name = "admit-publication") {
  f.activeJobName = name;
  f.values.get("/actions/runs/301").status = "queued";
  const job = { id: 91, run_id: 301, run_attempt: 1, head_sha: f.context.revision,
    name, status: "in_progress", conclusion: null };
  const jobs = { total_count: 1, jobs: [job] };
  f.values.set("/actions/runs/301/attempts/1/jobs?per_page=100", jobs);
  return { job, jobs };
}

function stableFixture() {
  const f = fixture();
  f.context.repositoryId = f.policy.repositoryId;
  f.policy.history.name = `tabgrad-publication-completion-${f.policy.history.runId}-1`;
  f.values.get("/actions/artifacts/201").name = f.policy.history.name;
  f.profile = { ...f.policy, schemaVersion: 2, clients: {
    npm: f.plan.publisher.clientSha256, controller: f.plan.publisher.githubClientSha256,
    provenance: f.plan.producer.verification.client.sha256, trustRoot: f.plan.producer.verification.trustRootSha256 } };
  delete f.profile.recipeRevision; delete f.profile.history;
  f.execution = { schemaVersion: 1, planSha256: sha256(canonicalBytes(f.plan)),
    publisher: { revision: f.context.revision, runId: f.context.runId, attempt: "1" },
    sourceChecks: [...new Set([f.plan.candidate.sourceRevision, f.plan.publisher.revision])]
      .map((revision, index) => ({ revision, runId: String(401 + index), attempt: "1" })),
    history: f.policy.history, recordHead: "a".repeat(40), physical: null };
  assert.equal(f.plan.qualification.gpu, false);
  for (const check of f.execution.sourceChecks) {
    f.values.set(`/actions/runs/${check.runId}`, { id: Number(check.runId), run_attempt: 1, head_sha: check.revision,
      head_branch: "main", event: "push", path: ".github/workflows/repository-checks.yml", status: "completed",
      conclusion: "success", repository: { id: 17 }, head_repository: { id: 17 } });
    f.values.set(`/actions/runs/${check.runId}/attempts/1/jobs?per_page=100`, { total_count: 5,
      jobs: ["repository-consistency", "runtime", "browser-Chrome", "browser-Firefox", "publication-client"].map(name => ({
        name, run_id: Number(check.runId), run_attempt: 1, head_sha: check.revision, status: "completed", conclusion: "success" })) });
  }
  f.values.set(`/git/ref/${f.policy.record.ref.slice(5)}`, { ref: f.policy.record.ref,
    object: { type: "commit", sha: f.execution.recordHead } });
  return f;
}

test("stable trust is independently enrolled and resolution remains unapproved until the actual protected review", async () => {
  const f = stableFixture(), raw = canonicalBytes(f.profile);
  const profile = admitPublicationPolicy(raw, sha256(raw), f.now);
  const policy = resolvePublicationExecution(profile, f.execution, f.plan, f.context, f.now);
  assert.equal(policy.schemaVersion, 2); assert.equal(policy.recipeRevision, f.plan.publisher.revision);
  assert.deepEqual(policy.history, f.execution.history);
  assert.equal(Object.hasOwn(policy, "approved"), false);
  assert.deepEqual(await corroboratePublicationExecution({ ...f, policy, initial: true }),
    { status: "corroborated-unapproved", epoch: 2 });
  await observePublicationPrecheck({ ...f, policy });
  assert.equal(f.requests.includes("/actions/runs/301/approvals"), false);
  f.values.set("/actions/runs/301/approvals", []);
  await assert.rejects(observePublicationAuthority({ ...f, policy }), { code: "PUBLICATION_ENVIRONMENT_REVIEW_INVALID" });
});

test("schema epochs are closed and cannot silently upgrade missing v1 pins", () => {
  const f = stableFixture();
  for (const change of [p => { p.history = f.execution.history; }, p => { p.recipeRevision = f.context.revision; },
    p => { p.approved = true; }, p => { p.schemaVersion = 3; }, p => { delete p.clients.trustRoot; }]) {
    const p = structuredClone(f.profile); change(p); const raw = canonicalBytes(p);
    assert.throws(() => admitPublicationPolicy(raw, sha256(raw), f.now), { code: "PUBLICATION_POLICY_INVALID" });
  }
  const legacy = { ...f.profile, schemaVersion: 1 }; delete legacy.clients;
  assert.throws(() => admitPublicationPolicy(canonicalBytes(legacy), sha256(canonicalBytes(legacy)), f.now));
  const raw = canonicalBytes(f.profile);
  assert.throws(() => admitPublicationPolicy(raw, "0".repeat(64), f.now), { code: "PUBLICATION_POLICY_IDENTITY" });
});

test("closed-plan role cannot silently treat a stable profile as its missing execution controller", async t => {
  const f = stableFixture(), root = await mkdtemp(join(tmpdir(), "tabgrad-stable-entry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  f.plan.publisher.githubClientSha256 = sha256(await readFile(process.execPath));
  f.profile.clients.controller = f.plan.publisher.githubClientSha256;
  const raw = canonicalBytes(f.profile);
  await assert.rejects(publicationRole("precheck", root, {
    TABGRAD_PUBLICATION_ENABLED: "true", TABGRAD_PUBLICATION_CONFIRMATION: "release-publication",
    TABGRAD_PUBLICATION_PLAN_JSON: canonicalBytes(f.plan).toString(),
    TABGRAD_PUBLICATION_PLAN_SHA256: sha256(canonicalBytes(f.plan)),
    GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: f.plan.publisher.revision, TABGRAD_RELEASE_POLICY_JSON: raw.toString(),
    TABGRAD_RELEASE_POLICY_SHA256: sha256(raw),
  }), { code: "PUBLICATION_EXECUTION_REQUIRED" });
  assert.deepEqual(await readdir(root), []);
});

for (const [name, change] of [
  ["another recipe", f => { f.execution.publisher.revision = "f".repeat(40); }],
  ["another run", f => { f.execution.publisher.runId = "999"; }],
  ["a rerun", f => { f.execution.publisher.attempt = "2"; }],
  ["another repository", f => { f.context.repositoryId = "999"; }],
  ["another event", f => { f.context.event = "workflow_run"; }],
  ["a generated approval", f => { f.execution.approved = true; }],
  ["missing source checks", f => { f.execution.sourceChecks = []; }],
  ["duplicate source checks", f => { f.execution.sourceChecks.push(f.execution.sourceChecks[0]); }],
  ["an unbound history carrier", f => { f.execution.history.name = "arbitrary"; }],
  ["another plan", f => { f.execution.planSha256 = "0".repeat(64); }],
  ["another client", f => { f.profile.clients.npm = "0".repeat(64); }],
  ["expired qualification", f => { f.profile.operationalEvidence.expiresAt = new Date(f.now).toISOString(); }],
]) test(`stable resolution rejects ${name}`, () => {
  const f = stableFixture(); change(f);
  assert.throws(() => resolvePublicationExecution(f.profile, f.execution, f.plan, f.context, f.now));
});

for (const [name, change] of [
  ["wrong source", run => { run.head_sha = "f".repeat(40); }],
  ["another workflow", run => { run.path = ".github/workflows/arbitrary.yml"; }],
  ["wrong event", run => { run.event = "pull_request"; }],
  ["failed check run", run => { run.conclusion = "failure"; }],
  ["another repository", run => { run.repository.id = 999; }],
]) test(`provider corroboration rejects ${name}`, async () => {
  const f = stableFixture(), check = f.execution.sourceChecks[0];
  change(f.values.get(`/actions/runs/${check.runId}`));
  await assert.rejects(corroboratePublicationExecution({ ...f, policy: f.profile }), { code: "PUBLICATION_SOURCE_CHECKS_INVALID" });
});

test("derived execution cannot replace protection or discard failing/missing job coverage", async () => {
  const f = stableFixture(), policy = resolvePublicationExecution(f.profile, f.execution, f.plan, f.context, f.now);
  f.values.get("/environments/tabgrad-npm-publication").can_admins_bypass = true;
  await assert.rejects(observePublicationPrecheck({ ...f, policy }), { code: "PUBLICATION_PROTECTION_INVALID" });
  assert.equal(f.requests.includes("/actions/runs/301/approvals"), false);
  const check = f.execution.sourceChecks[0], jobs = f.values.get(`/actions/runs/${check.runId}/attempts/1/jobs?per_page=100`);
  jobs.jobs[1].conclusion = "failure";
  await assert.rejects(corroboratePublicationExecution({ ...f, policy: f.profile }), { code: "PUBLICATION_SOURCE_CHECKS_INVALID" });
});

test("expiry after a provider await stops new admission but preserves existing-call conservation", async () => {
  const f = stableFixture(); let now = f.now;
  const request = f.api.request;
  f.api.request = async route => { const value = await request(route); now = Date.parse(f.plan.window.deadline); return value; };
  await assert.rejects(corroboratePublicationExecution({ ...f, policy: f.profile, clock: () => now }),
    { code: "PUBLICATION_EXECUTION_INVALID" });
  f.requests.length = 0;
  assert.deepEqual(await corroboratePublicationExecution({ ...f, policy: f.profile, conservation: true, clock: () => now }),
    { status: "conservation-only", epoch: 2 });
  assert.equal(f.requests.length, 0);
});

test("physical input corroborates the enrolled maintainer and exact producer channel, without inventing qualification", async () => {
  const f = stableFixture(); f.plan.qualification.gpu = true;
  const body = `tabgrad-release-qualification ${f.plan.producer.verification.identity.runId}/1 ${f.plan.candidate.inventorySha256}\n{"report":"transport-only fixture"}`;
  const comment = { id: 901, body, user: { id: 11 },
    issue_url: `https://api.github.com/repos/${f.plan.publisher.repository}/issues/77` };
  f.values.set("/issues/comments/901", comment);
  f.execution.physical = { issue: "77", commentId: "901", sha256: sha256(Buffer.from(body)) };
  f.execution.planSha256 = sha256(canonicalBytes(f.plan));
  assert.deepEqual(await corroboratePublicationExecution({ ...f, policy: f.profile }),
    { status: "corroborated-unapproved", epoch: 2 });
  // This only authenticates transport. Existing input admission still validates
  // actual supplied-archive reports and the exact original CPU qualification.
  for (const change of [c => { c.user.id = 12; }, c => { c.body = c.body.replace("tabgrad-release-qualification", "gpu-consumers"); },
    c => { c.issue_url = c.issue_url.replace("/77", "/78"); }, c => { c.body += "edited"; }]) {
    const saved = structuredClone(comment); change(comment);
    await assert.rejects(corroboratePublicationExecution({ ...f, policy: f.profile }), { code: "PUBLICATION_PHYSICAL_INPUT_INVALID" });
    for (const key of Object.keys(comment)) delete comment[key]; Object.assign(comment, saved);
  }
});

test("record drift blocks initial admission while subsequent own journal updates remain possible", async () => {
  const f = stableFixture(), route = `/git/ref/${f.policy.record.ref.slice(5)}`;
  f.values.get(route).object.sha = "b".repeat(40);
  await assert.rejects(corroboratePublicationExecution({ ...f, policy: f.profile, initial: true }),
    { code: "PUBLICATION_HISTORY_HEAD_CHANGED" });
  assert.deepEqual(await corroboratePublicationExecution({ ...f, policy: f.profile }),
    { status: "corroborated-unapproved", epoch: 2 });
});

test("queued aggregate needs the exact active role before the actual review can grant authority", async () => {
  const f = fixture(); queuedRole(f);
  const authority = await observePublicationAuthority(f);
  assert.equal(authority.approved, true);
  assert.ok(f.requests.includes("/actions/runs/301/attempts/1/jobs?per_page=100"));
  assert.ok(f.requests.indexOf("/actions/runs/301/attempts/1/jobs?per_page=100")
    < f.requests.indexOf("/actions/runs/301/approvals"));
  f.values.set("/actions/runs/301/approvals", []);
  await assert.rejects(observePublicationAuthority(f), { code: "PUBLICATION_ENVIRONMENT_REVIEW_INVALID" });
});

for (const [name, change] of [
  ["missing selected role", f => { delete f.activeJobName; }],
  ["another role", (_f, job) => { job.name = "precheck-publication"; }],
  ["foreign run", (_f, job) => { job.run_id = 302; }],
  ["another attempt", (_f, job) => { job.run_attempt = 2; }],
  ["foreign source", (_f, job) => { job.head_sha = "a".repeat(40); }],
  ["unidentified job", (_f, job) => { job.id = 0; }],
  ["queued job", (_f, job) => { job.status = "queued"; }],
  ["completed job", (_f, job) => { job.status = "completed"; job.conclusion = "success"; }],
  ["conflicting conclusion", (_f, job) => { job.conclusion = "failure"; }],
  ["ambiguous role", (_f, job, jobs) => { jobs.jobs.push({ ...job, id: 92 }); jobs.total_count++; }],
  ["incomplete job page", (_f, _job, jobs) => { jobs.total_count++; }],
  ["terminal aggregate", f => { f.values.get("/actions/runs/301").status = "completed"; }],
]) test(`queued aggregate cannot borrow ${name} as execution proof`, async () => {
  const f = fixture(), { job, jobs } = queuedRole(f); change(f, job, jobs);
  await assert.rejects(observePublicationAuthority(f), { code: "PUBLICATION_RUN_INVALID" });
  assert.equal(f.requests.includes("/actions/runs/301/approvals"), false);
});

test("queued precheck remains unapproved and conservation keeps its separate time boundary", async () => {
  const precheck = fixture(); queuedRole(precheck, "precheck-publication");
  assert.deepEqual(await observePublicationPrecheck(precheck), { schemaVersion: 1, status: "unapproved-precheck" });
  assert.equal(precheck.requests.includes("/actions/runs/301/approvals"), false);
  const conservation = fixture(); queuedRole(conservation, "record-npm-outcome");
  conservation.clock = () => Date.parse(conservation.plan.window.deadline) + 1;
  assert.deepEqual(await observePublicationConservation(conservation), { schemaVersion: 1, status: "conservation-only" });
  assert.equal(conservation.requests.includes("/actions/runs/301/approvals"), false);
});

for (const [name, command, route, expires] of [
  ["role evidence crosses the window", observePublicationAuthority, "/actions/runs/301/attempts/1/jobs?per_page=100", "window"],
  ["review crosses the window", observePublicationAuthority, "/actions/runs/301/approvals", "window"],
  ["history read crosses the window", observePublicationPrecheck, "/actions/artifacts/201", "window"],
  ["conservation crosses qualification expiry", observePublicationConservation,
    "/actions/runs/301/attempts/1/jobs?per_page=100", "qualification"],
]) test(`decision time rejects when ${name}`, async () => {
  const f = fixture();
  if (route.includes("/jobs?")) queuedRole(f);
  let now = f.now; f.clock = () => now;
  const request = f.api.request;
  f.api.request = async key => {
    const value = await request(key);
    if (key === route) now = Date.parse(expires === "window" ? f.plan.window.deadline : f.policy.operationalEvidence.expiresAt);
    return value;
  };
  await assert.rejects(command(f), { code: "PUBLICATION_CONTEXT_INVALID" });
});

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
