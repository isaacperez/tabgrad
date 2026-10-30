import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { publicationPlanFixture } from "../../fixtures/publication.mjs";
import { canonicalBytes, sha256 } from "../../../scripts/release-record-data.mjs";
import { gateArtifactBinding, gateJobBinding, gatePermission, gateReady,
  publicationGateScope, readGatePacket } from "../../../scripts/publication-gate.mjs";
import { pendingPublicationObservation } from "../../../scripts/publication-controller.mjs";

const recorded = JSON.parse(await readFile(new URL("../../fixtures/publication-pending-step.json", import.meta.url)));
function fixture() {
  const { publicationPlan: plan } = publicationPlanFixture();
  plan.npm.mode = "oidc";
  const context = { event: "workflow_dispatch", ref: "refs/heads/main", revision: plan.publisher.revision,
    runId: "301", attempt: "1", repositoryId: "123",
    workflowRef: `${plan.publisher.repository}/${plan.publisher.workflow}@refs/heads/main` };
  const handoff = { planSha256: sha256(canonicalBytes(plan)), call: "1".repeat(64), recordHead: "a".repeat(40) };
  return { plan, context, scope: publicationGateScope(plan, context, handoff) };
}

test("sanitized originals preserve the pending literal and actor-separated completed observation", () => {
  const f = fixture();
  assert.equal(recorded.records[0].observedBy, "observer");
  assert.equal(recorded.records[1].observedBy, "client");
  assert.equal(gateJobBinding(recorded.records[0].response, f.scope, "ready"), null);
  const proof = gateJobBinding(recorded.records[1].response, f.scope, "ready");
  assert.equal(proof.rawSha256, "a".repeat(64));
});

for (const status of ["pending", "in_progress"]) test(`unresolved ${status} step is not final malformed proof`, () => {
  const f = fixture(), body = structuredClone(recorded.records[1].response);
  body.jobs[0].steps[0].status = status; body.jobs[0].steps[0].conclusion = null;
  body.jobs[0].steps[0].name = "Readiness SHA256 ${{ steps.prepare.outputs.ready_sha }}";
  assert.equal(gateJobBinding(body, f.scope, "ready"), null);
});

for (const [name, change] of [
  ["literal", s => { s.name = "Readiness SHA256 ${{ steps.prepare.outputs.ready_sha }}"; }],
  ["masked", s => { s.name = "Readiness SHA256 ***"; }],
  ["empty", s => { s.name = "Readiness SHA256 "; }],
  ["failed", s => { s.conclusion = "failure"; }],
]) test(`completed ${name} upload is rejected`, () => {
  const f = fixture(), body = structuredClone(recorded.records[1].response);
  change(body.jobs[0].steps[0]);
  assert.throws(() => gateJobBinding(body, f.scope, "ready"), { code: "PUBLICATION_GATE_STEP_INVALID" });
});

test("packet hashes, closed schema and original scope are independent of JSON issuer claims", () => {
  const f = fixture(), ready = gateReady(f.scope), permission = gatePermission(f.scope, ready);
  readGatePacket(permission, f.scope, "permission", sha256(permission));
  assert.throws(() => readGatePacket(permission, f.scope, "permission", "0".repeat(64)));
  for (const change of [p => { p.scope.context.runId = "999"; }, p => { p.scope.mode = "observe"; },
    p => { p.scope.handoff.call = "9".repeat(64); }, p => { p.issuer = "observer"; },
    p => { p.scope.handoff.recordHead = "0".repeat(40); }]) {
    const p = JSON.parse(permission); change(p); const raw = canonicalBytes(p);
    assert.throws(() => readGatePacket(raw, f.scope, "permission", sha256(raw)), { code: "PUBLICATION_GATE_PACKET_SCOPE" });
  }
});

test("artifact identity does not substitute ZIP digest for packet digest", () => {
  const { scope } = fixture(); const rawSha = "a".repeat(64), zipSha = "b".repeat(64);
  const a = { id: 3, name: `publication-ready-301-${rawSha}`, digest: `sha256:${zipSha}`, expired: false,
    size_in_bytes: 400, expires_at: scope.window.deadline, workflow_run: { id: 301,
      head_sha: scope.context.revision, head_branch: "main", repository_id: 123, head_repository_id: 123 } };
  const found = gateArtifactBinding({ total_count: 1, artifacts: [a] }, scope, "ready", rawSha);
  assert.equal(found.zipSha256, zipSha);
  assert.equal(gateArtifactBinding({ total_count: 1, artifacts: [a] }, scope, "ready", zipSha), null);
  for (const change of [v => { v.workflow_run.id = 999; }, v => { v.expired = true; },
    v => { v.workflow_run.head_repository_id = 999; }, v => { v.digest = null; }]) {
    const changed = structuredClone(a); change(changed);
    assert.throws(() => gateArtifactBinding({ total_count: 1, artifacts: [changed] }, scope, "ready", rawSha));
  }
});

test("a terminal client cannot become ready again in this attempt", () => {
  const f = fixture(), body = structuredClone(recorded.records[1].response);
  body.jobs[0].status = "completed"; body.jobs[0].conclusion = "success";
  assert.throws(() => gateJobBinding(body, f.scope, "ready"), { code: "PUBLICATION_GATE_CLIENT_STOPPED" });
});

test("a terminal unsuccessful observer does not wait for a new attempt", () => {
  const f = fixture(), body = structuredClone(recorded.records[1].response);
  body.jobs[0].name = "observe-ready-publication"; body.jobs[0].status = "completed"; body.jobs[0].conclusion = "neutral";
  assert.throws(() => gateJobBinding(body, f.scope, "permission"), { code: "PUBLICATION_GATE_JOB_FAILED" });
});

test("human readiness retains exact attributed bytes and ignores another author or window", async () => {
  const f = fixture(), raw = gateReady(f.scope), prefix = `tabgrad-release-bootstrap-ready ${f.scope.planSha256} ${f.plan.operation} 301/1\n`;
  const comment = { id: 101, body: prefix + raw.toString(), user: { id: 23 }, updated_at: f.plan.window.start };
  const policy = { maintainers: [{ id: "23", ownerSha256: f.plan.owner }] };
  const options = { api: { pages: async () => [comment] }, context: f.context, policy, plan: f.plan,
    planSha256: f.scope.planSha256, issue: "7", kind: "bootstrap-ready", clock: () => Date.parse(f.plan.window.start) };
  const result = await pendingPublicationObservation(options);
  assert.deepEqual(result.raw, raw); assert.equal(result.original.id, 101);
  for (const change of [c => { c.user.id = 24; }, c => { c.updated_at = f.plan.window.deadline; },
    c => { c.body = c.body.replace("301/1", "302/1"); }]) {
    const invalid = structuredClone(comment); change(invalid); let now = Date.parse(f.plan.window.start);
    await assert.rejects(pendingPublicationObservation({ ...options, api: { pages: async () => [invalid] },
      clock: () => now, pause: async () => { now = Date.parse(f.plan.window.deadline); } }),
    { code: "PUBLICATION_BOOTSTRAP_DEADLINE" });
  }
  await assert.rejects(pendingPublicationObservation({ ...options, api: { pages: async () => [comment, { ...comment, id: 102 }] } }),
    { code: "PUBLICATION_BOOTSTRAP_RECEIPT_CONFLICT" });
});
