import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { publicationEnvironment, identifyPublicationClient } from "./publication-client.mjs";
import { inspectBootstrapNamespace, prepareNpmRole, publishNpmArchive } from "./publication-npm.mjs";
import { publicationFile } from "./publication-admission.mjs";
import { npmCallReceipt, requireNpmCallReceipt, requireNpmIntent } from "./publication-effects.mjs";
import { canonicalBytes, sha256 } from "./release-record-data.mjs";
import { PublicationError, requirePublication, validatePublicationPlan } from "./publication-plan.mjs";

/**
 * The trusted human controller reads GitHub; this separate client receives only
 * npm's explicit private configuration. After npm's reads it asks the controller
 * to revalidate live authority/destinations immediately before the write.
 */
export async function runHumanPublisher({ root, plan, admission, environment, fresh }) {
  // Reject stale authority before creating a credential-bearing child at all,
  // then check again after its namespace reads, immediately before dispatch.
  await fresh();
  requirePublication(Date.now() < Date.parse(plan.window.deadline), "PUBLICATION_WINDOW_EXPIRED");
  const childEnvironment = publicationEnvironment(root, environment);
  for (const key of ["TABGRAD_PUBLICATION_CLIENT", "TABGRAD_HUMAN_NPMRC", "TABGRAD_HUMAN_READER", "TABGRAD_HUMAN_READER_SHA256"]) {
    if (typeof environment[key] === "string") childEnvironment[key] = environment[key];
  }
  const child = fork(fileURLToPath(import.meta.url), ["--client"], { execPath: process.execPath, cwd: root,
    execArgv: [], env: childEnvironment, stdio: ["inherit", "ignore", "inherit", "ipc"] });
  let receipt, failure, pendingFresh, ready = false;
  const cancel = () => { if (child.connected) child.send({ kind: "cancel" }); };
  const timer = setTimeout(cancel, Math.max(1, Date.parse(plan.window.deadline) - Date.now()));
  const lastResort = setTimeout(() => child.kill("SIGKILL"), Math.max(1, Date.parse(plan.window.deadline) - Date.now()) + 5000);
  child.on("error", error => { failure ??= error; });
  child.on("message", message => {
    if (message?.kind === "receipt") {
      try { requireNpmCallReceipt(plan, admission.handoff, message.receipt); receipt = message.receipt; }
      catch (error) { failure ??= error; cancel(); }
    } else if (message?.kind === "ready" && !ready) {
      ready = true;
      pendingFresh = (async () => {
        try {
          await fresh();
          requirePublication(Date.now() < Date.parse(plan.window.deadline), "PUBLICATION_WINDOW_EXPIRED");
          if (child.connected) child.send({ kind: "publish-approved" });
        } catch (error) { failure ??= error; cancel(); }
      })();
    } else { failure ??= new PublicationError("PUBLICATION_HUMAN_CHANNEL"); cancel(); }
  });
  child.send({ kind: "start", root, planSha256: sha256(canonicalBytes(plan)), admissionSha256: sha256(canonicalBytes(admission)) });
  const exit = await new Promise(resolve => child.once("close", (status, signal) => resolve({ status, signal })));
  clearTimeout(timer); clearTimeout(lastResort);
  await pendingFresh;
  if (!receipt) receipt = { schemaVersion: 1, status: "failed", cleanup: "unobserved", operation: plan.operation, planSha256: sha256(canonicalBytes(plan)),
    call: admission.handoff.call, effect: admission.handoff.effect, clientSha256: plan.publisher.clientSha256,
    dispatched: null, outcome: "unknown", receiptSha256: sha256(canonicalBytes(exit)), code: "PUBLICATION_HUMAN_CLIENT_UNOBSERVED" };
  return { receipt, status: failure || exit.status !== 0 || receipt.status !== "passed" ? "failed" : "completed" };
}

async function humanClient(message) {
  requirePublication(message?.kind === "start" && process.send && !process.env.GH_TOKEN && !process.env.GITHUB_TOKEN
    && !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, "PUBLICATION_HUMAN_CHANNEL");
  const rawPlan = await publicationFile(join(message.root, "input/plan.json"), 65536);
  const rawAdmission = await publicationFile(join(message.root, "admission/admission.json"), 4 * 1024 * 1024);
  requirePublication(sha256(rawPlan) === message.planSha256 && sha256(rawAdmission) === message.admissionSha256,
    "PUBLICATION_HUMAN_INPUT_CHANGED");
  const plan = validatePublicationPlan(JSON.parse(rawPlan)), admission = JSON.parse(rawAdmission);
  requireNpmIntent(plan, admission.journal, admission.handoff, admission.authorityObservation);
  const controller = new AbortController();
  const disconnected = () => controller.abort();
  process.once("disconnect", disconnected);
  process.on("error", disconnected);
  const client = await identifyPublicationClient(process.env.TABGRAD_PUBLICATION_CLIENT, plan.publisher.clientSha256,
    { timeoutMs: 15000, maxOutputBytes: 1024 * 1024 });
  const directory = await mkdtemp(join(tmpdir(), "tabgrad-human-npm-"));
  let result, failure, called = false;
  try {
    const archive = await publicationFile(join(message.root, "data", admission.candidate.tarball.path), admission.candidate.tarball.byteLength);
    const proof = await publicationFile(join(message.root, "proofs/archive-proof.json"), 16 * 1024 * 1024);
    requirePublication(createHash("sha512").update(archive).digest("hex") === plan.candidate.archiveSha512
      && sha256(proof) === plan.producer.archiveProofSha256, "PUBLICATION_HUMAN_INPUT_CHANGED");
    const archivePath = join(directory, "approved.tgz"), proofPath = join(directory, "original-proof.json");
    await writeFile(archivePath, archive, { flag: "wx", mode: 0o400 });
    await writeFile(proofPath, proof, { flag: "wx", mode: 0o400 });
    const role = await prepareNpmRole({ directory, registry: plan.npm.registry,
      authentication: { kind: "human", userconfig: process.env.TABGRAD_HUMAN_NPMRC } });
    const reader = JSON.parse(await publicationFile(process.env.TABGRAD_HUMAN_READER, 65536));
    await inspectBootstrapNamespace({ client, role, plan, reader,
      expectedReaderSha256: process.env.TABGRAD_HUMAN_READER_SHA256, signal: controller.signal });
    await new Promise((resolve, reject) => {
      const abort = () => { cleanup(); reject(new PublicationError("PUBLICATION_HUMAN_CANCELED")); };
      const reply = value => {
        if (value?.kind === "publish-approved") { cleanup(); resolve(); }
        else if (value?.kind === "cancel") controller.abort();
        else { cleanup(); reject(new PublicationError("PUBLICATION_HUMAN_CHANNEL")); }
      };
      const cleanup = () => { process.off("message", reply); controller.signal.removeEventListener("abort", abort); };
      process.on("message", reply); controller.signal.addEventListener("abort", abort, { once: true });
      if (controller.signal.aborted) abort();
      else process.send({ kind: "ready" }, error => { if (error) controller.abort(); });
    });
    requirePublication(Date.now() < Date.parse(plan.window.deadline) && Date.now() < Date.parse(reader.expiresAt),
      "PUBLICATION_WINDOW_EXPIRED");
    called = true;
    result = await publishNpmArchive({ client, role, archive: archivePath, proof: proofPath, channel: plan.npm.channel,
      timeoutMs: Math.min(120000, Date.parse(plan.window.deadline) - Date.now(), Date.parse(reader.expiresAt) - Date.now()),
      signal: controller.signal });
  } catch (error) { failure = error; if (!called) failure.dispatched = false; }
  const receipt = npmCallReceipt(plan, admission.handoff, client, result, failure);
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
  if (process.connected) { process.send({ kind: "receipt", receipt }); process.disconnect(); }
  if (failure) process.exitCode = 1;
}

if (process.argv[2] === "--client" && process.send) {
  process.once("message", message => {
    void humanClient(message).catch(() => { process.exitCode = 1; if (process.connected) process.disconnect(); });
  });
}
