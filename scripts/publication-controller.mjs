import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalBytes, sha256 } from "./release-record-data.mjs";
import { releaseRecord } from "./release-record.mjs";
import { PublicationError, requirePublication } from "./publication-plan.mjs";
import { publicationFile } from "./publication-admission.mjs";
import { requireNpmCallReceipt, requireNpmConservationCall } from "./publication-effects.mjs";

export const publicationHistoryLimits = Object.freeze({ files: 10000, fileBytes: 65536, bytes: 128 * 1024 * 1024 });

/** Layout only: metadata admission and complete record replay remain separate. */
export async function publicationHistoryInput(root, directory, history) {
  if (directory !== join(root, "initial-history")) return directory;
  requirePublication(typeof history?.runId === "string" && /^[1-9][0-9]*$/.test(history.runId),
    "PUBLICATION_HISTORY_LAYOUT");
  const layouts = new Map([[`tabgrad-publication-history-${history.runId}-1`, directory],
    [`tabgrad-publication-observation-${history.runId}-1`, join(directory, "evidence")],
    [`tabgrad-publication-completion-${history.runId}-1`, join(directory, "evidence")]]);
  const selected = layouts.get(history.name);
  requirePublication(selected !== undefined, "PUBLICATION_HISTORY_LAYOUT");
  for (const path of new Set([directory, selected])) {
    const stat = await lstat(path);
    requirePublication(stat.isDirectory() && !stat.isSymbolicLink(), "PUBLICATION_HISTORY_LAYOUT");
  }
  return selected;
}

/** Data-only original evidence; never check out the control branch or execute it. */
export async function publicationHistoryFiles(directory) {
  const evidence = {};
  let bytes = 0;
  const names = await readdir(directory);
  requirePublication(names.length <= publicationHistoryLimits.files, "PUBLICATION_HISTORY_LIMIT");
  for (const name of names) {
    requirePublication(/^[0-9a-f]{64}\.json$/.test(name), "PUBLICATION_HISTORY_NAME");
    const path = join(directory, name), raw = await publicationFile(path, publicationHistoryLimits.fileBytes);
    bytes += raw.length;
    requirePublication(bytes <= publicationHistoryLimits.bytes && sha256(raw) === name.slice(0, 64), "PUBLICATION_HISTORY_CHANGED");
    evidence[name.slice(0, 64)] = path;
  }
  return evidence;
}

export async function publicationRecordConfig(directory, policy) {
  return { schemaVersion: 1, ...policy.record, writerPolicy: policy.writerPolicySha256,
    evidence: await publicationHistoryFiles(directory) };
}

/** Transfer only identified data originals, never a configuration or executable. */
export async function transferPublicationHistory(source, destination) {
  const evidence = await publicationHistoryFiles(source);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const [identity, path] of Object.entries(evidence)) {
    const raw = await readFile(path), target = join(destination, `${identity}.json`);
    try { await writeFile(target, raw, { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST" || !(await readFile(target)).equals(raw)) throw error; }
  }
  return Object.keys(await publicationHistoryFiles(destination)).length;
}

export async function publicationRecordHead(api, policy) {
  requirePublication(/^refs\/heads\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(policy.record.ref), "PUBLICATION_RECORD_LOCATION");
  const value = await api.request(`/git/ref/${policy.record.ref.slice(5)}`);
  requirePublication(value.ref === policy.record.ref && value.object?.type === "commit"
    && typeof value.object.sha === "string" && /^[0-9a-f]{40}$/.test(value.object.sha), "PUBLICATION_RECORD_HEAD");
  return value.object.sha;
}

/** Outcome recording is a different role from npm execution, including on failure. */
export async function recordNpmPublication({ plan, config, expectedHead, handoff, receipt,
  authorityObservation, directory, authenticateReceipt, clock = Date.now, protocol = releaseRecord, basis = "call" }) {
  // The supplied report is not self-authenticating. CI must corroborate its exact
  // producing job/output; human bootstrap requires the admitted maintainer's
  // explicit original-call reconciliation under the current approved run.
  await authenticateReceipt(receipt);
  requireNpmCallReceipt(plan, handoff, receipt);
  const replay = await protocol({ command: "read", config, expectedHead, clock });
  requireNpmConservationCall(plan, replay, handoff, authorityObservation);
  const evidenceBytes = canonicalBytes(receipt), evidence = sha256(evidenceBytes);
  const path = join(directory, `${evidence}.json`);
  await writeFile(path, evidenceBytes, { flag: "wx", mode: 0o600 });
  config = { ...config, evidence: { ...config.evidence, [evidence]: path } };
  const inputBytes = canonicalBytes({ schemaVersion: 1, event: { type: "observe", operation: plan.operation,
    call: handoff.call, outcome: receipt.outcome, basis, evidence, at: new Date(clock()).toISOString() } });
  const result = await protocol({ command: "append", config, expectedHead, inputBytes,
    inspected: sha256(inputBytes), clock });
  requirePublication(result.status === "confirmed", "PUBLICATION_RECORD_UNCONFIRMED");
  return { head: result.head, config, outcome: receipt.outcome };
}

export async function corroboratePublicationJob(api, context, name, expectedConclusion = "success") {
  const result = await api.request(`/actions/runs/${context.runId}/attempts/${context.attempt}/jobs?per_page=100`);
  requirePublication(result.total_count <= 100 && Array.isArray(result.jobs)
    && result.jobs.filter(job => job.name === name && String(job.run_id) === context.runId
      && job.head_sha === context.revision && job.status === "completed"
      && job.conclusion === expectedConclusion).length === 1, "PUBLICATION_HANDOFF_JOB");
}

export async function corroboratePublicationOutput(api, context, id, digest, name, deadline) {
  requirePublication(typeof id === "string" && /^[1-9][0-9]*$/.test(id)
    && typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest), "PUBLICATION_HANDOFF_IDENTITY");
  const output = await api.request(`/actions/artifacts/${id}`);
  requirePublication(String(output.id) === id && output.digest === `sha256:${digest}` && output.name === name
    && output.expired === false && output.size_in_bytes > 0 && output.size_in_bytes <= 128 * 1024 * 1024
    && String(output.workflow_run?.id) === context.runId && output.workflow_run.head_sha === context.revision
    && String(output.workflow_run.repository_id) === context.repositoryId
    && String(output.workflow_run.head_repository_id) === context.repositoryId
    && output.workflow_run.head_branch === "main" && Date.parse(output.expires_at) >= Date.parse(deadline),
  "PUBLICATION_HANDOFF_MISMATCH");
}

/** Full call originals remain private; this header is public-safe and closed. */
export async function savePublicationJson(path, value) {
  await writeFile(path, canonicalBytes(value), { flag: "wx", mode: 0o600 });
}

export async function readPublicationJson(path, limit = 65536) {
  const raw = await publicationFile(path, limit);
  return JSON.parse(raw);
}

export async function pendingPublicationObservation({ api, context, policy, plan, planSha256, issue, kind = "bootstrap", clock = Date.now,
  pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) }) {
  // An authenticated maintainer publishes the safe receipt only after reviewing
  // the actual human client's originals; a destination match is insufficient.
  requirePublication(typeof issue === "string" && /^[1-9][0-9]*$/.test(issue), "PUBLICATION_BOOTSTRAP_RECEIPT_LOCATION");
  requirePublication(["bootstrap", "bootstrap-ready", "gpu-consumers"].includes(kind), "PUBLICATION_OBSERVATION_KIND");
  const prefix = `tabgrad-release-${kind} ${planSha256} ${plan.operation} ${context.runId}/${context.attempt}\n`;
  while (clock() < Date.parse(plan.window.deadline)) {
    const matches = (await api.pages(`/issues/${issue}/comments`)).filter(comment => comment.body?.startsWith(prefix)
      && policy.maintainers.some(actor => actor.ownerSha256 === plan.owner && actor.id === String(comment.user?.id))
      && Date.parse(comment.updated_at) >= Date.parse(plan.window.start) && Date.parse(comment.updated_at) < Date.parse(plan.window.deadline));
    requirePublication(matches.length <= 1, "PUBLICATION_BOOTSTRAP_RECEIPT_CONFLICT");
    if (matches.length === 1) {
      const raw = Buffer.from(matches[0].body.slice(prefix.length));
      requirePublication(raw.length <= 65536, "PUBLICATION_OBSERVATION_LIMIT");
      return { value: JSON.parse(raw), raw, original: matches[0] };
    }
    await pause(Math.min(15000, Math.max(1, Date.parse(plan.window.deadline) - clock())));
  }
  throw new PublicationError("PUBLICATION_BOOTSTRAP_DEADLINE");
}
