import assert from "node:assert/strict";
import { chmod, cp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { controlledConsumerReport as qualification, controlledVerifiedResult, provenanceFixture } from "../../fixtures/package-provenance.mjs";
import { hash } from "../../fixtures/package-candidate.mjs";
import { trialContext, producerSubjects, validateTrialQualification, inspectTrialPacket,
  githubRecord, checkTrialArtifact, checkTrialJobs, retainTrialProofs, verifyTrial, subjects } from "../../../scripts/producer-trial.mjs";

function environment(source = "a".repeat(40)) {
  return { TABGRAD_TRIAL_ENABLED: "true", TABGRAD_TRIAL_CONFIRMATION: "producer-trial",
    GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", GITHUB_RUN_ATTEMPT: "1",
    GITHUB_REPOSITORY: "example/project", GITHUB_REPOSITORY_ID: "17", GITHUB_REPOSITORY_OWNER_ID: "23",
    GITHUB_SHA: source, TABGRAD_TRIAL_SOURCE: source, GITHUB_RUN_ID: "131",
    GITHUB_WORKFLOW_REF: "example/project/.github/workflows/producer-trial.yml@refs/heads/main",
    TABGRAD_TRIAL_DEADLINE: "2030-01-01T00:00:00.000Z", TABGRAD_TRIAL_TRUST_ROOT: "c".repeat(64) };
}
async function packetFixture(t) {
  const f = await provenanceFixture(t);
  const directory = join(f.directory, "packet"); await mkdir(directory);
  await cp(f.source, join(directory, "package"), { recursive: true });
  await writeFile(join(directory, "candidate.json"), f.bytes);
  await cp(f.tarball, join(directory, f.candidate.tarball.path));
  const context = trialContext(environment(f.candidate.sourceRevision));
  const report = qualification(f.candidate, f.bytes);
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(directory, "qualification.json"), reportBytes);
  const subjects = producerSubjects(f.candidate, f.bytes);
  await writeFile(join(directory, "producer.json"), `${JSON.stringify({ schemaVersion: 1,
    identity: context.identity, expiresAt: context.expiresAt, inventorySha256: hash(f.bytes),
    archiveSha512: subjects.archive.digest.slice(7), qualificationSha256: hash(reportBytes) }, null, 2)}\n`);
  return { ...f, rootDirectory: f.directory, directory, context, report };
}
function artifact(context) {
  return { id: 71, name: "tabgrad-producer-data-131-1", digest: `sha256:${"d".repeat(64)}`,
    expired: false, size_in_bytes: 1000, expires_at: "2030-01-02T00:00:00.000Z",
    workflow_run: { id: 131, repository_id: 17, head_repository_id: 17,
      head_sha: context.identity.sourceRevision, head_branch: "main" } };
}

test("trial is inert unless exact event, flag, source, main, attempt and deadline agree", () => {
  assert.equal(trialContext(environment()).identity.runId, "131");
  for (const [field, value] of [["TABGRAD_TRIAL_ENABLED", undefined], ["TABGRAD_TRIAL_ENABLED", "TRUE"],
    ["TABGRAD_TRIAL_CONFIRMATION", "Producer-trial"], ["GITHUB_EVENT_NAME", "push"],
    ["GITHUB_REF", "refs/heads/MAIN"], ["GITHUB_RUN_ATTEMPT", "2"],
    ["TABGRAD_TRIAL_SOURCE", "b".repeat(40)], ["GITHUB_RUN_ID", 131],
    ["GITHUB_WORKFLOW_REF", "example/project/.github/workflows/other.yml@refs/heads/main"],
    ["TABGRAD_TRIAL_DEADLINE", "2000-01-01T00:00:00.000Z"], ["TABGRAD_TRIAL_TRUST_ROOT", "bad"]]) {
    assert.throws(() => trialContext({ ...environment(), [field]: value }), { name: "ProducerTrialError" });
  }
  assert.equal(trialContext({ ...environment(), TABGRAD_TRIAL_DEADLINE: "2000-01-01T00:00:00.000Z" },
    Date.now(), true).expiresAt, "2000-01-01T00:00:00.000Z");
});

test("subjects retain the scoped npm PURL and independently hashed original inventory", async t => {
  const f = await provenanceFixture(t); const subjects = producerSubjects(f.candidate, f.bytes);
  assert.equal(subjects.archive.name, `pkg:npm/%40tabgrad/retained-fixture@${f.candidate.version}`);
  assert.equal(subjects.archive.digest, `sha512:${Buffer.from(f.candidate.tarball.integrity.slice(7), "base64").toString("hex")}`);
  assert.equal(subjects.inventory.digest, `sha256:${hash(f.bytes)}`);
  assert.notEqual(producerSubjects(f.candidate, Buffer.concat([f.bytes, Buffer.from(" ")])).inventory.digest,
    subjects.inventory.digest);
});

test("qualification requires actual full consumer coverage, matching input and successful cleanup", async t => {
  const f = await provenanceFixture(t); const original = qualification(f.candidate, f.bytes);
  validateTrialQualification(original, f.candidate, hash(f.bytes));
  const changes = [r => { r.status = "failed"; }, r => { r.profiles.pop(); },
    r => { r.profiles[0].status = "failed"; }, r => { r.profiles[0] = r.profiles[1]; },
    r => { r.checks.pop(); }, r => { r.requested.browsers.pop(); },
    r => { r.expectedEvidenceSha256 = "0".repeat(64); }, r => { r.cleanupFailure = {}; },
    r => { r.candidate.archive.sha256 = "0".repeat(64); }];
  for (const change of changes) {
    const report = structuredClone(original); change(report);
    assert.throws(() => validateTrialQualification(report, f.candidate, hash(f.bytes)), { code: "TRIAL_QUALIFICATION" });
  }
});

test("packet inspection checks original bytes and complete static/package file set", async t => {
  const f = await packetFixture(t);
  const inspected = await inspectTrialPacket(f.directory, f.context);
  assert.equal(inspected.producer.inventorySha256, hash(f.bytes));
  await assert.rejects(inspectTrialPacket(f.directory, trialContext(environment("f".repeat(40)))), { code: "TRIAL_SOURCE" });
  await writeFile(join(f.directory, "extra"), "unexpected");
  await assert.rejects(inspectTrialPacket(f.directory, f.context), { code: "TRIAL_PACKET_FILES" });
});

test("packet rejects archive substitution and a canonical record from another run", async t => {
  const f = await packetFixture(t);
  const path = join(f.directory, "producer.json"); const bytes = await readFile(path);
  const p = JSON.parse(bytes); p.identity.runId = "132";
  await writeFile(path, `${JSON.stringify(p, null, 2)}\n`);
  await assert.rejects(inspectTrialPacket(f.directory, f.context), { code: "TRIAL_PACKET" });
  await writeFile(path, bytes);
  await writeFile(join(f.directory, f.candidate.tarball.path), "substitution");
  await assert.rejects(inspectTrialPacket(f.directory, f.context), { code: "ARCHIVE_MISMATCH" });
});

test("artifact identity, content, source, run, repository and expiry vary independently", () => {
  const c = trialContext(environment()); const a = artifact(c);
  checkTrialArtifact(a, c, "data", "71", "d".repeat(64));
  const changes = [x => { x.id = 72; }, x => { x.expired = true; }, x => { x.name += "other"; },
    x => { x.digest = `sha256:${"0".repeat(64)}`; }, x => { x.expires_at = "2029-01-01T00:00:00.000Z"; },
    x => { x.workflow_run.id = 132; }, x => { x.workflow_run.repository_id = 18; },
    x => { x.workflow_run.head_repository_id = 18; }, x => { x.workflow_run.head_sha = "f".repeat(40); },
    x => { x.workflow_run.head_branch = "other"; }, x => { x.id = Number.MAX_SAFE_INTEGER + 1; }];
  for (const change of changes) {
    const copy = structuredClone(a); change(copy);
    assert.throws(() => checkTrialArtifact(copy, c, "data", "71", "d".repeat(64)), { code: "TRIAL_ARTIFACT" });
  }
});

test("a deadline expiring during first-signature prechecks prevents subject delivery", async t => {
  const f = await packetFixture(t); let requests = 0;
  const env = { GH_TOKEN: "synthetic-read-token", TABGRAD_TRIAL_DATA_ID: "71", TABGRAD_TRIAL_DATA_DIGEST: "d".repeat(64) };
  await assert.rejects(subjects(f.directory, f.context, env, async () => {
    requests++;
    t.mock.method(Date, "now", () => Date.parse("2031-01-01T00:00:00.000Z"));
    return new Response(JSON.stringify(artifact(f.context)));
  }), { code: "TRIAL_DEADLINE_OR_ROOT" });
  assert.equal(requests, 1);
});

test("CI corroboration requires actual completed prepare and signer jobs for the selected source", () => {
  const c = trialContext(environment()); const run = { id: 131, head_sha: c.identity.sourceRevision,
    head_branch: "main", event: "workflow_dispatch", run_attempt: 1,
    path: ".github/workflows/producer-trial.yml", repository: { id: 17, owner: { id: 23 } } };
  const jobs = { total_count: 3, jobs: ["prepare-and-qualify", "sign-qualified-candidate", "verify-retained-proofs"]
    .map(name => ({ name, status: "completed", conclusion: "success", run_id: 131, head_sha: c.identity.sourceRevision })) };
  checkTrialJobs(run, jobs, c);
  assert.throws(() => checkTrialJobs({ ...run, run_attempt: 2 }, jobs, c), { code: "TRIAL_CI_IDENTITY" });
  for (const patch of [{ conclusion: "failure" }, { status: "queued" }, { head_sha: "f".repeat(40) }, { run_id: 132 }]) {
    const copy = structuredClone(jobs); Object.assign(copy.jobs[0], patch);
    assert.throws(() => checkTrialJobs(run, copy, c), { code: "TRIAL_CI_QUALIFICATION" });
  }
});

test("fixed API reader uses explicit identity/token, preserves original bytes and never retries", async () => {
  const c = trialContext(environment()); const calls = [];
  const original = '{ "id": 131 }\n';
  const fetcher = async (url, options) => { calls.push({ url, options }); return new Response(original); };
  const got = await githubRecord(c, "/actions/runs/131", "finite-read-token", fetcher);
  assert.equal(got.raw.toString(), original); assert.deepEqual(got.value, { id: 131 });
  assert.equal(calls[0].url, "https://api.github.com/repos/example/project/actions/runs/131");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.Authorization, "Bearer finite-read-token");
  await assert.rejects(githubRecord(c, "/actions/runs/131", "", fetcher), { code: "TRIAL_CI_ACCESS" });
  let failures = 0;
  await assert.rejects(githubRecord(c, "/actions/runs/131", "token", async () => {
    failures++; return new Response("unavailable", { status: 503 });
  }), { code: "TRIAL_CI_RESPONSE" });
  assert.equal(failures, 1);
  await assert.rejects(githubRecord(c, "/actions/runs/131", "token",
    async () => new Response("x".repeat(2 * 1024 * 1024 + 1))), { code: "TRIAL_CI_LIMIT" });
});

test("proof conservation retains partial binary bytes without inventing the second result", async t => {
  const f = await provenanceFixture(t); const path = join(f.directory, "first-proof");
  const bytes = Buffer.from([0, 255, 10, 0]); await writeFile(path, bytes);
  const directory = join(f.directory, "partial"); const report = await retainTrialProofs(path, "", directory);
  assert.equal(report.complete, false); assert.deepEqual(report.files.inventory, { present: false });
  assert.ok((await readFile(join(directory, "archive-proof.json"))).equals(bytes));
  assert.deepEqual((await readdir(directory)).sort(), ["archive-proof.json", "proofs.json"]);
  await assert.rejects(retainTrialProofs(path, "", directory), { code: "EEXIST" });
  const failed = join(f.directory, "failed-read");
  await assert.rejects(retainTrialProofs(path, join(f.directory, "missing"), failed), { code: "ENOENT" });
  assert.ok((await readFile(join(failed, "archive-proof.json"))).equals(bytes));
  const partial = JSON.parse(await readFile(join(failed, "proofs.json")));
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.files.inventory, { present: false, code: "ENOENT" });
});

async function verificationFixture(t) {
  const f = await packetFixture(t);
  const root = await readFile(f.paths.trustRoot);
  f.context.trustRootSha256 = hash(root);
  const subjects = producerSubjects(f.candidate, f.bytes);
  f.model.archive = controlledVerifiedResult(f.context.identity,
    { name: subjects.archive.name, digest: { sha512: subjects.archive.digest.slice(7) } });
  f.model.inventory = controlledVerifiedResult(f.context.identity,
    { name: subjects.inventory.name, digest: { sha256: subjects.inventory.digest.slice(7) } });
  await f.save();
  const proofs = join(f.rootDirectory, "proofs");
  await retainTrialProofs(f.paths.archiveBundle, f.paths.inventoryBundle, proofs);
  const client = join(f.rootDirectory, "client"); await mkdir(client);
  const source = (await readFile(f.paths.plan.client.path, "utf8"))
    .replace('else {\n  writeFileSync', 'else if (process.argv[2] === "attestation" && process.argv[3] === "trusted-root") { process.stdout.write(model.root); }\nelse {\n  writeFileSync');
  await writeFile(join(client, "gh"), source); await chmod(join(client, "gh"), 0o700);
  await writeFile(join(client, "client-model.json"), JSON.stringify({ ...f.model, root: root.toString() }));
  await writeFile(join(client, "client.json"), JSON.stringify({ path: join(client, "gh"), version: "2.102.0",
    sha256: hash(source), sourceArchiveSha256: "bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386" }));
  const dataArtifact = artifact(f.context);
  const proofArtifact = { ...dataArtifact, id: 72, name: "tabgrad-producer-proofs-131-1", digest: `sha256:${"e".repeat(64)}` };
  const records = {
    "/actions/artifacts/71": dataArtifact, "/actions/artifacts/72": proofArtifact,
    "/actions/runs/131": { id: 131, head_sha: f.candidate.sourceRevision, head_branch: "main", event: "workflow_dispatch",
      run_attempt: 1, path: ".github/workflows/producer-trial.yml", repository: { id: 17, owner: { id: 23 } } },
    "/actions/runs/131/attempts/1/jobs?per_page=100": { total_count: 3,
      jobs: ["prepare-and-qualify", "sign-qualified-candidate", "verify-retained-proofs"]
        .map(name => ({ name, status: "completed", conclusion: "success", run_id: 131, head_sha: f.candidate.sourceRevision })) },
  };
  const environment = { GH_TOKEN: "synthetic-read-token", TABGRAD_TRIAL_DATA_ID: "71", TABGRAD_TRIAL_DATA_DIGEST: "d".repeat(64),
    TABGRAD_TRIAL_PROOFS_ID: "72", TABGRAD_TRIAL_PROOFS_DIGEST: "e".repeat(64) };
  const calls = [];
  const fetcher = async url => {
    const path = url.slice("https://api.github.com/repos/example/project".length);
    assert.ok(Object.hasOwn(records, path)); calls.push(path);
    return new Response(`${JSON.stringify(records[path])}\n`);
  };
  const destination = join(f.rootDirectory, "verification");
  return { ...f, proofs, client, records, calls, destination, fetcher,
    run: (selectedFetch = fetcher) => verifyTrial(f.directory, proofs, client, destination, f.context, environment, selectedFetch) };
}

test("hosted composition uses original handoffs and service observations with the existing offline policy", async t => {
  const f = await verificationFixture(t); await f.run();
  const report = JSON.parse(await readFile(join(f.destination, "verification.json")));
  assert.equal(report.status, "passed");
  assert.equal(report.releaseAdmission, "unqualified");
  assert.equal(f.calls.length, 4);
  const ci = JSON.parse(await readFile(join(f.destination, "ci-evidence.json")));
  const producer = JSON.parse(await readFile(join(f.directory, "producer.json")));
  assert.deepEqual(ci.identity, f.context.identity);
  assert.equal(ci.qualification.evidenceSha256, producer.qualificationSha256);
  assert.deepEqual(JSON.parse(await readFile(join(f.destination, "api-run.json"))), f.records["/actions/runs/131"]);
  assert.ok((await readFile(join(f.destination, "trusted-root.jsonl"))).equals(await readFile(f.paths.trustRoot)));
});

test("hosted composition preserves failures instead of admitting changed API, roots, originals or client results", async t => {
  const cases = [
    ["actual run", f => { f.records["/actions/runs/131"].run_attempt = 2; }, "TRIAL_CI_IDENTITY"],
    ["independent root", f => { f.context.trustRootSha256 = "f".repeat(64); }, "TRIAL_TRUST_ROOT"],
    ["original proof", f => writeFile(join(f.proofs, "archive-proof.json"), "changed"), "TRIAL_PROOFS"],
    ["client rejection", async f => {
      const model = JSON.parse(await readFile(join(f.client, "client-model.json")));
      await writeFile(join(f.client, "client-model.json"), JSON.stringify({ ...model, mode: "reject" }));
    }, "CLIENT_REJECTED"],
  ];
  for (const [name, change, code] of cases) await t.test(name, async t => {
    const f = await verificationFixture(t); await change(f);
    await assert.rejects(f.run(), error => {
      assert.equal(error.code, code); return true;
    });
    const failure = JSON.parse(await readFile(join(f.destination, "failure.json")));
    assert.equal(failure.status, "failed"); assert.equal(failure.code, code);
    assert.equal(failure.releaseAdmission, "unqualified");
    await assert.rejects(readFile(join(f.destination, "verification.json")), { code: "ENOENT" });
  });
});

test("already received API originals survive a later query failure or metadata rejection", async t => {
  for (const failedRequest of [2, 3, 4]) await t.test(`query ${failedRequest}`, async t => {
    const f = await verificationFixture(t); let requests = 0;
    await assert.rejects(f.run(async (url, options) => {
      if (++requests === failedRequest) return new Response("unavailable", { status: 503 });
      return f.fetcher(url, options);
    }), { code: "TRIAL_CI_RESPONSE" });
    assert.equal(requests, failedRequest);
    for (const name of ["data", "proofs", "run"].slice(0, failedRequest - 1)) {
      assert.ok((await readFile(join(f.destination, `api-${name}.json`))).length > 0);
    }
  });
  await t.test("rejected artifact metadata", async t => {
    const f = await verificationFixture(t); f.records["/actions/artifacts/71"].expired = true;
    await assert.rejects(f.run(), { code: "TRIAL_ARTIFACT" });
    assert.deepEqual(JSON.parse(await readFile(join(f.destination, "api-data.json"))), f.records["/actions/artifacts/71"]);
  });
});

test("packet original encoding is independent of the consuming plan's identity key order", async t => {
  const f = await packetFixture(t);
  const identity = Object.fromEntries(Object.entries(f.context.identity).toSorted(([a], [b]) => a.localeCompare(b)));
  const result = await inspectTrialPacket(f.directory, { ...f.context, identity });
  assert.deepEqual(result.producer.identity, f.context.identity);
});
