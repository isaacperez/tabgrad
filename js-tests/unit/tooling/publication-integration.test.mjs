import assert from "node:assert/strict";
import { copyFile, lstat, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { publicationServiceFixture } from "../../fixtures/publication-service.mjs";
import { controlledConsumerReport } from "../../fixtures/package-provenance.mjs";
import { humanPublicationFixture } from "../../fixtures/publication-human.mjs";
import { publicationNamespaceService } from "../../fixtures/publication-namespace.mjs";
import { runHumanPublisher } from "../../../scripts/publication-human.mjs";
import { gateRoles } from "../../../scripts/publication-gate.mjs";
import { prepareNpmPublication, selectPublicationGate, permitPreparedPublication, executeNpm,
  relayBootstrapReadiness, freshHumanPublication, authorizeHumanPublication, awaitBootstrapOutcome } from "../../../scripts/release-publication.mjs";
import { canonicalBytes, sha256 } from "../../../scripts/release-record-data.mjs";
import { releaseRecord } from "../../../scripts/release-record.mjs";
import { publicationRecord } from "../../../scripts/publication-record.mjs";
import { publicationRecordConfig, publicationRecordHead, recordNpmPublication,
  corroboratePublicationJob, corroboratePublicationOutput } from "../../../scripts/publication-controller.mjs";
import { admitPublishedConsumers } from "../../../scripts/publication-registry.mjs";
import { completeGithubPublication, npmCallReceipt } from "../../../scripts/publication-effects.mjs";

async function prepare(f) {
  await prepareNpmPublication(f.root, f.state, f.material, f.admission, f.environment, f.ports);
  await f.emit("ready", await readFile(join(f.root, "public-output/ready.json")));
  await selectPublicationGate(f.observerRoot, f.observerState, f.admission, f.environment, "ready");
  await f.transfer("ready", join(f.observerRoot, "received-ready"));
  await permitPreparedPublication(f.observerRoot, f.observerState, f.material, f.admission, f.environment);
  await f.emit("permission", await readFile(join(f.observerRoot, "public-output/permission.json")));
  await selectPublicationGate(f.root, f.state, f.admission, f.environment, "permission");
  await f.transfer("permission", join(f.root, "received-permission"));
}

async function call(f, ports = f.ports) {
  let failure;
  try { await executeNpm(f.root, f.state, f.material, f.admission, f.environment, ports); }
  catch (error) { failure = error; }
  const receipt = JSON.parse(await readFile(join(f.root, "public-output/npm-receipt.json")));
  return { receipt, failure };
}

async function record(f, receipt) {
  const job = f.jobs.get("ready"); job.status = "completed"; job.conclusion = receipt.status === "passed" ? "success" : "failure";
  const raw = canonicalBytes(receipt), id = "13", digest = sha256(raw);
  f.packets.set("result", { raw, metadata: { id: Number(id), name: `tabgrad-publication-npm-${f.state.context.runId}-1`,
    digest: `sha256:${digest}`, size_in_bytes: raw.length, expired: false, expires_at: f.plan.window.deadline,
    workflow_run: { id: Number(f.state.context.runId), head_sha: f.state.context.revision, head_branch: "main",
      repository_id: Number(f.state.context.repositoryId), head_repository_id: Number(f.state.context.repositoryId) } } });
  const config = await publicationRecordConfig(join(f.root, "evidence"), f.policy);
  return recordNpmPublication({ plan: f.plan, config, expectedHead: await publicationRecordHead(f.state.api, f.policy),
    handoff: f.admission.handoff, receipt, authorityObservation: f.authorityObservation, directory: join(f.root, "evidence"),
    basis: f.plan.npm.mode === "bootstrap" ? "reconciliation" : "call", authenticateReceipt: async () => {
      await corroboratePublicationJob(f.state.api, f.state.context, f.jobs.get("ready").name, job.conclusion);
      await corroboratePublicationOutput(f.state.api, f.state.context, id, digest,
        `tabgrad-publication-npm-${f.state.context.runId}-1`, f.plan.window.deadline);
    } });
}

async function complete(f, recorded, consumerFailure = false) {
  const controller = await publicationRecord({ ...f, config: recorded.config, expectedHead: recorded.head });
  const report = controlledConsumerReport(f.candidate, canonicalBytes(f.candidate), { input: "registry-version" });
  report.registry = { status: "passed", npm: "11.1.0", channel: f.plan.npm.channel, transport: { rejected: 0 },
    consumedArchive: f.candidate.tarball,
    checks: ["exact-registry-metadata", "channel", "dependency-boundary", "downloaded-archive-identity",
      "approved-cache-population", "named-registry-installation", "consumed-archive-integrity", "installed-inventory"] };
  if (consumerFailure) report.profiles[0].status = "failed";
  const verifyRegistry = async () => admitPublishedConsumers({ plan: f.plan, candidate: f.candidate, reports: [report],
    association: await f.registry.associateOriginalProof(f.plan, f.material.proof) });
  const result = await completeGithubPublication({ plan: f.plan, record: controller, fresh: f.state.fresh,
    notes: f.material.notes, inspectNpm: mode => f.registry.inspect(f.plan, mode), verifyRegistry,
    inspectGithub: () => f.observerState.api.state(f.plan, new Map(f.plan.github.assets.map(a => [a.name, a]))),
    write: (effect, current) => f.observerState.api.write(effect, f.plan, current, f.assets.get(effect.asset?.name), f.material.notes) });
  return { result, controller };
}

test("production roles: prepared readonly client→late observer→call→real Git→consumers→conditional completion", async t => {
  const f = await publicationServiceFixture(t); await prepare(f);
  const { receipt, failure } = await call(f); assert.equal(failure, undefined); assert.equal(f.calls, 1);
  const recorded = await record(f, receipt), completed = await complete(f, recorded);
  assert.equal(completed.result.status, "passed");
  const replay = await releaseRecord({ command: "read", config: completed.controller.config, expectedHead: completed.controller.head });
  assert.equal(replay.operations[0].closure.result, "completed"); assert.equal(replay.operations[0].calls.length, 10);
  assert.equal(replay.operations[0].calls[0].call, f.admission.handoff.call);
  assert.equal(f.requests.some(r => r.role === "client" && r.route.startsWith("/releases")), false);
  assert.equal(f.requests.some(r => r.role === "observer" && r.route === "/releases"), true);
});

test("production bootstrap: real child readiness→attributed CI relay→late observer→parent approval→Git outcome and completion", { timeout: 120000 }, async t => {
  const actual = Boolean(process.env.TABGRAD_COMPOSITION_CLIENT);
  const service = actual ? await publicationNamespaceService(t) : null;
  const f = await publicationServiceFixture(t, "bootstrap", { clientSha256: process.env.TABGRAD_COMPOSITION_CLIENT_SHA256 });
  const h = await humanPublicationFixture(t, { actual, registry: service?.registry,
    clientDirectory: process.env.TABGRAD_COMPOSITION_CLIENT, clientSha256: f.plan.publisher.clientSha256 });
  await writeFile(join(h.root, "input/plan.json"), canonicalBytes(f.plan));
  await writeFile(join(h.root, "admission/admission.json"), canonicalBytes(f.admission));
  await copyFile(f.material.archive, join(h.root, "data/candidate.tgz"));
  await copyFile(f.material.proof, join(h.root, "proofs/archive-proof.json"));
  f.jobs.set("ready", { id: 11, run_id: Number(f.state.context.runId), head_sha: f.state.context.revision,
    name: gateRoles.bootstrap, status: "in_progress", conclusion: null, steps: [] });
  let coordinated = false;
  f.flags.beforeJobsRead = async () => {
    if (coordinated) return;
    const body = await readFile(join(h.root, "public-output/readiness-comment.txt"), "utf8").catch(error => {
      if (error.code !== "ENOENT") throw error; return null;
    });
    if (body === null) return;
    coordinated = true;
    assert.equal((await readFile(join(h.root, "trace.txt"), "utf8")).includes("publish"), false);
    // This is the controlled maintainer/provider port, not a write by the reader.
    f.comments.push({ id: 101, body, user: { id: 23 }, updated_at: new Date().toISOString() });
    await relayBootstrapReadiness(f.root, f.state, f.admission, f.environment);
    await f.emit("ready", await readFile(join(f.root, "public-output/ready.json")));
    await selectPublicationGate(f.observerRoot, f.observerState, f.admission, f.environment, "ready");
    await f.transfer("ready", join(f.observerRoot, "received-ready"));
    await permitPreparedPublication(f.observerRoot, f.observerState, f.material, f.admission, f.environment);
    await f.emit("permission", await readFile(join(f.observerRoot, "public-output/permission.json")));
  };
  const controller = new AbortController(), humanState = { ...f.state, api: f.clientApi(controller.signal) };
  const environment = { ...f.environment, ...h.environment };
  const result = await runHumanPublisher({ ...h, plan: f.plan, admission: f.admission, environment,
    fresh: () => freshHumanPublication(h.root, humanState, f.admission, environment),
    authorizeReady: ready => authorizeHumanPublication(h.root, humanState, f.admission, environment, ready),
    cancelPending: () => controller.abort() });
  assert.equal(result.status, "completed"); assert.equal(coordinated, true); assert.ok(f.packets.has("permission"));
  assert.equal((await readFile(join(h.root, "trace.txt"), "utf8")).split("\n").filter(x => x === "publish").length, 1);
  f.applyPublishedState(); // Observe the child's one simulated external effect.
  const prefix = `tabgrad-release-bootstrap ${f.state.planSha256} ${f.plan.operation} ${f.state.context.runId}/1\n`;
  f.comments.push({ id: 102, body: prefix + canonicalBytes(result.receipt).toString(), user: { id: 23 }, updated_at: new Date().toISOString() });
  await awaitBootstrapOutcome(f.root, f.state, f.environment);
  const observed = JSON.parse(await readFile(join(f.root, "public-output/bootstrap.json")));
  const completed = await complete(f, await record(f, observed.receipt));
  assert.equal(completed.result.status, "passed");
  assert.equal(f.requests.some(r => r.role === "client" && r.route.startsWith("/releases")), false);
});

test("production selector waits on provisional metadata before the complete flow continues", async t => {
  const f = await publicationServiceFixture(t); f.flags.pending = true; await prepare(f);
  const { receipt } = await call(f); assert.equal(f.flags.pendingSeen, true); assert.equal(receipt.outcome, "verified-effect");
  await record(f, receipt);
});

test("changed destination after client preparation prevents a permission", async t => {
  const f = await publicationServiceFixture(t);
  await prepareNpmPublication(f.root, f.state, f.material, f.admission, f.environment, f.ports);
  await f.emit("ready", await readFile(join(f.root, "public-output/ready.json")));
  await selectPublicationGate(f.observerRoot, f.observerState, f.admission, f.environment, "ready");
  await f.transfer("ready", join(f.observerRoot, "received-ready"));
  f.destination.tagRevision = "0".repeat(40);
  await assert.rejects(permitPreparedPublication(f.observerRoot, f.observerState, f.material, f.admission, f.environment),
    { code: "PUBLICATION_TAG_CONFLICT" });
  await assert.rejects(lstat(join(f.observerRoot, "public-output/permission.json")), { code: "ENOENT" }); assert.equal(f.calls, 0);
});

for (const failure of ["scope", "head", "client", "packet"]) test(`production execution rejects changed ${failure} before dispatch`, async t => {
  const f = await publicationServiceFixture(t); await prepare(f);
  let ports = f.ports;
  if (failure === "scope") f.state.context.runId = "999";
  if (failure === "head") await f.record.observe(f.admission.handoff.call, f.record.effects[0], "unknown",
    { synthetic: "competing observation moved the actual record head" });
  if (failure === "client") ports = { ...ports, identifyClient: async () => { throw Object.assign(new Error("changed"), { code: "PUBLICATION_CLIENT_CHANGED" }); } };
  if (failure === "packet") await writeFile(join(f.root, "received-permission/permission.json"), "{}");
  const { receipt } = await call(f, ports); assert.equal(f.calls, 0);
  assert.equal(receipt.outcome, ["scope", "head"].includes(failure) ? "unknown" : "verified-no-effect");
});

for (const failure of ["extra-member", "symlink", "artifact-replaced"]) test(`permission transfer rejects ${failure} before dispatch`, async t => {
  const f = await publicationServiceFixture(t); await prepare(f);
  const directory = join(f.root, "received-permission");
  if (failure === "extra-member") await writeFile(join(directory, "unapproved.json"), "{}");
  if (failure === "symlink") {
    const original = join(f.root, "permission-original.json");
    await rename(join(directory, "permission.json"), original);
    await symlink(original, join(directory, "permission.json"));
  }
  if (failure === "artifact-replaced") f.packets.get("permission").metadata.digest = `sha256:${"f".repeat(64)}`;
  const { receipt, failure: error } = await call(f);
  assert.ok(error); assert.equal(f.calls, 0); assert.equal(receipt.outcome, "verified-no-effect");
});

for (const failure of ["expired", "permission-lost", "revoked"]) test(`uncertain production attempt cannot become no-effect when repeated after ${failure}`, async t => {
  const f = await publicationServiceFixture(t); await prepare(f);
  let directory;
  const publish = async options => { directory = options.directory; await writeFile(join(directory, "synthetic-config"), "fixture");
    await f.ports.publish(options); throw Object.assign(new Error("lost output"), { code: "OUTPUT_LOST", dispatched: true }); };
  const first = await call(f, { ...f.ports, publish }); assert.equal(first.receipt.outcome, "unknown"); assert.equal(f.calls, 1);
  await assert.rejects(lstat(directory), { code: "ENOENT" });
  const preserved = join(f.root, "archived-diagnostics"); await mkdir(preserved);
  await rename(join(f.root, "public-output/npm-receipt.json"), join(preserved, "receipt.json"));
  await rename(join(f.root, "private/npm-call.json"), join(preserved, "original.json"));
  const clock = Date.now;
  if (failure === "expired") Date.now = () => Date.parse(f.plan.window.deadline) + 1;
  if (failure === "permission-lost") f.packets.delete("permission");
  if (failure === "revoked") f.flags.revoked = true;
  let second;
  try { second = await call(f); } finally { Date.now = clock; }
  assert.equal(f.calls, 1); assert.equal(second.receipt.outcome, "unknown");
  assert.equal(second.receipt.dispatched, null);
});

for (const reason of ["consumers", "GitHub"]) test(`known npm result survives ${reason} rejection without republishing`, async t => {
  const f = await publicationServiceFixture(t); await prepare(f); const { receipt } = await call(f), recorded = await record(f, receipt);
  if (reason === "GitHub") f.destination.tagRevision = "0".repeat(40);
  await assert.rejects(complete(f, recorded, reason === "consumers")); assert.equal(f.calls, 1);
  const replay = await releaseRecord({ command: "read", config: recorded.config, expectedHead: recorded.head });
  assert.equal(replay.operations[0].calls[0].outcome, "verified-effect"); assert.equal(replay.operations[0].calls.length, 1);
});
