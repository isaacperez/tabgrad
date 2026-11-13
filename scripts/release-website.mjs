/** Completed-release handoff. This owner observes delivery; it never publishes npm or GitHub. */
import { appendFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalBytes, sha256 } from "./release-record-data.mjs";
import { exactPublicationKeys, requirePublication, validatePublicationPlan } from "./publication-plan.mjs";
import { publicationFile } from "./publication-admission.mjs";
import { publicationGithub } from "./publication-github.mjs";
import { publicationEnvironmentSnapshot } from "./publication-control.mjs";
import { readProducerInventory } from "./package-provenance.mjs";
import { createRegistryPackageApplication } from "./package-registry.mjs";

const digest = /^[a-f0-9]{64}$/, id = /^[1-9][0-9]*$/;
const publisherWorkflow = ".github/workflows/release-publication.yml";

/** Validate original inventory bytes, rather than reserializing and claiming their digest. */
export function completedRelease(input) {
  requirePublication(exactPublicationKeys(input, ["schemaVersion", "plan", "publisher", "inventory", "releaseId", "environment"])
    && exactPublicationKeys(input.environment, ["id", "name", "snapshotSha256"])
    && id.test(input.environment.id) && input.environment.name === "website-tag-publication"
    && digest.test(input.environment.snapshotSha256) && input.schemaVersion === 1 && exactPublicationKeys(input.publisher, ["runId", "attempt"])
    && id.test(input.publisher.runId) && input.publisher.attempt === "1" && id.test(input.releaseId)
    && typeof input.inventory === "string" && input.inventory.length <= 3 * 1024 * 1024,
  "PUBLICATION_SITE_COMPLETION_INVALID");
  // Completed read-only recovery may outlive the former write window.
  const plan = validatePublicationPlan(input.plan, Date.parse(input.plan?.window?.start));
  requirePublication(plan.schemaVersion === 3, "PUBLICATION_SITE_COMPLETION_INVALID");
  const raw = Buffer.from(input.inventory, "base64");
  requirePublication(raw.toString("base64") === input.inventory && sha256(raw) === plan.candidate.inventorySha256,
    "PUBLICATION_SITE_INVENTORY_CHANGED");
  const candidate = readProducerInventory(raw);
  requirePublication(candidate.name === plan.candidate.name && candidate.version === plan.candidate.version
    && candidate.sourceRevision === plan.candidate.sourceRevision
    && candidate.tarball.integrity === `sha512-${Buffer.from(plan.candidate.archiveSha512, "hex").toString("base64")}`,
  "PUBLICATION_SITE_INVENTORY_CHANGED");
  return { descriptor: structuredClone(input), plan, candidate, sha256: sha256(canonicalBytes(input)) };
}

/** Compact public identity; local acquisition paths and account configuration never enter output. */
export function releaseSiteIdentity(input) {
  const { plan, sha256: completionSha256 } = completedRelease(input);
  return { schemaVersion: 1, completionSha256, operation: plan.operation, planSha256: sha256(canonicalBytes(plan)),
    sourceRevision: plan.candidate.sourceRevision, recipeRevision: plan.publisher.revision,
    runId: input.publisher.runId, attempt: "1", version: plan.candidate.version,
    inventorySha256: plan.candidate.inventorySha256, archiveSha512: plan.candidate.archiveSha512 };
}

/** Require the successful completed role, not aggregate run success (the called site is still running). */
export async function observeCompletedRelease({ descriptor, api, artifact, environment }) {
  const selected = completedRelease(descriptor), { plan } = selected;
  requirePublication(environment.GITHUB_REPOSITORY === plan.github.repository
    && environment.GITHUB_REPOSITORY_ID === plan.producer.verification.identity.repositoryId
    && environment.GITHUB_EVENT_NAME === "workflow_dispatch" && environment.GITHUB_REF === "refs/heads/main"
    && environment.GITHUB_RUN_ATTEMPT === "1" && /^[a-f0-9]{40}$/.test(environment.GITHUB_SHA ?? "")
    && (environment.TABGRAD_WEBSITE_RELEASE_RECOVERY === "true" || environment.GITHUB_SHA === plan.publisher.revision),
  "PUBLICATION_SITE_CONTEXT_INVALID");
  const recovery = environment.TABGRAD_WEBSITE_RELEASE_RECOVERY === "true";
  requirePublication(environment.GITHUB_WORKFLOW_REF === `${environment.GITHUB_REPOSITORY}/${recovery ? ".github/workflows/website-checks.yml" : publisherWorkflow}@refs/heads/main`
    && (recovery || environment.GITHUB_RUN_ID === descriptor.publisher.runId), "PUBLICATION_SITE_CONTEXT_INVALID");
  const run = await api.request(`/actions/runs/${descriptor.publisher.runId}`);
  requirePublication(String(run.id) === descriptor.publisher.runId && run.run_attempt === 1 && run.event === "workflow_dispatch"
    && run.path === publisherWorkflow && run.head_sha === plan.publisher.revision && run.head_branch === "main"
    && String(run.repository?.id) === environment.GITHUB_REPOSITORY_ID && String(run.head_repository?.id) === environment.GITHUB_REPOSITORY_ID,
  "PUBLICATION_SITE_COMPLETION_UNCONFIRMED");
  const jobs = await api.request(`/actions/runs/${descriptor.publisher.runId}/attempts/1/jobs?per_page=100`);
  requirePublication(jobs.total_count <= 100 && jobs.jobs?.length === jobs.total_count
    && jobs.jobs.some(job => job.name === "complete-github-release" && job.status === "completed" && job.conclusion === "success"
      && String(job.run_id) === descriptor.publisher.runId && job.head_sha === plan.publisher.revision
      && job.steps?.some(step => step.name === `Completed release ${selected.sha256}` && step.status === "completed" && step.conclusion === "success")),
  "PUBLICATION_SITE_COMPLETION_UNCONFIRMED");
  const transfer = await api.request(`/actions/artifacts/${artifact.id}`);
  requirePublication(id.test(artifact.id) && digest.test(artifact.sha256) && transfer.digest === `sha256:${artifact.sha256}`
    && String(transfer.id) === artifact.id && transfer.expired === false
    && transfer.name === `tabgrad-publication-completion-${descriptor.publisher.runId}-1`
    && transfer.workflow_run?.head_sha === plan.publisher.revision && String(transfer.workflow_run.id) === descriptor.publisher.runId
    && String(transfer.workflow_run.repository_id) === environment.GITHUB_REPOSITORY_ID,
  "PUBLICATION_SITE_ARTIFACT_CHANGED");
  const protection = await api.request(`/environments/${descriptor.environment.name}`);
  const branchResult = await api.request(`/environments/${descriptor.environment.name}/deployment-branch-policies?per_page=100&page=1`);
  const branches = branchResult.branch_policies;
  requirePublication(String(protection.id) === descriptor.environment.id && protection.name === descriptor.environment.name
    && Array.isArray(protection.protection_rules) && protection.protection_rules.length === 0
    && branchResult.total_count === 1 && branches?.length === 1 && branches[0].name === "main" && branches[0].type === "branch"
    && sha256(canonicalBytes(publicationEnvironmentSnapshot(protection, branches))) === descriptor.environment.snapshotSha256,
  "PUBLICATION_SITE_PROTECTION_CHANGED");
  const release = await api.request(`/releases/${descriptor.releaseId}`);
  const ref = await api.request(`/git/ref/tags/${plan.github.tag}`);
  const tag = ref.object?.type === "tag" ? await api.request(`/git/tags/${ref.object.sha}`) : null;
  requirePublication(String(release.id) === descriptor.releaseId && release.draft === false && release.prerelease === false
    && release.immutable === true && release.tag_name === plan.github.tag && ref.object?.type === "tag"
    && tag?.object?.type === "commit" && tag.object.sha === plan.candidate.sourceRevision, "PUBLICATION_SITE_RELEASE_CHANGED");
  // This reader observes a known public release. It never infers draft absence or acquires a writer view.
  const assets = await api.request(`/releases/${descriptor.releaseId}/assets?per_page=100&page=1`);
  requirePublication(Array.isArray(assets) && assets.length === plan.github.assets.length && assets.length < 100
    && new Set(assets.map(asset => asset.name)).size === assets.length, "PUBLICATION_SITE_RELEASE_CHANGED");
  for (const expected of plan.github.assets) {
    const asset = assets.find(asset => asset.name === expected.name);
    requirePublication(Number.isSafeInteger(asset?.id) && asset.id > 0 && asset.size === expected.byteLength
      && asset.state === "uploaded", "PUBLICATION_SITE_RELEASE_CHANGED");
    const raw = await api.request(`/releases/assets/${asset.id}`, { binary: true, maxBytes: expected.byteLength });
    requirePublication(raw.length === expected.byteLength && sha256(raw) === expected.sha256, "PUBLICATION_SITE_RELEASE_CHANGED");
  }
  return selected;
}

/** Owned registry application is copied only after full archive/install verification and always closed. */
export async function acquireReleaseSite({ descriptor, directory, recipeRevision = descriptor.plan.publisher.revision, sourceRevision = descriptor.plan.candidate.sourceRevision, createApplication = createRegistryPackageApplication }) {
  const { candidate, plan } = completedRelease(descriptor);
  let application;
  await mkdir(directory, { mode: 0o700 });
  try {
    application = await createApplication({ expected: candidate, registryPlan: { schemaVersion: 1, registry: "https://registry.npmjs.org/",
      allowedOrigins: ["https://registry.npmjs.org"], channel: plan.npm.channel, clientTimeoutMs: 60000, maxClientOutputBytes: 4 * 1024 * 1024 } });
    const packageDirectory = join(directory, "package");
    await cp(application.packageDirectory, packageDirectory, { recursive: true, errorOnExist: true, force: false });
    requirePublication([recipeRevision, sourceRevision].every(value => /^[a-f0-9]{40}$/.test(value)), "PUBLICATION_SITE_CONTEXT_INVALID");
    const context = { schemaVersion: 1, recipeRevision, sourceRevision, release: releaseSiteIdentity(descriptor), packageDirectory, inventory: candidate.files };
    await writeFile(join(directory, "release-input.json"), canonicalBytes(context), { flag: "wx", mode: 0o600 });
    return context;
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  finally { await application?.close(); }
}

async function main() {
  const [input, directory] = process.argv.slice(2), environment = process.env;
  requirePublication(process.argv.length === 4, "PUBLICATION_SITE_USAGE");
  const raw = await publicationFile(resolve(input), 8 * 1024 * 1024), descriptor = JSON.parse(raw);
  const selected = completedRelease(descriptor);
  requirePublication(selected.sha256 === environment.TABGRAD_COMPLETION_SHA256
    && canonicalBytes(descriptor).equals(raw), "PUBLICATION_SITE_COMPLETION_CHANGED");
  await observeCompletedRelease({ descriptor, environment, artifact: { id: environment.TABGRAD_COMPLETION_ID,
    sha256: environment.TABGRAD_COMPLETION_DIGEST }, api: publicationGithub({ repository: environment.GITHUB_REPOSITORY,
    token: environment.GH_TOKEN, readOnly: true }) });
  const context = await acquireReleaseSite({ descriptor, directory: resolve(directory), recipeRevision: environment.GITHUB_SHA, sourceRevision: environment.TABGRAD_WEBSITE_RELEASE_RECOVERY === "true"
    ? environment.GITHUB_SHA : selected.plan.candidate.sourceRevision });
  if (environment.GITHUB_OUTPUT) await appendFile(environment.GITHUB_OUTPUT,
    `source_revision=${context.sourceRevision}\nrelease_input=${join(resolve(directory), "release-input.json")}\n`);
  return { status: "release-site-acquired", release: context.release };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await main())); }
  catch (error) { console.log(JSON.stringify({ status: "failed", code: error.code ?? "PUBLICATION_SITE_FAILED" })); process.exitCode = 1; }
}
