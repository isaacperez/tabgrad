import assert from "node:assert/strict";
import test from "node:test";
import { cp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tagControllerFixture } from "../../fixtures/tag-release.mjs";
import { selectTagCandidate, dispatchTagCandidate, activateTagCandidate } from "../../../scripts/tag-delivery.mjs";

async function selected(t) {
  const f = await tagControllerFixture(t);
  const result = await selectTagCandidate(f.directory, f.environment, { api: f.api, clock: f.clock, controller: true });
  assert.deepEqual(result, { mode: "tag", readiness_id: "901", readiness_run: "301", readiness_sha256: f.selected.sha256, tag_object: f.tagObject });
  await f.receive();
  return f;
}

test("tag controller admits fixed preparation and dispatches the existing publisher exactly once", async t => {
  const f = await selected(t), writes = [];
  const api = { ...f.api, request: async (path, options) => {
    if (options?.method === "POST") {
      writes.push({ path, options });
      return { workflow_run_id: 601, run_url: `https://api.github.com/repos/${f.environment.GITHUB_REPOSITORY}/actions/runs/601`,
        html_url: `https://github.com/${f.environment.GITHUB_REPOSITORY}/actions/runs/601` };
    }
    return f.api.request(path, options);
  } };
  const result = await dispatchTagCandidate(f.directory, f.environment, { api, clock: f.clock });
  assert.deepEqual(result, { run_id: "601", plan_sha256: f.state.planSha256, tag_object: f.tagObject, readiness_sha256: f.selected.sha256 });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.workflowDispatch, true);
  assert.deepEqual(writes[0].options.body.inputs, { confirmation: "release-publication", release_tag: f.plan.github.tag,
    tag_request_run: "501", tag_controller_run: "511", tag_object: f.tagObject });
  await assert.rejects(dispatchTagCandidate(f.directory, f.environment, { api, clock: f.clock }));
  assert.equal(writes.length, 1);
});

test("lost or malformed dispatch response stays unknown without an automatic second write", async t => {
  for (const malformed of [false, true]) await t.test(String(malformed), async t => {
    const f = await selected(t); let calls = 0;
    const api = { ...f.api, request: async (path, options) => {
      if (options?.method !== "POST") return f.api.request(path, options);
      calls++;
      if (malformed) return {};
      throw Object.assign(new Error("lost response"), { dispatched: true });
    } };
    await assert.rejects(dispatchTagCandidate(f.directory, f.environment, { api, clock: f.clock }));
    const receipt = JSON.parse(await readFile(join(f.directory, "public-output/dispatch-result.json")));
    assert.equal(receipt.outcome, "unknown"); assert.equal(receipt.runId, null);
    await assert.rejects(dispatchTagCandidate(f.directory, f.environment, { api, clock: f.clock }));
    assert.equal(calls, 1);
  });
});

test("controller rejects changed recipe, duplicate request, environment or artifact before dispatch", async t => {
  for (const kind of ["main", "duplicate", "environment", "artifact"]) await t.test(kind, async t => {
    const f = await selected(t); let calls = 0;
    if (kind === "main") f.values.get("/git/ref/heads/main").object.sha = "f".repeat(40);
    if (kind === "duplicate") {
      const path = `/actions/workflows/${encodeURIComponent(".github/workflows/tag-delivery.yml")}/runs?event=workflow_run&head_sha=${f.state.context.revision}&per_page=100&page=1`;
      const value = f.values.get(path); value.total_count++; value.workflow_runs.push({ ...value.workflow_runs[0], id: 512 });
    }
    if (kind === "environment") f.values.get("/environments/website-tag-publication").protection_rules = [{ type: "required_reviewers" }];
    if (kind === "artifact") f.values.get("/actions/artifacts/901").expired = true;
    const api = { ...f.api, request: async (path, options) => { if (options?.method === "POST") calls++; return f.api.request(path, options); } };
    await assert.rejects(dispatchTagCandidate(f.directory, f.environment, { api, clock: f.clock }));
    assert.equal(calls, 0);
  });
});


test("a different request cannot reuse readiness selected by a prior failed controller", async t => {
  const f = await selected(t);
  const path = `/actions/workflows/${encodeURIComponent(".github/workflows/tag-delivery.yml")}/runs?event=workflow_run&head_sha=${f.state.context.revision}&per_page=100&page=1`;
  const list = f.values.get(path); list.total_count++;
  list.workflow_runs.push({ ...list.workflow_runs[0], id: 510, status: "completed", conclusion: "failure", display_title: "Tag delivery 500" });
  f.values.set("/actions/runs/510/attempts/1/jobs?per_page=100", { total_count: 1, jobs: [{ name: "dispatch-tag-delivery", run_id: 510, head_sha: f.state.context.revision, steps: [{
    name: `Selected candidate ${f.selected.sha256} ${f.tagObject}`, status: "completed", conclusion: "success" }] }] });
  await assert.rejects(dispatchTagCandidate(f.directory, f.environment, { api: f.api, clock: f.clock }), { code: "PUBLICATION_TAG_DISPATCH_DUPLICATE" });
});


test("receiver keeps original approval and frozen bytes while recording its actual publishing run", async t => {
  const f = await selected(t);
  const environment = { ...f.environment, TABGRAD_TAG_OBJECT: f.tagObject, GITHUB_RUN_ID: "601", GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW_REF: `${f.environment.GITHUB_REPOSITORY}/${f.profile.workflow}@refs/heads/main` };
  const controller = f.values.get("/actions/runs/511"); controller.status = "completed"; controller.conclusion = "success";
  f.values.set("/actions/runs/511/attempts/1/jobs?per_page=100", { total_count: 1, jobs: [{ name: "dispatch-tag-delivery", run_id: 511,
    head_sha: f.state.context.revision, status: "completed", conclusion: "success", steps: [{ status: "completed", conclusion: "success",
      name: `Dispatched release 601 ${f.state.planSha256} ${f.tagObject} ${f.selected.sha256}` }] }] });
  f.values.set("/actions/runs/601", { ...f.values.get("/actions/runs/301"), id: 601, status: "in_progress", conclusion: null });
  const directory = join(f.root, "receiver");
  await selectTagCandidate(directory, environment, { api: f.api, clock: f.clock });
  await cp(join(f.root, "public-output"), join(directory, "candidate-ready"), { recursive: true });
  const result = await activateTagCandidate(directory, environment, { api: f.api, clock: f.clock });
  assert.equal(result.plan_sha256, f.state.planSha256);
  assert.deepEqual(await readFile(join(directory, "input/plan.json")), await readFile(join(f.root, "input/plan.json")));
  const execution = JSON.parse(await readFile(join(directory, "input/execution.json")));
  assert.equal(execution.publisher.runId, "601"); assert.equal(execution.tag.ready.preparation.runId, "301");
  assert.equal(execution.tag.objectSha, f.tagObject);
  const newObject = "f".repeat(40);
  f.values.set(`/git/tags/${newObject}`, { ...f.values.get(`/git/tags/${f.tagObject}`), sha: newObject });
  f.values.get(`/git/ref/tags/${f.plan.github.tag}`).object.sha = newObject;
  await assert.rejects(selectTagCandidate(join(f.root, "reannotated"), environment, { api: f.api, clock: f.clock }), { code: "PUBLICATION_TAG_SELECTION_CHANGED" });
});
