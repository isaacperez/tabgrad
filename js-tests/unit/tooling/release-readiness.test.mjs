import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tagPreparationFixture, readyFixture } from "../../fixtures/tag-release.mjs";
import { selectReleaseInputs, composeReleaseInputs } from "../../../scripts/prepare-release.mjs";
import { resolvePublicationExecution } from "../../../scripts/publication-authority.mjs";
import { controlledConsumerReport } from "../../fixtures/package-provenance.mjs";
import { validatePublicationQualification } from "../../../scripts/publication-admission.mjs";
import { admitPublishedConsumers } from "../../../scripts/publication-registry.mjs";
import { canonicalBytes, sha256 } from "../../../scripts/release-record-data.mjs";
import { candidateTagMessage, parseCandidateTagMessage, readCandidateReadiness, observePreparedCandidate,
  observeTagAuthority, tagRequestWorkflow, tagControllerWorkflow } from "../../../scripts/release-readiness.mjs";


test("pre-tag composition freezes historical GPU and expected tag without opening the operation", async t => {
  const f = await tagPreparationFixture(t);
  await selectReleaseInputs(f.root, f.environment, f);
  await f.receive();
  const result = await composeReleaseInputs(f.root, f.environment, f);
  const plan = JSON.parse(await readFile(join(f.root, "input/plan.json")));
  assert.equal(result.mode, "prepared");
  assert.equal(plan.schemaVersion, 3);
  assert.equal(plan.github.before.tagRevision, f.candidate.sourceRevision);
  assert.equal(plan.qualification.gpu, true);
  assert.equal(plan.qualification.registryGpu, false);
  assert.deepEqual(plan.website, f.profile.tagDelivery.website);
  assert.ok(f.replays.every(call => call.command === "read"));
  assert.ok(f.requests.every(route => !route.includes("/dispatches")));
});

test("protected preparation freezes files while every control-record call remains read-only", async t => {
  const f = await readyFixture(t);
  assert.equal(f.frozen.status, "candidate-ready");
  assert.deepEqual(f.replays.map(call => call.command), ["read", "read"]);
  const files = await readdir(join(f.root, "public-output"));
  assert.deepEqual(files.sort(), ["candidate-approval.json", "candidate-ready.json", "input"]);
  assert.equal(f.selected.plan.operation, f.plan.operation);
  const original = await observePreparedCandidate({ api: f.api, plan: f.plan, planSha256: f.state.planSha256,
    profile: f.profile, ready: f.selected.ready, locator: f.locator, policySha256: f.environment.TABGRAD_RELEASE_POLICY_SHA256, clock: f.clock });
  assert.equal(original.runId, "301");
  for (const [route, mutate] of [
    ["/actions/runs/301/approvals", value => { value[0].state = "rejected"; }],
    ["/actions/runs/301", value => { value.run_attempt = 2; }],
    ["/actions/runs/301", value => { value.actor.id = 99; }],
    ["/actions/runs/301/attempts/1/jobs?per_page=100", value => { value.jobs[1].steps[0].name = "Candidate ready wrong"; }],
    ["/actions/runs/301/attempts/1/jobs?per_page=100", value => { value.jobs[2].conclusion = "success"; }],
    ["/actions/artifacts/901", value => { value.digest = `sha256:${"f".repeat(64)}`; }],
  ]) {
    const before = structuredClone(f.values.get(route)); mutate(f.values.get(route));
    await assert.rejects(observePreparedCandidate({ api: f.api, plan: f.plan, planSha256: f.state.planSha256,
      profile: f.profile, ready: f.selected.ready, locator: f.locator, policySha256: f.environment.TABGRAD_RELEASE_POLICY_SHA256, clock: f.clock }));
    f.values.set(route, before);
  }
});

test("ready transport binds original plan, notes, qualification, execution, approval and finite validity", async t => {
  const f = await readyFixture(t), directory = join(f.root, "public-output");
  const message = candidateTagMessage({ version: f.plan.candidate.version, sourceRevision: f.plan.candidate.sourceRevision, readiness: f.locator });
  assert.deepEqual(parseCandidateTagMessage(canonicalBytes(message).toString()), message);
  assert.throws(() => parseCandidateTagMessage(JSON.stringify(message)), { code: "PUBLICATION_TAG_MESSAGE_INVALID" });
  assert.throws(() => parseCandidateTagMessage(canonicalBytes({ ...message, extra: true }).toString()));
  for (const name of ["input/plan.json", "input/notes.md", "input/qualification.json", "input/execution.json", "candidate-approval.json", "candidate-ready.json"]) {
    const path = join(directory, name), before = await readFile(path);
    await writeFile(path, "{}\n");
    await assert.rejects(readCandidateReadiness(directory, f.environment.TABGRAD_RELEASE_POLICY_SHA256, f.now));
    await writeFile(path, before);
  }
  await assert.rejects(readCandidateReadiness(directory, "f".repeat(64), f.now));
  await assert.rejects(readCandidateReadiness(directory, f.environment.TABGRAD_RELEASE_POLICY_SHA256, Date.parse(f.plan.window.deadline)));
});

test("a later publisher authenticates the original approval while preserving its own current run", async t => {
  const f = await readyFixture(t), originalContext = f.state.context;
  const tag = { objectSha: "e".repeat(40), locator: f.locator, ready: f.selected.ready, requestRun: "501", controllerRun: "511" };
  const execution = { ...f.execution, schemaVersion: 2, publisher: { revision: originalContext.revision, runId: "601", attempt: "1" }, tag };
  const context = { ...originalContext, runId: "601" };
  const policy = resolvePublicationExecution(f.profile, execution, f.plan, context, f.now);
  assert.equal(policy.environment.name, "tabgrad-tag-publication");
  assert.equal(policy.originalEnvironment.name, "tabgrad-npm-publication");
  const message = candidateTagMessage({ version: f.plan.candidate.version, sourceRevision: f.plan.candidate.sourceRevision, readiness: f.locator });
  f.values.set(`/git/ref/tags/${f.plan.github.tag}`, { ref: `refs/tags/${f.plan.github.tag}`, object: { type: "tag", sha: tag.objectSha } });
  f.values.set(`/git/tags/${tag.objectSha}`, { sha: tag.objectSha, tag: f.plan.github.tag,
    object: { type: "commit", sha: f.plan.candidate.sourceRevision }, message: canonicalBytes(message).toString() });
  const run = (id, workflow, source, branch, event) => ({ id, run_attempt: 1, path: workflow, head_sha: source, head_branch: branch,
    event, status: "completed", conclusion: "success", actor: { id: 11 }, repository: { id: 17 }, head_repository: { id: 17 } });
  f.values.set("/actions/runs/501", { ...run(501, tagRequestWorkflow, f.plan.candidate.sourceRevision, "main", "push"),
    display_title: `Release tag ${f.plan.github.tag}` });
  const controller = run(511, tagControllerWorkflow, context.revision, "main", "workflow_run"); controller.display_title = "Tag delivery 501";
  f.values.set("/actions/runs/511", controller);
  for (const [id, name, source] of [[501, "request-tag-delivery", f.plan.candidate.sourceRevision], [511, "dispatch-tag-delivery", context.revision]]) {
    f.values.set(`/actions/runs/${id}/attempts/1/jobs?per_page=100`, { total_count: 1, jobs: [{ run_id: id, run_attempt: 1, name,
      head_sha: source, status: "completed", conclusion: "success", steps: id === 511 ? [{
        name: `Dispatched release 601 ${f.state.planSha256} ${tag.objectSha} ${tag.locator.sha256}`, status: "completed", conclusion: "success" }] : [] }] });
  }
  const observed = await observeTagAuthority({ api: f.api, plan: f.plan, planSha256: f.state.planSha256, policy, context,
    policySha256: f.environment.TABGRAD_RELEASE_POLICY_SHA256, clock: f.clock });
  assert.equal(observed.schemaVersion, 2); assert.equal(observed.runId, "601"); assert.equal(observed.preparation.runId, "301");
  for (const [route, mutate] of [
    ["/actions/runs/501", value => { value.actor.id = 99; }],
    ["/actions/runs/511", value => { value.head_sha = "f".repeat(40); }],
    ["/actions/runs/511/attempts/1/jobs?per_page=100", value => { value.jobs[0].steps[0].name = "Dispatched release 602 wrong"; }],
    [`/git/ref/tags/${f.plan.github.tag}`, value => { value.object.sha = "f".repeat(40); }],
  ]) {
    const before = structuredClone(f.values.get(route)); mutate(f.values.get(route));
    await assert.rejects(observeTagAuthority({ api: f.api, plan: f.plan, planSha256: f.state.planSha256, policy, context,
      policySha256: f.environment.TABGRAD_RELEASE_POLICY_SHA256, clock: f.clock }));
    f.values.set(route, before);
  }
  const changed = structuredClone(execution); changed.history.id = "999";
  assert.throws(() => resolvePublicationExecution(f.profile, changed, f.plan, context, f.now));
});


test("tag delivery requires pre-tag GPU and attributes it separately from fresh registry CPU consumers", async t => {
  const f = await readyFixture(t);
  const cpu = controlledConsumerReport(f.candidate, f.bytes);
  assert.throws(() => validatePublicationQualification([cpu], f.candidate, f.plan));
  const registry = controlledConsumerReport(f.candidate, f.bytes, { input: "registry-version" });
  registry.registry = { status: "passed", npm: "11.1.0", channel: f.plan.npm.channel, transport: { rejected: 0 },
    consumedArchive: f.candidate.tarball, checks: ["exact-registry-metadata", "channel", "dependency-boundary", "downloaded-archive-identity",
      "approved-cache-population", "named-registry-installation", "consumed-archive-integrity", "installed-inventory"] };
  const association = { status: "passed", originalProofSha256: f.plan.producer.archiveProofSha256 };
  const result = admitPublishedConsumers({ plan: f.plan, candidate: f.candidate, reports: [registry], association });
  assert.deepEqual(result.gpuQualification, { input: "supplied-archive", evidenceSha256: f.plan.qualification.evidenceSha256 });
  assert.throws(() => admitPublishedConsumers({ plan: f.plan, candidate: f.candidate, reports: [cpu], association }));
  const changed = structuredClone(registry); changed.candidate.archive.sha256 = "f".repeat(64);
  assert.throws(() => admitPublishedConsumers({ plan: f.plan, candidate: f.candidate, reports: [changed], association }));
});
