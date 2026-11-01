/** Manual release roles. Importing this module performs no service operation. */
import { appendFile, cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blockingRecordCalls, canonicalBytes, sha256 } from "./release-record-data.mjs";
import { releaseRecord } from "./release-record.mjs";
import { publicationGithub } from "./publication-github.mjs";
import { publicationRegistry, admitPublishedConsumers } from "./publication-registry.mjs";
import { publicationRecord } from "./publication-record.mjs";
import { admitPublicationPolicy, observePublicationPrecheck, observePublicationAuthority,
  observePublicationConservation, observePublicationProducer, publicationApprovalComment } from "./publication-authority.mjs";
import { admitPublicationInputs, publicationFile, recheckPublicationInputs } from "./publication-admission.mjs";
import { identifyPublicationClient, publicationEnvironment, runPublicationProcess } from "./publication-client.mjs";
import { publishNpmArchive } from "./publication-npm.mjs";
import { completeGithubPublication, npmCallReceipt, prepareNpmCall, requireNpmIntent,
  requirePublicationRecordAdmission } from "./publication-effects.mjs";
import { corroboratePublicationJob, corroboratePublicationOutput, pendingPublicationObservation,
  publicationRecordConfig, publicationRecordHead, readPublicationJson, recordNpmPublication, savePublicationJson } from "./publication-controller.mjs";
import { publicationHistoryInput, transferPublicationHistory } from "./publication-controller.mjs";
import { publicationAuthorityBytes, publicationChecksums } from "./prepare-publication-plan.mjs";
import { PublicationError, publicationEffects, requirePublication, validatePublicationPlan } from "./publication-plan.mjs";
import { readProducerInventory } from "./package-provenance.mjs";
import { registryEnvironment } from "./package-registry.mjs";
import { runHumanPublisher } from "./publication-human.mjs";
import { createPublicationEvidence } from "./publication-evidence.mjs";
import { claimGateSession, consumeGatePermission, corroborateExpectedPermission, gatePermission, gateReady, gateRoles,
  publicationGateScope, readGatePacket, receiveGatePacket, requireGateAuthority, requireGateWindow,
  recheckGateSelection, selectGatePacket } from "./publication-gate.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const producerWorkflow = ".github/workflows/producer-trial.yml";
const roleNames = { precheck: "precheck-publication", admit: "admit-publication", npm: gateRoles.client, bootstrap: gateRoles.bootstrap,
  observe: "record-npm-outcome", consume: "verify-published-consumers", complete: "complete-github-release" };
const commandRoles = { ...roleNames, "npm-prepare": roleNames.npm, human: roleNames.bootstrap,
  "bootstrap-ready": roleNames.bootstrap, "select-ready": gateRoles.observer,
  "select-permission": roleNames.npm, permit: gateRoles.observer };
const metadataCommands = ["select-ready", "select-permission", "permit", "bootstrap-ready", "bootstrap"];
const commands = ["precheck", "admit", "npm-prepare", "npm", "observe", "consume", "complete", "human", ...metadataCommands];

/** Role-local execution proof stays separate from the shared client/observer gate context. */
export function publicationRoleJob(command) {
  const name = commandRoles[command];
  requirePublication(typeof name === "string", "PUBLICATION_ROLE_CONTEXT");
  return name;
}

async function output(values, environment) {
  if (!environment.GITHUB_OUTPUT) return;
  for (const [key, value] of Object.entries(values)) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    requirePublication(/^[a-z_]+$/.test(key) && !/[\r\n]/.test(text), "PUBLICATION_OUTPUT_INVALID");
    await appendFile(environment.GITHUB_OUTPUT, `${key}=${text}\n`);
  }
}

export function publicationContext(environment) {
  return { event: environment.GITHUB_EVENT_NAME, ref: environment.GITHUB_REF,
    revision: environment.GITHUB_SHA, workflowRef: environment.GITHUB_WORKFLOW_REF,
    runId: environment.GITHUB_RUN_ID, attempt: environment.GITHUB_RUN_ATTEMPT,
    repositoryId: environment.GITHUB_REPOSITORY_ID };
}

async function request(root, environment, human = false, conservation = false, command) {
  requirePublication(isAbsolute(root) && (human || (environment.TABGRAD_PUBLICATION_ENABLED === "true"
    && environment.TABGRAD_PUBLICATION_CONFIRMATION === "release-publication")), "PUBLICATION_DISABLED");
  const raw = environment.TABGRAD_PUBLICATION_PLAN_JSON === undefined
    ? await publicationFile(join(root, "input/plan.json"), 65536)
    : Buffer.from(environment.TABGRAD_PUBLICATION_PLAN_JSON);
  requirePublication(raw.length <= 65536 && process.execArgv.length === 0
    && ["NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY"].every(key => !environment[key])
    && environment.NODE_TLS_REJECT_UNAUTHORIZED !== "0", "PUBLICATION_PROCESS_PROFILE");
  const parsed = JSON.parse(raw);
  const plan = validatePublicationPlan(parsed, conservation ? Date.parse(parsed.window?.start) : Date.now());
  const planSha256 = environment.TABGRAD_PUBLICATION_PLAN_SHA256;
  requirePublication(canonicalBytes(plan).equals(raw) && sha256(raw) === planSha256, "PUBLICATION_PLAN_IDENTITY");
  requirePublication(human || (environment.GITHUB_EVENT_NAME === "workflow_dispatch" && environment.GITHUB_REF === "refs/heads/main"
    && environment.GITHUB_RUN_ATTEMPT === "1" && environment.GITHUB_SHA === plan.publisher.revision
    && process.version === "v22.12.0" && sha256(await readFile(process.execPath)) === plan.publisher.githubClientSha256),
  "PUBLICATION_RECIPE_RUNTIME");
  const policy = admitPublicationPolicy(Buffer.from(environment.TABGRAD_RELEASE_POLICY_JSON ?? ""),
    environment.TABGRAD_RELEASE_POLICY_SHA256);
  requirePublication(policy.schemaVersion === 1, "PUBLICATION_EXECUTION_REQUIRED");
  const evidence = Buffer.from(environment.TABGRAD_RELEASE_QUALIFICATION_JSON ?? "");
  requirePublication(sha256(evidence) === policy.operationalEvidence.sha256,
    "PUBLICATION_OPERATIONAL_EVIDENCE_UNAVAILABLE");
  requirePublication(conservation || Date.parse(plan.window.deadline) <= Date.parse(policy.operationalEvidence.expiresAt),
    "PUBLICATION_QUALIFICATION_WINDOW");
  requirePublication(policy.record.protocol === "https"
    && policy.record.location === `https://github.com/${plan.publisher.repository}.git`, "PUBLICATION_RECORD_LOCATION");
  let context = publicationContext(environment);
  if (human) {
    const rawAdmission = await publicationFile(join(root, "admission/admission.json"), 4 * 1024 * 1024);
    requirePublication(sha256(rawAdmission) === environment.TABGRAD_HUMAN_ADMISSION_SHA256
      && process.version === "v22.12.0" && sha256(await readFile(process.execPath)) === policy.humanControllerSha256,
    "PUBLICATION_HUMAN_CONTROLLER_UNQUALIFIED");
    context = JSON.parse(rawAdmission).context;
    const git = arguments_ => spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-C", repository, ...arguments_],
      { encoding: "utf8", env: { ...publicationEnvironment(root, environment), GIT_NO_REPLACE_OBJECTS: "1" },
        timeout: 30000, maxBuffer: 1024 * 1024 });
    const head = git(["rev-parse", "HEAD"]), diff = git(["diff", "--no-ext-diff", "--no-textconv", "--quiet", "HEAD", "--"]);
    requirePublication(head.status === 0 && head.stdout.trim() === plan.publisher.revision && diff.status === 0,
      "PUBLICATION_HUMAN_RECIPE_CHANGED");
  }
  const trustedJob = { admit: "admit", permit: "gate", complete: "complete" }[command];
  const writer = !human && trustedJob !== undefined && environment.GITHUB_JOB === trustedJob;
  requirePublication(trustedJob === undefined || writer, "PUBLICATION_ROLE_CONTEXT");
  const observationController = new AbortController();
  const activeJobName = publicationRoleJob(command);
  const api = publicationGithub({ repository: plan.publisher.repository, token: environment.GH_TOKEN,
    readOnly: !writer, draftVisibility: writer ? "qualified-workflow-writer" : null, signal: observationController.signal });
  const fresh = async () => {
    const result = await observePublicationAuthority({ api, plan, planSha256, policy, context, activeJobName });
    await observePublicationProducer(api, plan);
    await api.prerequisites(plan);
    requirePublication(Date.now() < Date.parse(plan.window.deadline), "PUBLICATION_WINDOW_EXPIRED");
    return result;
  };
  return { plan, planSha256, policy, context, activeJobName, api, fresh,
    cancelObservations: () => observationController.abort(),
    conserve: () => observePublicationConservation({ api, plan, policy, context, activeJobName }) };
}

async function stageRequest(root, environment, plan) {
  await mkdir(join(root, "input"), { recursive: true, mode: 0o700 });
  for (const [name, bytes] of [["plan.json", canonicalBytes(plan)], ["notes.md", Buffer.from(environment.TABGRAD_PUBLICATION_NOTES ?? "")],
    ["qualification.json", Buffer.from(environment.TABGRAD_PUBLICATION_QUALIFICATION_JSON ?? "")]]) {
    await stagePublicationFile(join(root, "input", name), bytes);
  }
  await stagePublicationFile(join(root, "input/release-checksums.txt"), Buffer.from(publicationChecksums(plan)));
}

async function stagePublicationFile(path, raw) {
  try { await writeFile(path, raw, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    requirePublication((await publicationFile(path, raw.length)).equals(raw), "PUBLICATION_INPUT_CHANGED");
  }
}

async function inputLocations(root, plan, environment) {
  const dataDirectory = join(root, "data"), proofsDirectory = join(root, "proofs");
  const raw = await publicationFile(join(dataDirectory, "candidate.json"), 2 * 1024 * 1024);
  requirePublication(sha256(raw) === plan.candidate.inventorySha256, "PUBLICATION_INVENTORY_CHANGED");
  const candidate = readProducerInventory(raw);
  const evidencePath = join(root, "input/producer-evidence.json");
  const evidence = await createPublicationEvidence({ dataDirectory, verificationDirectory: join(root, "verification"),
    qualification: join(root, "input/qualification.json") });
  try { await writeFile(evidencePath, evidence, { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST" || !(await readFile(evidencePath)).equals(evidence)) throw error; }
  const assets = Object.fromEntries(plan.github.assets.map(asset => [asset.name,
    asset.kind === "archive" ? join(dataDirectory, candidate.tarball.path)
      : asset.kind === "inventory" ? join(dataDirectory, "candidate.json")
        : asset.kind.endsWith("-proof") ? join(proofsDirectory, `${asset.kind}.json`)
          : asset.kind === "evidence" ? evidencePath : join(root, "input/release-checksums.txt") ]));
  return { plan, dataDirectory, proofsDirectory, assets, qualification: join(root, "input/qualification.json"),
    notes: join(root, "input/notes.md"), verificationClient: environment.TABGRAD_PROVENANCE_CLIENT,
    trustRoot: join(root, "verification/trusted-root.jsonl"), ciEvidence: join(root, "verification/ci-evidence.json") };
}

async function configAndHead(root, state, environment) {
  process.env.GIT_ASKPASS = fileURLToPath(new URL("./release-record-askpass.mjs", import.meta.url));
  process.env.GITHUB_TOKEN = environment.GH_TOKEN;
  const input = environment.TABGRAD_RECORD_INPUT ?? join(root, "admission/evidence");
  const source = await publicationHistoryInput(root, input, state.policy.history);
  await transferPublicationHistory(source, join(root, "evidence"));
  const config = await publicationRecordConfig(join(root, "evidence"), state.policy);
  return { config,
    expectedHead: await publicationRecordHead(state.api, state.policy) };
}

async function retainAuthority(root, plan) {
  const raw = publicationAuthorityBytes(plan);
  requirePublication(sha256(raw) === plan.authority, "PUBLICATION_OPAQUE_AUTHORITY_INVALID");
  await mkdir(join(root, "evidence"), { recursive: true, mode: 0o700 });
  const path = join(root, "evidence", `${plan.authority}.json`);
  try { await writeFile(path, raw, { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST" || !(await readFile(path)).equals(raw)) throw error; }
}

async function acceptedAdmission(root, state, environment) {
  await corroboratePublicationJob(state.api, state.context, roleNames.admit);
  await corroboratePublicationOutput(state.api, state.context, environment.TABGRAD_ADMISSION_ID,
    environment.TABGRAD_ADMISSION_DIGEST, `tabgrad-publication-admission-${state.context.runId}-${state.context.attempt}`,
    state.plan.window.deadline);
  const admission = await readPublicationJson(join(root, "admission/admission.json"), 4 * 1024 * 1024);
  requirePublication(sha256(canonicalBytes(admission)) === environment.TABGRAD_ADMISSION_SHA256,
    "PUBLICATION_ADMISSION_HANDOFF");
  requirePublication(admission.schemaVersion === 1 && admission.status === "passed"
    && admission.planSha256 === state.planSha256 && admission.provenance?.status === "passed",
  "PUBLICATION_ADMISSION_HANDOFF");
  return admission;
}

async function admittedPublicationNotes(root, plan) {
  const raw = await publicationFile(join(root, "admission/input/notes.md"), 1024 * 1024);
  requirePublication(sha256(raw) === plan.github.notesSha256, "PUBLICATION_NOTES_CHANGED");
  return new TextDecoder("utf-8", { fatal: true }).decode(raw);
}

export async function awaitBootstrapOutcome(root, state, environment) {
  requirePublication(state.plan.npm.mode === "bootstrap", "PUBLICATION_NPM_MODE");
  await state.fresh();
  const observed = await pendingPublicationObservation({ ...state, issue: environment.TABGRAD_RECEIPT_ISSUE });
  await savePublicationJson(join(root, "public-output/bootstrap.json"), { receipt: observed.value, original: observed.original });
  return { status: "human-reconciliation-received" };
}

function knownEffects(replay) {
  return new Set(replay.operations.flatMap(operation => operation.calls
    .filter(call => call.outcome === "verified-effect").map(call => call.intent.effect)));
}

async function currentPublicationIntent(root, state, admission, environment) {
  const authority = await state.fresh();
  const scope = publicationGateScope(state.plan, state.context, admission.handoff);
  requireGateAuthority(scope, authority);
  requirePublication(state.context.repositoryId === state.policy.repositoryId, "PUBLICATION_GATE_REPOSITORY_CONTEXT");
  const base = await configAndHead(root, state, environment);
  const replay = await releaseRecord({ command: "read", ...base });
  requireNpmIntent(state.plan, replay, admission.handoff, authority);
  return { scope, replay };
}

async function preparedPublicationReady(root, state, admission) {
  const scope = publicationGateScope(state.plan, state.context, admission.handoff);
  const raw = await publicationFile(join(root, "public-output/ready.json"), 65536);
  return { scope, raw, value: readGatePacket(raw, scope, "ready", sha256(raw)) };
}

async function retainNpmPreparationFailure(root, state, admission, failure) {
  const receipt = npmCallReceipt(state.plan, admission.handoff,
    { manifestSha256: state.plan.publisher.clientSha256 }, undefined, failure);
  if (failure.dispatched === null) receipt.dispatched = null;
  const original = { code: failure.code ?? null, dispatched: failure.dispatched,
    diagnostic: failure.privateClientEvidence ?? failure.privateHttpEvidence ?? null };
  receipt.receiptSha256 = sha256(canonicalBytes(original));
  receipt.cleanup = "completed"; // No publishing credential directory was created.
  await savePublicationJson(join(root, "private/npm-call.json"), original);
  await savePublicationJson(join(root, "public-output/npm-receipt.json"), receipt);
}

/** One job prepares once; its later execution still reidentifies the selected client. */
export async function prepareNpmPublication(root, state, material, admission, environment,
  { identifyClient = identifyPublicationClient, registry = publicationRegistry() } = {}) {
  requirePublication(state.plan.npm.mode === "oidc", "PUBLICATION_NPM_MODE");
  await mkdir(join(root, "gate"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "private"), { recursive: true, mode: 0o700 });
  await claimGateSession(join(root, "private/preparation-attempt"));
  await savePublicationJson(join(root, "public-output/npm-call-started.json"), { planSha256: state.planSha256,
    call: admission.handoff.call });
  let failure, admitted = false;
  try {
    await currentPublicationIntent(root, state, admission, environment);
    admitted = true;
    await identifyClient(environment.TABGRAD_PUBLICATION_CLIENT, state.plan.publisher.clientSha256,
      { timeoutMs: 15000, maxOutputBytes: 1024 * 1024 });
    await registry.inspect(state.plan, "before");
    const { scope } = await currentPublicationIntent(root, state, admission, environment);
    requireGateWindow(scope, Date.now());
    const raw = gateReady(scope);
    await writeFile(join(root, "public-output/ready.json"), raw, { flag: "wx", mode: 0o600 });
    await output({ ready_sha: sha256(raw) }, environment);
    return { status: "prepared", readySha256: sha256(raw) };
  } catch (error) { failure = error; failure.dispatched = admitted ? false : null; }
  await retainNpmPreparationFailure(root, state, admission, failure);
  throw failure;
}

export async function selectPublicationGate(root, state, admission, environment, kind) {
  let admitted = false;
  try {
    const { scope } = await currentPublicationIntent(root, state, admission, environment);
    admitted = true;
    const selection = await selectGatePacket({ scope, kind, api: state.api });
    await mkdir(join(root, "gate"), { recursive: true, mode: 0o700 });
    await savePublicationJson(join(root, "gate", `${kind}-selection.json`), selection);
    await output({ packet_id: selection.artifact.id, packet_digest: selection.artifact.zipSha256,
      packet_sha: selection.proof.rawSha256 }, environment);
    return { status: "selected", kind };
  } catch (error) {
    if (kind === "permission") {
      // Claim the execution slot before asserting no dispatch. A prior claimant
      // may already have called even if this wait failed before inspecting it.
      try { await claimGateSession(join(root, "private/call-attempt")); error.dispatched = admitted ? false : null; }
      catch { error.dispatched = null; }
      await retainNpmPreparationFailure(root, state, admission, error);
    }
    throw error;
  }
}

/** Trusted GitHub role. Client preparation precedes all destination checks here. */
export async function permitPreparedPublication(root, state, material, admission, environment) {
  const { scope } = await currentPublicationIntent(root, state, admission, environment);
  const selection = await readPublicationJson(join(root, "gate/ready-selection.json"));
  const received = await receiveGatePacket(join(root, "received-ready"), state.api, scope, "ready", selection);
  const { replay } = await currentPublicationIntent(root, state, admission, environment);
  const current = await state.api.state(state.plan, new Map(state.plan.github.assets.map(asset => [asset.name, asset])),
    { forceAssetReads: true });
  const { checkPublicationGithubState } = await import("./publication-effects.mjs");
  checkPublicationGithubState(state.plan, current, knownEffects(replay), material.notes);
  await recheckGateSelection(state.api, scope, "ready", selection);
  await currentPublicationIntent(root, state, admission, environment);
  requireGateWindow(scope, Date.now());
  const raw = gatePermission(scope, received.raw);
  await writeFile(join(root, "public-output/permission.json"), raw, { flag: "wx", mode: 0o600 });
  await output({ permission_sha: sha256(raw) }, environment);
  return { status: "permission-issued", permissionSha256: sha256(raw) };
}

export async function relayBootstrapReadiness(root, state, admission, environment) {
  requirePublication(state.plan.npm.mode === "bootstrap", "PUBLICATION_NPM_MODE");
  const { scope } = await currentPublicationIntent(root, state, admission, environment);
  const observed = await pendingPublicationObservation({ ...state, issue: environment.TABGRAD_RECEIPT_ISSUE, kind: "bootstrap-ready" });
  readGatePacket(observed.raw, scope, "ready", sha256(observed.raw));
  await currentPublicationIntent(root, state, admission, environment);
  requireGateWindow(scope, Date.now());
  await writeFile(join(root, "public-output/ready.json"), observed.raw, { flag: "wx", mode: 0o600 });
  await savePublicationJson(join(root, "public-output/readiness-attribution.json"), observed.original);
  await output({ ready_sha: sha256(observed.raw) }, environment);
  return { status: "attributed-readiness-received" };
}

export async function freshHumanPublication(root, state, admission, environment) {
  await currentPublicationIntent(root, state, admission, environment);
  const jobs = await state.api.request(`/actions/runs/${state.context.runId}/attempts/${state.context.attempt}/jobs?per_page=100`);
  requirePublication(jobs.total_count <= 100 && Array.isArray(jobs.jobs)
    && jobs.jobs.filter(job => job.name === roleNames.bootstrap && job.status === "in_progress"
      && job.conclusion === null && String(job.run_id) === state.context.runId
      && job.head_sha === state.context.revision).length === 1, "PUBLICATION_BOOTSTRAP_WINDOW_CLOSED");
}

/** A live child has completed its namespace reads before this callback is invoked. */
export async function authorizeHumanPublication(root, state, admission, environment, { nonce, signal }) {
  await freshHumanPublication(root, state, admission, environment);
  const scope = publicationGateScope(state.plan, state.context, admission.handoff), raw = gateReady(scope, nonce);
  await writeFile(join(root, "public-output/ready.json"), raw, { flag: "wx", mode: 0o600 });
  const prefix = `tabgrad-release-bootstrap-ready ${state.planSha256} ${state.plan.operation} ${state.context.runId}/${state.context.attempt}\n`;
  await writeFile(join(root, "public-output/readiness-comment.txt"), Buffer.concat([Buffer.from(prefix), raw]),
    { flag: "wx", mode: 0o600 });
  const received = await corroborateExpectedPermission(state.api, scope, raw, { signal });
  await freshHumanPublication(root, state, admission, environment);
  requirePublication(!signal.aborted, "PUBLICATION_HUMAN_CANCELED");
  const consumption = consumeGatePermission({ scope, readyRaw: raw, received, clock: Date.now });
  const evidence = { permissionSha256: sha256(received.raw), readiness: JSON.parse(raw), permission: JSON.parse(received.raw),
    input: received.input, selection: { proof: received.proof, artifact: received.artifact }, consumption,
  };
  await savePublicationJson(join(root, "public-output/gate-evidence.json"), evidence);
  await savePublicationJson(join(root, "private/human-observations.json"), state.api.observations);
  return evidence;
}

export async function executeNpm(root, state, material, admission, environment,
  { identifyClient = identifyPublicationClient, publish = publishNpmArchive } = {}) {
  const { plan } = state;
  let client = { manifestSha256: plan.publisher.clientSha256 }, privateDirectory;
  let result, failure, gateEvidence, called = false, admitted = false;
  try {
      await claimGateSession(join(root, "private/call-attempt"));
      await currentPublicationIntent(root, state, admission, environment); admitted = true;
      const prepared = await preparedPublicationReady(root, state, admission);
      const selection = await readPublicationJson(join(root, "gate/permission-selection.json"));
      const received = await receiveGatePacket(join(root, "received-permission"), state.api, prepared.scope, "permission", selection);
      await currentPublicationIntent(root, state, admission, environment);
      client = await identifyClient(environment.TABGRAD_PUBLICATION_CLIENT, plan.publisher.clientSha256,
        { timeoutMs: 15000, maxOutputBytes: 1024 * 1024 });
      privateDirectory = await mkdtemp(join(tmpdir(), "tabgrad-publication-npm-role-"));
      await currentPublicationIntent(root, state, admission, environment);
      const consumption = consumeGatePermission({ scope: prepared.scope, readyRaw: prepared.raw, received, clock: Date.now });
      gateEvidence = { ready: JSON.parse(prepared.raw), permission: JSON.parse(received.raw),
        selection, consumption };
      await savePublicationJson(join(root, "public-output/gate-evidence.json"), gateEvidence);
      requireGateWindow(prepared.scope, Date.now());
      called = true;
      result = await publish({ client, archive: material.archive, proof: material.proof,
        directory: privateDirectory, registry: plan.npm.registry, channel: plan.npm.channel,
        authentication: { kind: "oidc", environment }, timeoutMs: Math.min(120000, Date.parse(plan.window.deadline) - Date.now()) });
  } catch (error) { failure = error; if (!called) failure.dispatched = admitted ? false : null; }
  const receipt = npmCallReceipt(plan, admission.handoff, client, result, failure);
  if (failure?.dispatched === null) receipt.dispatched = null;
  // Originals are a private diagnostic, outside every workflow artifact path.
  // Their VM lifetime is not a permanent private-custody guarantee.
  try {
    await mkdir(join(root, "private"), { recursive: true, mode: 0o700 });
    const original = { client: result ?? failure?.privateClientEvidence ?? { code: failure?.code, dispatched: failure?.dispatched },
      gate: gateEvidence ?? null, observations: state.api.observations };
    receipt.receiptSha256 = sha256(canonicalBytes(original));
    await savePublicationJson(join(root, "private/npm-call.json"), original);
  } catch (error) { failure ??= error; }
  finally {
    try { if (privateDirectory) await rm(privateDirectory, { recursive: true, force: true }); receipt.cleanup = "completed"; }
    catch (error) { failure ??= error; receipt.cleanup = "failed"; }
  }
  receipt.status = !failure && receipt.outcome === "verified-effect" && receipt.cleanup === "completed" ? "passed" : "failed";
  await savePublicationJson(join(root, "public-output/npm-receipt.json"), receipt);
  await output({ receipt_sha: sha256(canonicalBytes(receipt)) }, environment);
  if (receipt.outcome !== "verified-effect" || failure) throw new PublicationError("PUBLICATION_NPM_NOT_CONFIRMED");
  return receipt;
}

export function publicationConsumerArguments(root, plan) {
  return [join(repository, "scripts/run-package-browser-tests.mjs"), "--registry-plan", join(root, "input/registry.json"),
    "--expected", join(root, "data/candidate.json"), "--browsers", plan.qualification.browsers.join(",")];
}

async function consumerReport(root, state, environment) {
  const registryPlan = { schemaVersion: 1, registry: state.plan.npm.registry, channel: state.plan.npm.channel,
    allowedOrigins: [state.plan.npm.registry], clientTimeoutMs: 30000, maxClientOutputBytes: 1024 * 1024 };
  const path = join(root, "input/registry.json"); await savePublicationJson(path, registryPlan);
  const child = await runPublicationProcess(process.execPath,
    publicationConsumerArguments(root, state.plan),
    { directory: repository, environment: registryEnvironment(root, environment),
      timeoutMs: Math.max(1, Math.min(600000, Date.parse(state.plan.window.deadline) - Date.now())), maxOutputBytes: 4 * 1024 * 1024 });
  const reports = [JSON.parse(child.stdout)];
  if (state.plan.qualification.gpu) {
    const observed = await pendingPublicationObservation({ ...state, issue: environment.TABGRAD_RECEIPT_ISSUE, kind: "gpu-consumers" });
    reports.push(observed.value);
  }
  return reports;
}

/** Read-only post-result checks; retain safe diagnostics even without a success handoff. */
export async function verifyPublishedConsumerResult(root, { plan, candidate, proof, registry, report, clock = Date.now }) {
  let phase = "registry", status = "failed", code = null, consumerFailure = null;
  try {
    await registry.waitForPublished(plan, Math.min(Date.parse(plan.window.deadline), clock() + 600000));
    phase = "provenance";
    const association = await registry.associateOriginalProof(plan, proof);
    phase = "consumers";
    const reports = await report();
    phase = "admission";
    const result = admitPublishedConsumers({ plan, candidate, reports, association });
    await savePublicationJson(join(root, "public-output/consumers.json"), result);
    status = "passed";
    return { status: "published-consumers-verified" };
  } catch (error) {
    code = /^PUBLICATION_[A-Z_]+$/.test(error.code ?? "") ? error.code : "PUBLICATION_CONSUMER_CHECK_FAILED";
    const raw = error.privateClientEvidence?.stdout;
    if (phase === "consumers" && typeof raw === "string" && Buffer.byteLength(raw) <= 4 * 1024 * 1024) {
      try {
        const result = JSON.parse(raw), failure = result.failure;
        if (result.schemaVersion === 1 && result.input === "registry-version" && result.status === "failed"
          && typeof failure?.phase === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(failure.phase)
          && typeof failure.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(failure.code)) {
          consumerFailure = { phase: failure.phase, code: failure.code };
        }
      } catch { /* Unrecognized child output supplies no public diagnostic fields. */ }
    }
    throw error;
  } finally {
    const keys = ["at", "urlSha256", "status", "sha256", "receivedBytes", "phase", "selectedVersionPresent", "exactVersion",
      "selectedVersionUsed", "withdrawn", "channel", "state"];
    const observations = registry.observations.slice(0, 64).map(row =>
      Object.fromEntries(keys.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])));
    await savePublicationJson(join(root, "public-output/consumer-diagnostics.json"), {
      schemaVersion: 1, status, phase, code, consumerFailure, planSha256: sha256(canonicalBytes(plan)),
      observations, omittedObservations: Math.max(0, registry.observations.length - observations.length),
    });
  }
}

async function observeNpmRole(root, state, admission, environment) {
  const { plan } = state;
  await state.conserve();
  const base = await configAndHead(root, state, environment);
  if (plan.npm.mode === "observe") {
    const replay = await releaseRecord({ command: "read", ...base });
    requirePublicationRecordAdmission(plan, replay, admission.authorityObservation);
    requirePublication(blockingRecordCalls(replay) === 0 && replay.checkpoint.conflictingCalls === 0
      && knownEffects(replay).has(publicationEffects(plan)[0].identity), "PUBLICATION_NPM_OUTCOME_UNPROVEN");
    return { status: "verified-existing-npm" };
  }
  const bootstrap = plan.npm.mode === "bootstrap";
  let receipt;
  {
    try { receipt = bootstrap ? (await readPublicationJson(join(root, "npm-result/bootstrap.json"), 65536)).receipt
      : await readPublicationJson(join(root, "npm-result/npm-receipt.json")); }
    catch { receipt = { schemaVersion: 1, status: "failed", cleanup: "unobserved", operation: plan.operation, planSha256: state.planSha256,
      call: admission.handoff.call, effect: admission.handoff.effect, clientSha256: plan.publisher.clientSha256,
      dispatched: null, outcome: "unknown", receiptSha256: sha256(canonicalBytes({ code: "PUBLICATION_NPM_JOB_UNOBSERVED" })),
      code: "PUBLICATION_NPM_JOB_UNOBSERVED" }; }
  }
  const recorded = await recordNpmPublication({ plan, ...base, handoff: admission.handoff, receipt,
    authorityObservation: admission.authorityObservation, directory: join(root, "evidence"),
    basis: bootstrap ? "reconciliation" : "call", authenticateReceipt: async () => {
      await corroboratePublicationJob(state.api, state.context, bootstrap ? roleNames.bootstrap : roleNames.npm,
        environment.TABGRAD_NPM_JOB_RESULT);
      if (receipt.code !== "PUBLICATION_NPM_JOB_UNOBSERVED") {
        await corroboratePublicationOutput(state.api, state.context, environment.TABGRAD_NPM_RESULT_ID,
          environment.TABGRAD_NPM_RESULT_DIGEST, `tabgrad-publication-npm-${state.context.runId}-${state.context.attempt}`, plan.window.deadline);
      }
    } });
  requirePublication(recorded.outcome === "verified-effect" && receipt.status === "passed", "PUBLICATION_NPM_NOT_CONFIRMED");
  return { status: recorded.outcome, head: recorded.head };
}

/** Real role bindings; no fixture origin, fake credential or injected success on this CLI. */
export async function publicationRole(command, root, environment = process.env) {
  requirePublication(commands.includes(command), "PUBLICATION_USAGE");
  const state = await request(root, environment, command === "human", command === "observe", command);
  const { plan } = state;
  if (command !== "human" && !metadataCommands.includes(command)) await stageRequest(root, environment, plan);
  await mkdir(join(root, "public-output"), { recursive: true, mode: 0o700 });
  if (command === "precheck") {
    await observePublicationPrecheck(state); await observePublicationProducer(state.api, plan); await state.api.prerequisites(plan);
    requirePublication(plan.producer.verification.identity.workflowPath === producerWorkflow, "PUBLICATION_PRODUCER_PROFILE");
    await output({ data_id: plan.producer.data.id, proofs_id: plan.producer.proofs.id,
      producer_run: plan.producer.verification.identity.runId, verification_id: plan.producer.corroboration.id,
      history_id: state.policy.history.id, history_run: state.policy.history.runId,
      mode: plan.npm.mode, approval: publicationApprovalComment(plan, state.planSha256, state.context) }, environment);
    if (environment.GITHUB_STEP_SUMMARY) await appendFile(environment.GITHUB_STEP_SUMMARY,
      `## Publication awaiting separate approval\n\nCandidate: ${plan.candidate.name}@${plan.candidate.version}\n\n`
      + `Plan SHA-256: \`${state.planSha256}\`\n\nReview the approved original files and use exactly this comment in the environment review:\n\n`
      + `\`${publicationApprovalComment(plan, state.planSha256, state.context)}\`\n`);
    return { status: "unapproved-precheck", planSha256: state.planSha256 };
  }
  if (command === "observe") return observeNpmRole(root, state, await acceptedAdmission(root, state, environment), environment);
  if (metadataCommands.includes(command)) {
    const admission = await acceptedAdmission(root, state, environment);
    if (command === "select-ready") return selectPublicationGate(root, state, admission, environment, "ready");
    if (command === "select-permission") return selectPublicationGate(root, state, admission, environment, "permission");
    if (command === "bootstrap-ready") return relayBootstrapReadiness(root, state, admission, environment);
    if (command === "bootstrap") return awaitBootstrapOutcome(root, state, environment);
    requirePublication(command === "permit", "PUBLICATION_USAGE");
    return permitPreparedPublication(root, state, { notes: await admittedPublicationNotes(root, plan) }, admission, environment);
  }
  const locations = await inputLocations(root, plan, environment);
  if (command === "admit") {
    await state.fresh();
    const material = await admitPublicationInputs(locations);
    await retainAuthority(root, plan);
    const authorityObservation = await state.fresh();
    const record = await publicationRecord({ ...await configAndHead(root, state, environment), policy: state.policy, plan, authorityObservation,
      directory: join(root, "evidence") });
    const registry = publicationRegistry();
    const handoff = await prepareNpmCall({ plan, record, fresh: state.fresh,
      inspectNpm: mode => plan.npm.mode === "bootstrap" ? Promise.resolve({ status: "requires-qualified-human-read" })
        : registry.inspect(plan, plan.npm.mode === "observe" ? "after" : mode),
      inspectGithub: () => state.api.state(plan, new Map(plan.github.assets.map(asset => [asset.name, asset])), { forceAssetReads: true }),
      notes: material.notes });
    const journal = await releaseRecord({ command: "read", config: record.config, expectedHead: record.head });
    const admission = { ...material.admission, handoff, journal, context: state.context, authorityObservation };
    await savePublicationJson(join(root, "public-output/admission.json"), admission);
    await mkdir(join(root, "public-output/input"), { mode: 0o700 });
    for (const name of ["plan.json", "notes.md", "qualification.json", "producer-evidence.json", "release-checksums.txt"]) {
      await cp(join(root, "input", name), join(root, "public-output/input", name), { errorOnExist: true, force: false });
    }
    await output({ admission_sha: sha256(canonicalBytes(admission)), record_head: record.head }, environment);
    return { status: "admitted", planSha256: state.planSha256, npm: handoff === null ? "already-confirmed" : plan.npm.mode };
  }
  const admission = command === "human" ? await readPublicationJson(join(root, "admission/admission.json"), 4 * 1024 * 1024)
    : await acceptedAdmission(root, state, environment);
  if (command === "human") requirePublication(sha256(canonicalBytes(admission)) === environment.TABGRAD_HUMAN_ADMISSION_SHA256
    && plan.npm.mode === "bootstrap", "PUBLICATION_HUMAN_ADMISSION_REQUIRED");
  const material = await recheckPublicationInputs(locations, admission);
  if (command === "npm-prepare") return prepareNpmPublication(root, state, material, admission, environment);
  if (command === "human") {
    await writeFile(join(root, "public-output/npm-call-started.json"), canonicalBytes({ planSha256: state.planSha256,
      call: admission.handoff.call }), { flag: "wx", mode: 0o600 });
    const result = await runHumanPublisher({ root, plan, admission, environment,
      fresh: () => freshHumanPublication(root, state, admission, environment),
      authorizeReady: ready => authorizeHumanPublication(root, state, admission, environment, ready),
      cancelPending: state.cancelObservations });
    await savePublicationJson(join(root, "public-output/npm-receipt.json"), result.receipt);
    requirePublication(result.status === "completed" && result.receipt.outcome === "verified-effect", "PUBLICATION_NPM_NOT_CONFIRMED");
    return result.receipt;
  }
  if (command === "npm") {
    requirePublication(plan.npm.mode === "oidc", "PUBLICATION_NPM_MODE");
    return executeNpm(root, state, material, admission, environment);
  }
  if (command === "consume") {
    await state.fresh(); await corroboratePublicationJob(state.api, state.context, roleNames.observe);
    return verifyPublishedConsumerResult(root, { plan, candidate: material.candidate, proof: material.proof,
      registry: publicationRegistry(), report: () => consumerReport(root, state, environment) });
  }
  requirePublication(command === "complete", "PUBLICATION_USAGE");
  await state.fresh(); await corroboratePublicationJob(state.api, state.context, roleNames.consume);
  if (plan.npm.mode !== "observe") await corroboratePublicationJob(state.api, state.context, gateRoles.observer);
  await corroboratePublicationOutput(state.api, state.context, environment.TABGRAD_CONSUMERS_ID,
    environment.TABGRAD_CONSUMERS_DIGEST, `tabgrad-publication-consumers-${state.context.runId}-${state.context.attempt}`, plan.window.deadline);
  const consumers = await readPublicationJson(join(root, "consumers/consumers.json"), 4 * 1024 * 1024);
  const verified = admitPublishedConsumers({ plan, candidate: material.candidate, reports: consumers.reports, association: consumers.association });
  const record = await publicationRecord({ ...await configAndHead(root, state, environment), policy: state.policy, plan,
    authorityObservation: await state.fresh(),
    directory: join(root, "evidence") });
  const registry = publicationRegistry();
  const result = await completeGithubPublication({ plan, record, fresh: state.fresh, notes: material.notes,
    inspectNpm: mode => registry.inspect(plan, mode),
    inspectGithub: effect => state.api.state(plan, new Map(plan.github.assets.map(asset => [asset.name, asset])),
      { forceAssetReads: effect === undefined }),
    write: (effect, current) => state.api.write(effect, plan, current, material.assets.get(effect.asset?.name), material.notes),
    verifyRegistry: async () => { await registry.associateOriginalProof(plan, material.proof); return verified; } });
  await savePublicationJson(join(root, "public-output/completion.json"), result);
  return result;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result;
  try {
    requirePublication(process.argv.length === 4, "PUBLICATION_USAGE");
    result = await publicationRole(process.argv[2], resolve(process.argv[3]));
  } catch (error) {
    result = { schemaVersion: 1, status: "failed", code: error.code ?? "PUBLICATION_ROLE_FAILED" };
    if (error.receipt) result.recordReceipt = Object.fromEntries(["status", "attemptedCommit", "priorHead", "pushExit", "pushSignal"]
      .filter(key => Object.hasOwn(error.receipt, key)).map(key => [key, error.receipt[key]]));
    process.exitCode = 1;
  }
  // A failed append may already have reached Git. Preserve available originals
  // without turning failed conservation into authority to retry/reset anything.
  if (["admit", "observe", "complete"].includes(process.argv[2])) {
    const root = resolve(process.argv[3]);
    try {
      const source = join(root, "evidence");
      await transferPublicationHistory(source, join(root, "public-output/evidence"));
      await savePublicationJson(join(root, "public-output/role-result.json"), result);
    } catch { result = { ...result, status: "failed", conservation: "unconfirmed" }; process.exitCode = 1; }
  }
  if (process.argv.length === 4 && process.argv[2] === "consume" && process.env.TABGRAD_PUBLICATION_ENABLED === "true"
    && process.env.TABGRAD_PUBLICATION_CONFIRMATION === "release-publication") {
    try {
      const directory = join(resolve(process.argv[3]), "public-output");
      const stat = await lstat(directory);
      requirePublication(stat.isDirectory() && !stat.isSymbolicLink(), "PUBLICATION_OUTPUT_INVALID");
      await savePublicationJson(join(directory, "role-result.json"), result);
    } catch (error) {
      // An inert/rejected request must not create an output directory.
      if (error.code !== "ENOENT") { result = { ...result, status: "failed", conservation: "unconfirmed" }; process.exitCode = 1; }
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
