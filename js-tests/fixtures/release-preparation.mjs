import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { provenanceFixture, controlledConsumerReport } from "./package-provenance.mjs";
import { trialContext, producerSubjects } from "../../scripts/producer-trial.mjs";
import { canonicalBytes, sha256 } from "../../scripts/release-record-data.mjs";
import { publicationEnvironmentSnapshot } from "../../scripts/publication-authority.mjs";

/** Controlled provider/consumer observations, not signatures, physical GPU results or service qualification. */
export async function releasePreparationFixture(t) {
  const f = await provenanceFixture(t), now = Date.now(), revision = "b".repeat(40);
  const expiry = new Date(now + 1800000).toISOString(), publisher = ".github/workflows/release-publication.yml";
  const environment = { TABGRAD_PUBLICATION_ENABLED: "true", TABGRAD_PUBLICATION_CONFIRMATION: "release-publication",
    GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", GITHUB_RUN_ATTEMPT: "1",
    GITHUB_REPOSITORY: "example/project", GITHUB_REPOSITORY_ID: "17", GITHUB_REPOSITORY_OWNER_ID: "23",
    GITHUB_SHA: revision, GITHUB_RUN_ID: "301", GITHUB_WORKFLOW_REF: `example/project/${publisher}@refs/heads/main`,
    TABGRAD_RELEASE_VERSION: f.candidate.version, TABGRAD_RELEASE_SOURCE: f.candidate.sourceRevision, TABGRAD_RECEIPT_ISSUE: "55" };
  const context = trialContext({ ...environment, GITHUB_SHA: f.candidate.sourceRevision, GITHUB_RUN_ID: "131",
    GITHUB_WORKFLOW_REF: "example/project/.github/workflows/producer-trial.yml@refs/heads/main",
    TABGRAD_TRIAL_ENABLED: "true", TABGRAD_TRIAL_CONFIRMATION: "producer-trial", TABGRAD_TRIAL_SOURCE: f.candidate.sourceRevision,
    TABGRAD_TRIAL_DEADLINE: expiry, TABGRAD_TRIAL_TRUST_ROOT: f.paths.plan.trustRootSha256 });
  const root = join(f.directory, "preparation"), data = join(f.directory, "data"); await mkdir(data);
  await cp(f.source, join(data, "package"), { recursive: true }); await cp(f.tarball, join(data, f.candidate.tarball.path));
  await writeFile(join(data, "candidate.json"), f.bytes);
  const cpu = controlledConsumerReport(f.candidate, f.bytes), cpuBytes = canonicalBytes(cpu);
  await writeFile(join(data, "qualification.json"), cpuBytes);
  const producer = { schemaVersion: 1, identity: context.identity, expiresAt: expiry, inventorySha256: sha256(f.bytes),
    archiveSha512: producerSubjects(f.candidate, f.bytes).archive.digest.slice(7), qualificationSha256: sha256(cpuBytes) };
  await writeFile(join(data, "producer.json"), `${JSON.stringify(producer, null, 2)}\n`);
  const protection = { id: 71, name: "tabgrad-npm-publication", can_admins_bypass: false,
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    protection_rules: [{ id: 72, type: "required_reviewers", prevent_self_review: false,
      reviewers: [{ type: "User", reviewer: { id: 11 } }] }] };
  const branches = [{ id: 73, type: "branch", name: "main" }];
  const qualificationRaw = canonicalBytes({ fixture: "operational qualification" });
  const profile = { schemaVersion: 2, repositoryId: "17", ownerId: "23", workflow: publisher, writerPolicySha256: "c".repeat(64),
    maintainers: [{ id: "11", ownerSha256: "3".repeat(64) }], humanControllerSha256: "d".repeat(64),
    environment: { id: "71", name: protection.name, snapshotSha256: sha256(canonicalBytes(publicationEnvironmentSnapshot(protection, branches))) },
    operationalEvidence: { sha256: sha256(qualificationRaw), expiresAt: expiry },
    record: { root: "f".repeat(40), location: "https://github.com/example/project.git", protocol: "https", ref: "refs/heads/release-control" },
    clients: { npm: "8".repeat(64), controller: "9".repeat(64), provenance: f.paths.plan.client.sha256,
      trustRoot: f.paths.plan.trustRootSha256 } };
  environment.TABGRAD_RELEASE_POLICY_JSON = canonicalBytes(profile).toString();
  environment.TABGRAD_RELEASE_POLICY_SHA256 = sha256(Buffer.from(environment.TABGRAD_RELEASE_POLICY_JSON));
  environment.TABGRAD_RELEASE_QUALIFICATION_JSON = qualificationRaw.toString();
  const artifact = (id, name, runId = "131", source = f.candidate.sourceRevision) => ({ id, name,
    digest: `sha256:${String(id % 10).repeat(64)}`, expired: false, size_in_bytes: 1000, expires_at: expiry,
    workflow_run: { id: Number(runId), head_sha: source, head_branch: "main", repository_id: 17, head_repository_id: 17 } });
  const outputs = ["data", "proofs", "verification"].map((name, index) => artifact(211 + index, `tabgrad-producer-${name}-131-1`));
  const history = artifact(220, "tabgrad-publication-completion-200-1", "200", "e".repeat(40));
  const run = { id: 131, run_attempt: 1, head_sha: f.candidate.sourceRevision, head_branch: "main", event: "workflow_dispatch",
    path: ".github/workflows/producer-trial.yml", status: "completed", conclusion: "success",
    repository: { id: 17, owner: { id: 23 } }, head_repository: { id: 17 } };
  const gpu = controlledConsumerReport(f.candidate, f.bytes, { gpu: true });
  gpu.profiles[0].gpu = { adapter: { isFallbackAdapter: false } };
  const comment = { id: 56, user: { id: 11 }, issue_url: "https://api.github.com/repos/example/project/issues/55",
    body: `tabgrad-release-qualification 131/1 ${sha256(f.bytes)}\n${canonicalBytes(gpu)}` };
  const sourceMetadata = { name: f.candidate.name, version: f.candidate.version, private: false };
  const sourceNotes = `# Changelog\n\n## ${f.candidate.version} - 2026-01-01\n\n- A useful correction.\n`;
  const content = raw => ({ type: "file", encoding: "base64", content: Buffer.from(raw).toString("base64"), size: Buffer.byteLength(raw) });
  const values = new Map([["", { id: 17, owner: { id: 23 }, full_name: "example/project", default_branch: "main", archived: false, disabled: false }],
    ["/actions/runs/301", { id: 301, run_attempt: 1, head_sha: revision, head_branch: "main", event: "workflow_dispatch", path: publisher,
      status: "in_progress", conclusion: null, repository: { id: 17 }, head_repository: { id: 17 }, actor: { id: 11 } }],
    [`/environments/${protection.name}`, protection],
    [`/environments/${protection.name}/deployment-branch-policies?per_page=100&page=1`, { total_count: 1, branch_policies: branches }],
    ["/git/ref/heads/main", { ref: "refs/heads/main", object: { type: "commit", sha: revision } }],
    ["/git/ref/heads/release-control", { ref: profile.record.ref, object: { type: "commit", sha: "a".repeat(40) } }],
    [`/contents/package.json?ref=${f.candidate.sourceRevision}`, content(JSON.stringify(sourceMetadata))],
    [`/contents/CHANGELOG.md?ref=${f.candidate.sourceRevision}`, content(sourceNotes)],
    ["/actions/runs/131", run], ["/actions/runs/131/attempts/1/jobs?per_page=100", { total_count: 3,
      jobs: ["prepare-and-qualify", "sign-qualified-candidate", "verify-retained-proofs"].map(name => ({ name,
        status: "completed", conclusion: "success", run_id: 131, head_sha: f.candidate.sourceRevision })) }],
    ["/issues/55/comments", [comment]], ["/issues/comments/56", comment],
    ...[...outputs, history].map(a => [`/actions/artifacts/${a.id}`, a])]);
  const producerRoute = `/actions/workflows/${encodeURIComponent(run.path)}/runs?branch=main&event=workflow_dispatch&status=success&head_sha=${run.head_sha}&per_page=100&page=1`;
  values.set(producerRoute, { total_count: 1, workflow_runs: [run] });
  values.set("/actions/runs/131/artifacts?per_page=100&page=1", { total_count: 3, artifacts: outputs });
  values.set("/actions/artifacts?per_page=100&page=1", { total_count: 1, artifacts: [history] });
  for (const [index, source] of [f.candidate.sourceRevision, revision].entries()) {
    const ci = { ...run, id: 401 + index, event: "push", head_sha: source, path: ".github/workflows/repository-checks.yml" };
    values.set(`/actions/workflows/${encodeURIComponent(ci.path)}/runs?branch=main&event=push&head_sha=${source}&per_page=100&page=1`,
      { total_count: 1, workflow_runs: [ci] });
    values.set(`/actions/runs/${ci.id}`, ci);
    values.set(`/actions/runs/${ci.id}/attempts/1/jobs?per_page=100`, { total_count: 5,
      jobs: ["repository-consistency", "runtime", "browser-Chrome", "browser-Firefox", "publication-client"].map(name => ({ name,
        run_id: ci.id, run_attempt: 1, head_sha: source, status: "completed", conclusion: "success" })) });
  }
  const requests = [], replays = [];
  const api = { request: async route => { requests.push(route); assert.ok(values.has(route), route); return structuredClone(values.get(route)); },
    pages: async route => { requests.push(route); assert.ok(values.has(route), route); return structuredClone(values.get(route)); },
    prerequisites: async plan => { assert.equal(plan.publisher.revision, revision); } };
  async function receive() {
    await cp(data, join(root, "data"), { recursive: true }); await mkdir(join(root, "proofs")); await mkdir(join(root, "verification"));
    const proofPlan = { ...f.paths.plan, identity: context.identity, expiresAt: expiry };
    for (const name of ["archive-proof.json", "inventory-proof.json"]) await cp(join(f.directory, name), join(root, "proofs", name));
    await writeFile(join(root, "verification/plan.json"), canonicalBytes(proofPlan));
    for (const name of ["ci-evidence.json", "trusted-root.jsonl", "verification.json", "api-run.json", "api-jobs.json", "api-data.json", "api-proofs.json"]) {
      await writeFile(join(root, "verification", name), name === "trusted-root.jsonl" ? await readFile(f.paths.trustRoot) : "{}\n");
    }
    const historyPath = join(root, "initial-history/evidence"); await mkdir(historyPath, { recursive: true });
    const raw = canonicalBytes({ fixture: "history original" }); await writeFile(join(historyPath, `${sha256(raw)}.json`), raw);
  }
  const replay = async options => { replays.push(options); return { head: options.expectedHead,
    checkpoint: { activeOperation: null, blockingUnresolvedCalls: 0, conflictingCalls: 0 } }; };
  const registry = { startingState: async () => ({ package: "existing", version: "absent", channel: "0.9.6" }) };
  return { ...f, root, data, now, clock: () => now, environment, profile, values, api, requests, outputs, history,
    producer, gpu, cpu, comment, receive, replay, replays, registry };
}
