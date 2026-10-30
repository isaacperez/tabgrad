import { fork } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { publicationEnvironment, identifyPublicationClient, publicationTerminalStdio } from "./publication-client.mjs";
import { inspectBootstrapNamespace, prepareNpmRole, publishNpmArchive } from "./publication-npm.mjs";
import { publicationFile } from "./publication-admission.mjs";
import { npmCallReceipt, requireNpmCallReceipt, requireNpmIntent } from "./publication-effects.mjs";
import { canonicalBytes, sha256 } from "./release-record-data.mjs";
import { exactPublicationKeys, PublicationError, requirePublication, validatePublicationPlan } from "./publication-plan.mjs";
import { claimGateSession } from "./publication-gate.mjs";

function launchHumanClient({ root, environment }) {
  return fork(fileURLToPath(import.meta.url), ["--client"], { execPath: process.execPath, cwd: root,
    execArgv: [], env: environment, stdio: [...publicationTerminalStdio(), "ipc"] });
}

/**
 * The trusted human controller reads GitHub; this separate client receives only
 * npm's explicit private configuration. After npm's reads it asks the controller
 * to revalidate live authority/destinations immediately before the write.
 */
export async function runHumanPublisher({ root, plan, admission, environment, fresh, authorizeReady,
  cancelPending = () => {}, launch = launchHumanClient }) {
  // Reject stale authority before creating a credential-bearing child at all,
  // then check again after its namespace reads, immediately before dispatch.
  await fresh();
  requirePublication(Date.now() < Date.parse(plan.window.deadline), "PUBLICATION_WINDOW_EXPIRED");
  requirePublication(typeof authorizeReady === "function", "PUBLICATION_HUMAN_APPROVAL_OWNER");
  await mkdir(join(root, "private"), { recursive: true, mode: 0o700 });
  await claimGateSession(join(root, "private/human-call-attempt"));
  const childEnvironment = publicationEnvironment(root, environment);
  for (const key of ["TABGRAD_PUBLICATION_CLIENT", "TABGRAD_HUMAN_NPMRC", "TABGRAD_HUMAN_READER", "TABGRAD_HUMAN_READER_SHA256"]) {
    if (typeof environment[key] === "string") childEnvironment[key] = environment[key];
  }
  const directory = await mkdtemp(join(tmpdir(), "tabgrad-human-npm-"));
  const session = randomBytes(32).toString("hex"), controller = new AbortController();
  let child;
  try { child = launch({ root, environment: childEnvironment }); }
  catch (error) {
    try { await rm(directory, { recursive: true, force: true }); } catch (cleanup) { error.cleanup = cleanup; }
    throw error;
  }
  let receipt, failure, pendingFresh, permissionEvidence, phase = "starting";
  const cancel = () => {
    controller.abort(); cancelPending();
    if (child.connected) child.send({ kind: "cancel", session }, () => {});
  };
  const timer = setTimeout(cancel, Math.max(1, Date.parse(plan.window.deadline) - Date.now()));
  const lastResort = setTimeout(() => child.kill("SIGKILL"), Math.max(1, Date.parse(plan.window.deadline) - Date.now()) + 5000);
  child.on("error", error => { failure ??= error; cancel(); });
  child.on("message", message => {
    if (message?.kind === "receipt") {
      try {
        requirePublication(exactPublicationKeys(message, ["kind", "session", "receipt"])
          && message.session === session && receipt === undefined, "PUBLICATION_HUMAN_CHANNEL");
        requireNpmCallReceipt(plan, admission.handoff, message.receipt);
        requirePublication(phase === "approved" || (message.receipt.outcome !== "verified-effect"
          && message.receipt.dispatched !== true), "PUBLICATION_HUMAN_EARLY_RECEIPT");
        receipt = message.receipt; phase = "finished";
      }
      catch (error) { failure ??= error; cancel(); }
    } else if (message?.kind === "ready" && phase === "starting"
      && exactPublicationKeys(message, ["kind", "session", "call", "clientSha256"])
      && message.session === session && message.call === admission.handoff.call
      && message.clientSha256 === plan.publisher.clientSha256) {
      phase = "observing";
      pendingFresh = (async () => {
        try {
          permissionEvidence = await authorizeReady({ nonce: session, signal: controller.signal });
          requirePublication(typeof permissionEvidence?.permissionSha256 === "string"
            && /^[0-9a-f]{64}$/.test(permissionEvidence.permissionSha256), "PUBLICATION_HUMAN_PERMISSION_EVIDENCE");
          requirePublication(Date.now() < Date.parse(plan.window.deadline), "PUBLICATION_WINDOW_EXPIRED");
          if (child.connected && !failure && !controller.signal.aborted && phase === "observing") {
            phase = "approved";
            child.send({ kind: "publish-approved", session }, error => { if (error) { failure ??= error; cancel(); } });
          }
        } catch (error) { failure ??= error; cancel(); }
      })();
    } else { failure ??= new PublicationError("PUBLICATION_HUMAN_CHANNEL"); cancel(); }
  });
  child.send({ kind: "start", root, directory, planSha256: sha256(canonicalBytes(plan)), admissionSha256: sha256(canonicalBytes(admission)), session },
    error => { if (error) { failure ??= error; cancel(); } });
  const exit = await new Promise(resolve => child.once("close", (status, signal) => {
    controller.abort(); cancelPending(); resolve({ status, signal });
  }));
  clearTimeout(timer); clearTimeout(lastResort);
  await pendingFresh;
  if (!receipt) receipt = { schemaVersion: 1, status: "failed", cleanup: "unobserved", operation: plan.operation, planSha256: sha256(canonicalBytes(plan)),
    call: admission.handoff.call, effect: admission.handoff.effect, clientSha256: plan.publisher.clientSha256,
    dispatched: null, outcome: "unknown", receiptSha256: sha256(canonicalBytes(exit)), code: "PUBLICATION_HUMAN_CLIENT_UNOBSERVED" };
  const clientReceipt = structuredClone(receipt);
  try { await rm(directory, { recursive: true, force: true }); receipt.cleanup = "completed"; }
  catch (error) { failure ??= error; receipt.cleanup = "failed"; receipt.status = "failed"; }
  const original = { exit, clientReceipt, cleanup: receipt.cleanup, permission: permissionEvidence ?? null };
  receipt.receiptSha256 = sha256(canonicalBytes(original));
  try { await writeFile(join(root, "private/human-session.json"), canonicalBytes(original), { flag: "wx", mode: 0o600 }); }
  catch (error) { failure ??= error; receipt.status = "failed"; }
  return { receipt, status: failure || exit.status !== 0 || receipt.status !== "passed" ? "failed" : "completed" };
}

async function awaitHumanApproval({ session, call, clientSha256, signal }) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { process.off("message", reply); signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(new PublicationError("PUBLICATION_HUMAN_CANCELED")); };
    const reply = value => {
      if (value?.kind === "publish-approved" && value.session === session
        && exactPublicationKeys(value, ["kind", "session"])) { cleanup(); resolve(); }
      else { cleanup(); reject(new PublicationError("PUBLICATION_HUMAN_CHANNEL")); }
    };
    process.on("message", reply); signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else process.send({ kind: "ready", session, call, clientSha256 }, error => { if (error) abort(); });
  });
}

/** Child process owner. Explicit I/O ports also support isolated local qualification. */
export async function runHumanClient(message, { identifyClient = identifyPublicationClient,
  prepareRole = prepareNpmRole, inspectNamespace = inspectBootstrapNamespace, publish = publishNpmArchive } = {}) {
  requirePublication(message?.kind === "start" && exactPublicationKeys(message,
    ["kind", "root", "directory", "planSha256", "admissionSha256", "session"])
    && typeof message.session === "string" && /^[0-9a-f]{64}$/.test(message.session)
    && typeof message.directory === "string" && isAbsolute(message.directory)
    && process.send && !process.env.GH_TOKEN && !process.env.GITHUB_TOKEN
    && !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, "PUBLICATION_HUMAN_CHANNEL");
  const controller = new AbortController();
  let waiting = false;
  const disconnected = () => controller.abort();
  const cancellation = value => {
    if (value?.kind === "cancel" && value.session === message.session && exactPublicationKeys(value, ["kind", "session"])) controller.abort();
    else if (!(waiting && value?.kind === "publish-approved" && value.session === message.session)) controller.abort();
  };
  process.once("disconnect", disconnected); process.on("error", disconnected); process.on("message", cancellation);
  const rawPlan = await publicationFile(join(message.root, "input/plan.json"), 65536);
  const rawAdmission = await publicationFile(join(message.root, "admission/admission.json"), 4 * 1024 * 1024);
  requirePublication(sha256(rawPlan) === message.planSha256 && sha256(rawAdmission) === message.admissionSha256,
    "PUBLICATION_HUMAN_INPUT_CHANGED");
  const plan = validatePublicationPlan(JSON.parse(rawPlan)), admission = JSON.parse(rawAdmission);
  requireNpmIntent(plan, admission.journal, admission.handoff, admission.authorityObservation);
  const owned = await lstat(message.directory);
  requirePublication(owned.isDirectory() && !owned.isSymbolicLink() && (owned.mode & 0o077) === 0,
    "PUBLICATION_HUMAN_DIRECTORY");
  let client = await identifyClient(process.env.TABGRAD_PUBLICATION_CLIENT, plan.publisher.clientSha256,
    { timeoutMs: 15000, maxOutputBytes: 1024 * 1024, signal: controller.signal });
  const directory = message.directory;
  let result, failure, readerTimer, called = false;
  try {
    const archive = await publicationFile(join(message.root, "data", admission.candidate.tarball.path), admission.candidate.tarball.byteLength);
    const proof = await publicationFile(join(message.root, "proofs/archive-proof.json"), 16 * 1024 * 1024);
    requirePublication(createHash("sha512").update(archive).digest("hex") === plan.candidate.archiveSha512
      && sha256(proof) === plan.producer.archiveProofSha256, "PUBLICATION_HUMAN_INPUT_CHANGED");
    const archivePath = join(directory, "approved.tgz"), proofPath = join(directory, "original-proof.json");
    await writeFile(archivePath, archive, { flag: "wx", mode: 0o400 });
    await writeFile(proofPath, proof, { flag: "wx", mode: 0o400 });
    const role = await prepareRole({ directory, registry: plan.npm.registry,
      authentication: { kind: "human", userconfig: process.env.TABGRAD_HUMAN_NPMRC } });
    const reader = JSON.parse(await publicationFile(process.env.TABGRAD_HUMAN_READER, 65536));
    await inspectNamespace({ client, role, plan, reader,
      expectedReaderSha256: process.env.TABGRAD_HUMAN_READER_SHA256, signal: controller.signal });
    readerTimer = setTimeout(() => controller.abort(), Math.max(1,
      Math.min(Date.parse(plan.window.deadline), Date.parse(reader.expiresAt)) - Date.now()));
    waiting = true;
    await awaitHumanApproval({ session: message.session, call: admission.handoff.call,
      clientSha256: client.manifestSha256, signal: controller.signal });
    waiting = false;
    client = await identifyClient(process.env.TABGRAD_PUBLICATION_CLIENT, plan.publisher.clientSha256,
      { timeoutMs: 15000, maxOutputBytes: 1024 * 1024, signal: controller.signal });
    requirePublication(Date.now() < Date.parse(plan.window.deadline) && Date.now() < Date.parse(reader.expiresAt),
      "PUBLICATION_WINDOW_EXPIRED");
    requirePublication(!controller.signal.aborted, "PUBLICATION_HUMAN_CANCELED");
    called = true;
    result = await publish({ client, role, archive: archivePath, proof: proofPath, channel: plan.npm.channel,
      timeoutMs: Math.min(120000, Date.parse(plan.window.deadline) - Date.now(), Date.parse(reader.expiresAt) - Date.now()),
      signal: controller.signal });
  } catch (error) { failure = error; if (!called) failure.dispatched = false; }
  clearTimeout(readerTimer);
  const receipt = npmCallReceipt(plan, admission.handoff, client, result, failure, "human-terminal-exit");
  try {
    await mkdir(join(message.root, "private"), { recursive: true, mode: 0o700 });
    await writeFile(join(message.root, "private/npm-call.json"), canonicalBytes(result ?? failure?.privateClientEvidence ?? { code: failure?.code }),
      { flag: "wx", mode: 0o600 });
  } catch (error) { failure ??= error; }
  finally {
    try { await rm(directory, { recursive: true, force: true }); receipt.cleanup = "completed"; }
    catch (error) { failure ??= error; receipt.cleanup = "failed"; }
  }
  receipt.status = !failure && receipt.outcome === "verified-effect" && receipt.cleanup === "completed" ? "passed" : "failed";
  process.off("disconnect", disconnected);
  process.off("error", disconnected);
  process.off("message", cancellation);
  if (process.connected) { process.send({ kind: "receipt", session: message.session, receipt }); process.disconnect(); }
  if (failure) process.exitCode = 1;
}

if (process.argv[2] === "--client" && process.send) {
  process.once("message", message => {
    void runHumanClient(message).catch(() => { process.exitCode = 1; if (process.connected) process.disconnect(); });
  });
}
