/** Collect before publication; publish only a separately inspected, already collected report. */
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, dirname, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalBytes, sha256 } from "./release-record-data.mjs";
import { requirePublication, validatePublicationPlan } from "./publication-plan.mjs";
import { publicationFile, validatePublicationQualification, validatePublicationPhysicalReport } from "./publication-admission.mjs";
import { readProducerInventory } from "./package-provenance.mjs";
import { runPublicationProcess } from "./publication-client.mjs";
import { registryEnvironment } from "./package-registry.mjs";
import { publicationGithub } from "./publication-github.mjs";
import { inspectTrialPacket } from "./producer-trial.mjs";
import { publicationObservationPrefix } from "./publication-controller.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));

async function qualificationRepository() {
  const metadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(metadata.repository?.url);
  requirePublication(match !== null, "PUBLICATION_PHYSICAL_REPOSITORY"); return match[1];
}

export function releaseQualificationMessage(producer, candidate, inventory, report) {
  requirePublication(producer.identity.sourceRevision === candidate.sourceRevision
    && producer.inventorySha256 === sha256(inventory)
    && /^[1-9][0-9]*$/.test(producer.identity.runId) && producer.identity.runAttempt === "1", "PUBLICATION_PHYSICAL_INPUT_INVALID");
  const text = `tabgrad-release-qualification ${producer.identity.runId}/1 ${sha256(inventory)}\n${canonicalBytes(report)}`;
  // Same finite attributed-observation envelope as the maintained release channel.
  requirePublication(Buffer.byteLength(text) <= 65536, "PUBLICATION_OBSERVATION_LIMIT");
  return text;
}

export async function collectReleaseQualification(dataDirectory, output, environment = process.env,
  { run = runPublicationProcess, clock = Date.now, repository: suppliedRepository } = {}) {
  requirePublication(isAbsolute(dataDirectory) && isAbsolute(output), "PUBLICATION_PHYSICAL_INPUT_INVALID");
  const inputRoot = await realpath(dataDirectory), target = join(await realpath(dirname(output)), basename(output));
  const inside = relative(inputRoot, target);
  requirePublication(inside !== "" && (inside.startsWith("../") || isAbsolute(inside)), "PUBLICATION_PHYSICAL_OUTPUT_OVERLAP");
  const inventory = await publicationFile(join(dataDirectory, "candidate.json"), 2 * 1024 * 1024);
  const candidate = readProducerInventory(inventory);
  const producer = JSON.parse(await publicationFile(join(dataDirectory, "producer.json"), 65536));
  requirePublication(producer.identity.repository === (suppliedRepository ?? await qualificationRepository()),
    "PUBLICATION_PHYSICAL_REPOSITORY");
  requirePublication(Date.parse(producer.expiresAt) > clock(), "PUBLICATION_WINDOW_EXPIRED");
  await inspectTrialPacket(dataDirectory, { identity: producer.identity, expiresAt: producer.expiresAt });
  const cpu = JSON.parse(await publicationFile(join(dataDirectory, "qualification.json"), 4 * 1024 * 1024));
  await mkdir(output, { mode: 0o700 });
  await mkdir(join(output, "home"), { mode: 0o700 });
  await writeFile(join(output, "empty-gitconfig"), "", { flag: "wx", mode: 0o600 });
  const result = await run(process.execPath, [join(repository, "scripts/run-package-browser-tests.mjs"),
    "--tarball", join(dataDirectory, candidate.tarball.path), "--expected", join(dataDirectory, "candidate.json"), "--gpu", "--browsers", "Chrome"],
  { directory: repository, environment: registryEnvironment(output, environment),
    timeoutMs: Math.max(1, Math.min(600000, Date.parse(producer.expiresAt) - clock())), maxOutputBytes: 4 * 1024 * 1024 });
  const gpu = JSON.parse(result.stdout);
  validatePublicationQualification([cpu, gpu], candidate, { candidate: { inventorySha256: sha256(inventory) }, qualification: { browsers: ["Chrome", "Firefox"], gpu: true } });
  requirePublication(clock() < Date.parse(producer.expiresAt), "PUBLICATION_WINDOW_EXPIRED");
  const message = releaseQualificationMessage(producer, candidate, inventory, gpu);
  for (const [name, raw] of [["report.json", canonicalBytes(gpu)], ["message.txt", Buffer.from(message)],
    ["receipt.json", canonicalBytes({ schemaVersion: 1, repository: producer.identity.repository,
      prefix: message.slice(0, message.indexOf("\n") + 1), messageSha256: sha256(Buffer.from(message)) })]]) {
    await writeFile(join(output, name), raw, { flag: "wx", mode: 0o600 });
  }
  return { status: "collected-for-inspection", messageSha256: sha256(Buffer.from(message)) };
}

/** Separate real registry installation after npm; never relabel the earlier archive observation. */
export async function collectRegistryQualification(root, output, environment = process.env,
  { run = runPublicationProcess, clock = Date.now, repository: suppliedRepository } = {}) {
  requirePublication(isAbsolute(root) && isAbsolute(output), "PUBLICATION_PHYSICAL_INPUT_INVALID");
  const planBytes = await publicationFile(join(root, "admission/input/plan.json"), 65536);
  const plan = validatePublicationPlan(JSON.parse(planBytes), clock());
  requirePublication(canonicalBytes(plan).equals(planBytes), "PUBLICATION_PLAN_IDENTITY");
  requirePublication(plan.publisher.repository === (suppliedRepository ?? await qualificationRepository()), "PUBLICATION_PHYSICAL_REPOSITORY");
  const admission = JSON.parse(await publicationFile(join(root, "admission/admission.json"), 4 * 1024 * 1024));
  const inventory = await publicationFile(join(root, "data/candidate.json"), 2 * 1024 * 1024);
  const candidate = readProducerInventory(inventory);
  requirePublication(admission.status === "passed" && admission.planSha256 === sha256(planBytes)
    && admission.context?.revision === plan.publisher.revision && admission.context.attempt === "1"
    && /^[1-9][0-9]*$/.test(admission.context.runId) && sha256(inventory) === plan.candidate.inventorySha256,
  "PUBLICATION_ADMISSION_HANDOFF");
  const inputRoot = await realpath(root), target = join(await realpath(dirname(output)), basename(output));
  const inside = relative(inputRoot, target);
  requirePublication(inside !== "" && (inside.startsWith("../") || isAbsolute(inside)), "PUBLICATION_PHYSICAL_OUTPUT_OVERLAP");
  await mkdir(output, { mode: 0o700 }); await mkdir(join(output, "home"), { mode: 0o700 });
  await writeFile(join(output, "empty-gitconfig"), "", { flag: "wx", mode: 0o600 });
  const registryPlan = { schemaVersion: 1, registry: plan.npm.registry, channel: plan.npm.channel,
    allowedOrigins: [plan.npm.registry], clientTimeoutMs: 30000, maxClientOutputBytes: 1024 * 1024 };
  await writeFile(join(output, "registry.json"), canonicalBytes(registryPlan), { flag: "wx", mode: 0o600 });
  const result = await run(process.execPath, [join(repository, "scripts/run-package-browser-tests.mjs"),
    "--registry-plan", join(output, "registry.json"), "--expected", join(root, "data/candidate.json"), "--gpu", "--browsers", "Chrome"],
  { directory: repository, environment: registryEnvironment(output, environment),
    timeoutMs: Math.max(1, Math.min(600000, Date.parse(plan.window.deadline) - clock())), maxOutputBytes: 4 * 1024 * 1024 });
  const report = JSON.parse(result.stdout);
  validatePublicationPhysicalReport(report, candidate, plan, "registry-version");
  requirePublication(clock() < Date.parse(plan.window.deadline), "PUBLICATION_WINDOW_EXPIRED");
  const prefix = publicationObservationPrefix(plan, sha256(planBytes), admission.context, "gpu-consumers");
  const message = `${prefix}${canonicalBytes(report)}`;
  requirePublication(Buffer.byteLength(message) <= 65536, "PUBLICATION_OBSERVATION_LIMIT");
  for (const [name, raw] of [["report.json", canonicalBytes(report)], ["message.txt", Buffer.from(message)],
    ["receipt.json", canonicalBytes({ schemaVersion: 1, repository: plan.publisher.repository,
      prefix, messageSha256: sha256(Buffer.from(message)) })]]) {
    await writeFile(join(output, name), raw, { flag: "wx", mode: 0o600 });
  }
  return { status: "collected-for-inspection", messageSha256: sha256(Buffer.from(message)) };
}

/** A persisted claim prevents a blind duplicate POST after an uncertain response. */
export async function publishReleaseQualification(directory, issue, environment = process.env,
  { api: suppliedApi, repository: suppliedRepository } = {}) {
  requirePublication(isAbsolute(directory) && /^[1-9][0-9]*$/.test(issue), "PUBLICATION_PHYSICAL_INPUT_INVALID");
  const receipt = JSON.parse(await publicationFile(join(directory, "receipt.json"), 65536));
  requirePublication(receipt.repository === (suppliedRepository ?? await qualificationRepository()), "PUBLICATION_PHYSICAL_REPOSITORY");
  const raw = await publicationFile(join(directory, "message.txt"), 65536);
  requirePublication(sha256(raw) === receipt.messageSha256
    && typeof receipt.prefix === "string"
    && (/^tabgrad-release-qualification [1-9][0-9]*\/1 [a-f0-9]{64}\n$/.test(receipt.prefix)
      || /^tabgrad-release-gpu-consumers [a-f0-9]{64} [a-f0-9]{64} [1-9][0-9]*\/1\n$/.test(receipt.prefix))
    && raw.toString().startsWith(receipt.prefix),
  "PUBLICATION_PHYSICAL_INPUT_INVALID");
  const api = suppliedApi ?? publicationGithub({ repository: receipt.repository, token: environment.GH_TOKEN });
  await writeFile(join(directory, "publication-claimed.json"), canonicalBytes({ issue, messageSha256: receipt.messageSha256 }),
    { flag: "wx", mode: 0o600 });
  let result;
  try {
    const comment = await api.request(`/issues/${issue}/comments`, { method: "POST", body: { body: raw.toString() } });
    requirePublication(comment.body === raw.toString() && Number.isSafeInteger(comment.id) && comment.id > 0,
      "PUBLICATION_PHYSICAL_RESPONSE_UNKNOWN");
    result = { status: "posted", commentId: String(comment.id), messageSha256: receipt.messageSha256 };
  } catch (error) {
    result = { status: "unknown", code: error.code ?? "PUBLICATION_PHYSICAL_RESPONSE_UNKNOWN", messageSha256: receipt.messageSha256 };
  }
  await writeFile(join(directory, "publication-result.json"), canonicalBytes(result), { flag: "wx", mode: 0o600 });
  requirePublication(result.status === "posted", "PUBLICATION_PHYSICAL_RESPONSE_UNKNOWN");
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const [command, input, output] = process.argv.slice(2);
    requirePublication(process.argv.length === 5 && ["collect", "collect-registry", "publish"].includes(command), "PUBLICATION_PHYSICAL_USAGE");
    const result = command === "collect" ? await collectReleaseQualification(input, output)
      : command === "collect-registry" ? await collectRegistryQualification(input, output) : await publishReleaseQualification(input, output);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { process.stdout.write(`${JSON.stringify({ status: "failed", code: error.code ?? "PUBLICATION_PHYSICAL_FAILED" })}\n`); process.exitCode = 1; }
}
