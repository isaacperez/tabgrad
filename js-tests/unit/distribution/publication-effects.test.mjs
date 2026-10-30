import assert from "node:assert/strict";
import test from "node:test";
import { publicationPlanFixture } from "../../fixtures/publication.mjs";
import { publicationAuthorityDocument, publicationCandidateIdentity, publicationEffects } from "../../../scripts/publication-plan.mjs";
import { canonicalBytes, sha256 } from "../../../scripts/release-record-data.mjs";
import { checkPublicationGithubState, completeGithubPublication, npmCallReceipt, prepareNpmCall,
  requireNpmCallReceipt, requireNpmIntent } from "../../../scripts/publication-effects.mjs";
import { admitNpmManifest } from "../../../scripts/publication-npm.mjs";

function controllerFixture(context) {
  const { publicationPlan: plan } = publicationPlanFixture();
  const effects = publicationEffects(plan), complete = new Set(), log = [];
  let release = null, tagRevision = null, latestId = null, unsettled = false;
  const assets = [];
  const record = { effects, complete, head: "f".repeat(40),
    async intent(effect) { assert.equal(unsettled, false); unsettled = true; log.push(["intent", effect.kind]); return "d".repeat(64); },
    async observe(call, effect, outcome) {
      assert.equal(unsettled, true); log.push(["observe", effect.kind, outcome]);
      if (outcome === "verified-effect") complete.add(effect.identity);
      unsettled = outcome === "unknown";
    },
    async close(result) { assert.equal(unsettled, false); log.push(["close", result]); } };
  const inspectGithub = async () => ({ release, tagRevision, latestId, assets: [...assets] });
  const fresh = async () => { log.push(["authority"]); };
  const inspectNpm = async mode => { log.push(["npm-read", mode]); };
  const write = async effect => {
    assert.equal(unsettled, true); log.push(["write", effect.kind]);
    if (effect.kind === "github-tag") tagRevision = plan.candidate.sourceRevision;
    if (effect.kind === "github-draft") release = { id: 10, name: plan.github.tag, tag_name: plan.github.tag,
      body: "approved notes", draft: true, prerelease: false, immutable: false };
    if (effect.kind === "github-asset") assets.push({ ...effect.asset, id: String(assets.length + 1) });
    if (effect.kind === "github-public") { release.draft = false; release.immutable = true; latestId = "10"; }
    return { accepted: effect.identity };
  };
  const verifyRegistry = async () => { log.push(["registry-consumers"]); return { status: "passed" }; };
  return { plan, record, log, fresh, inspectNpm, inspectGithub, write, verifyRegistry, notes: "approved notes", context };
}

test("policy model: confirmed intent precedes every write and registry consumers precede GitHub", async context => {
  const f = controllerFixture(context);
  const handoff = await prepareNpmCall(f);
  assert.equal(handoff.effect, f.record.effects[0].identity);
  await f.record.observe(handoff.call, f.record.effects[0], "verified-effect");
  const result = await completeGithubPublication(f);
  assert.equal(result.status, "passed");
  assert.deepEqual(f.log.at(-1), ["close", "completed"]);
  const firstWrite = f.log.findIndex(entry => entry[0] === "write");
  assert.ok(f.log.findIndex(entry => entry[0] === "registry-consumers") < firstWrite);
  for (let i = 0; i < f.log.length; i += 1) if (f.log[i][0] === "write") {
    assert.deepEqual(f.log[i - 2], ["intent", f.log[i][1]]);
    assert.deepEqual(f.log[i - 1], ["authority"]);
  }
});

test("policy model: npm verification failure prevents all GitHub writes", async () => {
  const f = controllerFixture(); f.record.complete.add(f.record.effects[0].identity);
  f.verifyRegistry = async () => ({ status: "failed" });
  await assert.rejects(completeGithubPublication(f), { code: "PUBLICATION_REGISTRY_NOT_VERIFIED" });
  assert.equal(f.log.some(entry => entry[0] === "write"), false);
});

for (const dispatched of [false, true]) test(`policy model: failed call preserves dispatched=${dispatched} and never retries`, async () => {
  const f = controllerFixture(); f.record.complete.add(f.record.effects[0].identity);
  f.write = async () => { const error = new Error("fixture"); error.dispatched = dispatched; throw error; };
  await assert.rejects(completeGithubPublication(f), /fixture/);
  assert.equal(f.log.filter(entry => entry[0] === "intent").length, 1);
  assert.deepEqual(f.log.at(-1), ["observe", "github-tag", dispatched ? "unknown" : "verified-no-effect"]);
});

test("policy model: matching destination does not replace the journal's npm outcome", async () => {
  const f = controllerFixture();
  await assert.rejects(completeGithubPublication(f), { code: "PUBLICATION_NPM_NOT_CONFIRMED" });
  assert.equal(f.log.length, 0);
});

test("policy model: known completed effects are inspected but not written again", async () => {
  const f = controllerFixture(); f.record.complete.add(f.record.effects[0].identity);
  await completeGithubPublication(f);
  f.log.length = 0;
  await completeGithubPublication(f);
  assert.equal(f.log.some(entry => entry[0] === "write"), false);
  assert.deepEqual(f.log.at(-1), ["close", "completed"]);
});

test("policy model: changed authority after intent produces a known no-call observation", async () => {
  const f = controllerFixture(); f.record.complete.add(f.record.effects[0].identity);
  let count = 0;
  f.fresh = async () => { if (++count === 3) throw new Error("revoked"); };
  await assert.rejects(completeGithubPublication(f), /revoked/);
  assert.equal(f.log.some(entry => entry[0] === "write"), false);
  assert.deepEqual(f.log.at(-1), ["observe", "github-tag", "verified-no-effect"]);
});

test("policy model: conflicting tag or inaccessible/unowned release cannot be adopted", () => {
  const f = controllerFixture();
  for (const state of [
    { tagRevision: "0".repeat(40), release: null, assets: [] },
    { tagRevision: null, release: { id: 7 }, assets: [] },
  ]) assert.throws(() => checkPublicationGithubState(f.plan, state, f.record.complete, f.notes));
});

test("intent binding rejects replacements and any prior outcome/observation", () => {
  const { publicationPlan: plan, authority: authorityObservation } = publicationPlanFixture();
  authorityObservation.planSha256 = sha256(canonicalBytes(plan));
  const effect = publicationEffects(plan)[0].identity;
  const handoff = { schemaVersion: 1, operation: plan.operation, planSha256: sha256(canonicalBytes(plan)),
    effect, call: "b".repeat(64), recordHead: "a".repeat(40) };
  const replay = { head: handoff.recordHead, checkpoint: { activeOperation: plan.operation, unresolvedCalls: 1, conflictingCalls: 0 },
    operations: [{ operation: plan.operation, closure: null, admission: { window: plan.window, owner: plan.owner,
      candidate: publicationCandidateIdentity(plan), authority: sha256(canonicalBytes(publicationAuthorityDocument(plan, authorityObservation))) },
    calls: [{ call: handoff.call, intent: { effect }, outcome: "unknown", observations: 0 }] }] };
  requireNpmIntent(plan, replay, handoff, authorityObservation);
  for (const mutate of [value => { value.head = "c".repeat(40); },
    value => { value.operations[0].calls[0].observations = 1; },
    value => { value.checkpoint.unresolvedCalls = 2; }]) {
    const changed = structuredClone(replay); mutate(changed);
    assert.throws(() => requireNpmIntent(plan, changed, handoff, authorityObservation), { code: "PUBLICATION_NPM_INTENT_INVALID" });
  }
});

test("npm receipt preserves unrecognized successful output and dispatched failures as unknown", () => {
  const { publicationPlan: plan } = publicationPlanFixture();
  const handoff = { call: "b".repeat(64), effect: publicationEffects(plan)[0].identity };
  const client = { manifestSha256: plan.publisher.clientSha256 };
  const result = { status: 0, dispatched: true, stdout: JSON.stringify({ [plan.candidate.name]: {
    name: plan.candidate.name, version: plan.candidate.version,
    integrity: `sha512-${Buffer.from(plan.candidate.archiveSha512, "hex").toString("base64")}` } }) };
  const receipt = npmCallReceipt(plan, handoff, client, result);
  assert.equal(receipt.outcome, "verified-effect"); requireNpmCallReceipt(plan, handoff, receipt);
  assert.equal(npmCallReceipt(plan, handoff, client, { ...result, stdout: "unrecognized" }).outcome, "unknown");
  assert.equal(npmCallReceipt(plan, handoff, client, undefined, { dispatched: true }).outcome, "unknown");
  assert.equal(npmCallReceipt(plan, handoff, client, undefined, { dispatched: false }).outcome, "verified-no-effect");
});

test("all effective package overrides are admitted before publication", () => {
  const { publicationPlan: plan } = publicationPlanFixture();
  const manifest = { name: plan.candidate.name, version: plan.candidate.version, private: false };
  admitNpmManifest(manifest, plan);
  admitNpmManifest({ ...manifest, publishConfig: { access: "public", registry: plan.npm.registry, tag: "latest" } }, plan);
  for (const config of [{ provenance: true }, { provenance: false }, { "provenance-file": "other" },
    { registry: "https://example.invalid/" }, { access: "restricted" }, { "@example:registry": "https://example.invalid/" },
    { tag: "other" }, { ignoreScripts: false }]) {
    assert.throws(() => admitNpmManifest({ ...manifest, publishConfig: config }, plan), { code: "PUBLICATION_NPM_OVERRIDE" });
  }
});

function fixture() {
  const { publicationPlan: plan } = publicationPlanFixture();
  return { plan, handoff: { call: "b".repeat(64), effect: "c".repeat(64) }, client: { manifestSha256: plan.publisher.clientSha256 } };
}

test("human confirmation is explicitly selected and requires the complete observed terminal result", () => {
  const { plan, handoff, client } = fixture();
  const result = { status: 0, signal: null, dispatched: true, stdout: null, stderr: null, outputMode: "inherited-terminal" };
  const human = npmCallReceipt(plan, handoff, client, result, undefined, "human-terminal-exit");
  assert.equal(human.outcome, "verified-effect");
  assert.equal(human.code, "PUBLICATION_NPM_HUMAN_PROCESS_SUCCESS");
  assert.doesNotThrow(() => requireNpmCallReceipt(plan, handoff, human));
  assert.equal(npmCallReceipt(plan, handoff, client, result).outcome, "unknown");
  for (const changed of [{ status: 1 }, { signal: "SIGKILL" }, { dispatched: false }, { outputMode: "captured" },
    { stdout: "" }, { stderr: "" }]) {
    assert.notEqual(npmCallReceipt(plan, handoff, client, { ...result, ...changed }, undefined, "human-terminal-exit").outcome,
      "verified-effect");
  }
  const error = Object.assign(new Error("deadline"), { code: "PUBLICATION_CLIENT_TIMEOUT", dispatched: true, privateClientEvidence: result });
  assert.equal(npmCallReceipt(plan, handoff, client, undefined, error, "human-terminal-exit").outcome, "unknown");
  plan.npm.mode = "publish";
  assert.equal(npmCallReceipt(plan, handoff, client, result, undefined, "human-terminal-exit").outcome, "unknown");
  assert.throws(() => requireNpmCallReceipt(plan, handoff, human), { code: "PUBLICATION_NPM_RECEIPT_INVALID" });
});

test("CI keeps package-specific JSON confirmation and rejects empty or substituted output", () => {
  const { plan, handoff, client } = fixture();
  const body = { name: plan.candidate.name, version: plan.candidate.version,
    integrity: `sha512-${Buffer.from(plan.candidate.archiveSha512, "hex").toString("base64")}` };
  const result = { status: 0, signal: null, dispatched: true, stdout: JSON.stringify({ [body.name]: body }), stderr: "" };
  assert.equal(npmCallReceipt(plan, handoff, client, result).outcome, "verified-effect");
  for (const stdout of ["", "{", JSON.stringify({ [body.name]: { ...body, version: "9.9.9" } }),
    JSON.stringify({ [body.name]: { ...body, integrity: "sha512-d3JvbmctYnl0ZXM=" } })]) {
    assert.equal(npmCallReceipt(plan, handoff, client, { ...result, stdout }).outcome, "unknown");
  }
});
