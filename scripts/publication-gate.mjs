/** Data-only publication readiness and permission, authenticated by provider jobs. */
import { randomBytes } from "node:crypto";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { canonicalBytes, sha256 } from "./release-record-data.mjs";
import { exactPublicationKeys, PublicationError, requirePublication } from "./publication-plan.mjs";
import { publicationFile } from "./publication-admission.mjs";

export const gateRoles = Object.freeze({ client: "publish-approved-npm", bootstrap: "observe-human-bootstrap", observer: "observe-ready-publication" });
export const gatePrefixes = Object.freeze({ ready: "Readiness SHA256 ", permission: "Permission SHA256 " });
const digest = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const decimal = value => typeof value === "string" && /^[1-9][0-9]*$/.test(value);

export function requireGateWindow(scope, now) {
  requirePublication(Number.isFinite(now) && Date.parse(scope.window.start) <= now
    && now < Date.parse(scope.window.deadline), "PUBLICATION_GATE_EXPIRED");
}

/** Scope is derived from the admitted plan/intent, never from an incoming packet. */
export function publicationGateScope(plan, context, handoff) {
  requirePublication(context.event === "workflow_dispatch" && context.ref === "refs/heads/main"
    && context.revision === plan.publisher.revision && decimal(context.runId) && context.attempt === "1"
    && decimal(context.repositoryId) && context.workflowRef === `${plan.publisher.repository}/${plan.publisher.workflow}@refs/heads/main`
    && ["oidc", "bootstrap"].includes(plan.npm.mode)
    && handoff.planSha256 === sha256(canonicalBytes(plan)), "PUBLICATION_GATE_CONTEXT");
  return { planSha256: sha256(canonicalBytes(plan)), context: structuredClone(context), handoff: structuredClone(handoff),
    mode: plan.npm.mode, window: structuredClone(plan.window) };
}

/** Current authorization and provider context must refer to the same execution. */
export function requireGateAuthority(scope, authority) {
  const c = scope.context;
  requirePublication(authority?.planSha256 === scope.planSha256 && authority.runId === c.runId
    && authority.runAttempt === c.attempt && authority.revision === c.revision
    && c.workflowRef === `${authority.repository}/${authority.workflow}@refs/heads/main`
    && isDeepStrictEqual(authority.window, scope.window), "PUBLICATION_GATE_AUTHORITY_CONTEXT");
}

/** Pending metadata is absence of completed proof, not a malformed final proof. */
export function gateJobBinding(body, scope, kind) {
  requirePublication(["ready", "permission"].includes(kind) && Number.isSafeInteger(body?.total_count)
    && body.total_count >= 0 && body.total_count <= 100 && Array.isArray(body.jobs)
    && body.jobs.length === body.total_count, "PUBLICATION_GATE_JOBS");
  const role = kind === "ready" ? (scope.mode === "bootstrap" ? gateRoles.bootstrap : gateRoles.client) : gateRoles.observer;
  const matches = body.jobs.filter(job => job.name === role);
  requirePublication(matches.length <= 1, "PUBLICATION_GATE_JOB_AMBIGUOUS");
  if (matches.length === 0) return null;
  const job = matches[0], c = scope.context;
  requirePublication(Number.isSafeInteger(job.id) && job.id > 0 && String(job.run_id) === c.runId
    && job.head_sha === c.revision, "PUBLICATION_GATE_JOB_CONTEXT");
  requirePublication(!["failure", "cancelled", "timed_out", "skipped", "action_required"].includes(job.conclusion),
    "PUBLICATION_GATE_JOB_FAILED");
  requirePublication(job.status !== "completed" || job.conclusion === "success", "PUBLICATION_GATE_JOB_FAILED");
  if (kind === "ready") {
    requirePublication(job.status !== "completed", "PUBLICATION_GATE_CLIENT_STOPPED");
    if (job.conclusion !== null) return null;
  }
  if (kind === "ready" ? job.status !== "in_progress" : job.status !== "completed" || job.conclusion !== "success") return null;
  requirePublication(Array.isArray(job.steps), "PUBLICATION_GATE_STEPS");
  const matches_ = job.steps.filter(step => typeof step.name === "string" && step.name.startsWith(gatePrefixes[kind]));
  requirePublication(matches_.length <= 1, "PUBLICATION_GATE_STEP_AMBIGUOUS");
  if (!matches_.length || matches_[0].status !== "completed") return null;
  const step = matches_[0], rawSha256 = step.name.slice(gatePrefixes[kind].length);
  requirePublication(digest(rawSha256) && step.conclusion === "success"
    && Number.isSafeInteger(step.number) && step.number > 0, "PUBLICATION_GATE_STEP_INVALID");
  if (kind === "ready") {
    const waits = job.steps.filter(value => value.name === "Await observed permission");
    requirePublication(waits.length <= 1, "PUBLICATION_GATE_WAIT_AMBIGUOUS");
    if (!waits.length || waits[0].status !== "in_progress") return null;
    requirePublication(waits[0].conclusion === null && waits[0].number > step.number, "PUBLICATION_GATE_WAIT_ORDER");
  }
  return { jobId: String(job.id), role, rawSha256, stepNumber: step.number };
}

/** ZIP identity and raw packet identity are checked independently. */
export function gateArtifactBinding(body, scope, kind, rawSha256) {
  requirePublication(digest(rawSha256) && Number.isSafeInteger(body?.total_count) && body.total_count >= 0
    && body.total_count <= 100 && Array.isArray(body.artifacts) && body.artifacts.length === body.total_count,
  "PUBLICATION_GATE_ARTIFACTS");
  const name = `publication-${kind}-${scope.context.runId}-${rawSha256}`;
  const matches = body.artifacts.filter(value => value.name === name);
  requirePublication(matches.length <= 1, "PUBLICATION_GATE_ARTIFACT_AMBIGUOUS");
  if (!matches.length) return null;
  const a = matches[0], c = scope.context, w = a.workflow_run;
  requirePublication(Number.isSafeInteger(a.id) && a.id > 0 && a.expired === false
    && Number.isSafeInteger(a.size_in_bytes) && a.size_in_bytes > 0 && a.size_in_bytes <= 2 * 1024 * 1024
    && /^sha256:[0-9a-f]{64}$/.test(a.digest) && String(w?.id) === c.runId
    && w.head_sha === c.revision && w.head_branch === "main"
    && String(w.repository_id) === c.repositoryId && String(w.head_repository_id) === c.repositoryId
    && Date.parse(a.expires_at) >= Date.parse(scope.window.deadline), "PUBLICATION_GATE_ARTIFACT_CONTEXT");
  return { id: String(a.id), name, zipSha256: a.digest.slice(7), byteLength: a.size_in_bytes };
}

export function gateReady(scope, nonce = randomBytes(32).toString("hex")) {
  requirePublication(digest(nonce), "PUBLICATION_GATE_NONCE");
  return canonicalBytes({ schemaVersion: 1, kind: "ready", scope, nonce });
}

export function readGatePacket(raw, scope, kind, expectedSha256) {
  requirePublication(Buffer.isBuffer(raw) && raw.length <= 65536 && sha256(raw) === expectedSha256,
    "PUBLICATION_GATE_PACKET_IDENTITY");
  const packet = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  requirePublication(canonicalBytes(packet).equals(raw) && exactPublicationKeys(packet,
    ["schemaVersion", "kind", "scope", "nonce", ...(kind === "permission" ? ["readySha256"] : [])])
    && packet.schemaVersion === 1 && packet.kind === kind && isDeepStrictEqual(packet.scope, scope) && digest(packet.nonce),
  "PUBLICATION_GATE_PACKET_SCOPE");
  if (kind === "permission") requirePublication(digest(packet.readySha256), "PUBLICATION_GATE_PERMISSION_INVALID");
  return packet;
}

/** Select one immutable artifact from authenticated metadata before transferring it. */
export async function selectGatePacket({ scope, kind, api, clock = Date.now, signal,
  pause = milliseconds => delay(milliseconds, undefined, { signal }) }) {
  let heldJob;
  while (clock() < Date.parse(scope.window.deadline)) {
    requireGateWindow(scope, clock());
    requirePublication(!signal?.aborted, "PUBLICATION_GATE_CANCELED");
    const proof = gateJobBinding(await api.request(`/actions/runs/${scope.context.runId}/attempts/${scope.context.attempt}/jobs?per_page=100`, { signal }), scope, kind);
    if (proof) {
      requirePublication(heldJob === undefined || heldJob === proof.jobId, "PUBLICATION_GATE_JOB_CHANGED");
      heldJob = proof.jobId;
      const artifact = gateArtifactBinding(await api.request(`/actions/runs/${scope.context.runId}/artifacts?per_page=100`, { signal }), scope, kind, proof.rawSha256);
      if (artifact) {
        requireGateWindow(scope, clock());
        requirePublication(!signal?.aborted, "PUBLICATION_GATE_CANCELED");
        return { proof, artifact };
      }
    }
    await pause(Math.min(5000, Math.max(1, Date.parse(scope.window.deadline) - clock())));
  }
  requirePublication(false, "PUBLICATION_GATE_EXPIRED");
}

/** The observer calls this only after fresh authority, intent and destination reads. */
export function gatePermission(scope, readyRaw) {
  const ready = readGatePacket(readyRaw, scope, "ready", sha256(readyRaw));
  return canonicalBytes({ schemaVersion: 1, kind: "permission", scope, nonce: ready.nonce,
    readySha256: sha256(readyRaw) });
}

/** Claim before any wait/check can hide a previous dispatch of this same call. */
export async function claimGateSession(marker) {
  try {
    await writeFile(marker, "publication-session-attempted\n", { flag: "wx", mode: 0o600 });
  } catch (cause) {
    const error = new PublicationError(cause.code === "EEXIST"
      ? "PUBLICATION_GATE_ALREADY_ATTEMPTED" : "PUBLICATION_GATE_SESSION_UNAVAILABLE", { cause });
    // Neither an existing marker nor an inaccessible session proves that the
    // original call had no effect. This invocation must not clear its intent.
    error.dispatched = null; throw error;
  }
}

/** The owned session is already claimed. This does not guarantee atomic services. */
export function consumeGatePermission({ scope, readyRaw, received, clock }) {
  const ready = readGatePacket(readyRaw, scope, "ready", sha256(readyRaw));
  const p = readGatePacket(received.raw, scope, "permission", received.proof.rawSha256);
  requirePublication(p.nonce === ready.nonce && p.readySha256 === sha256(readyRaw), "PUBLICATION_GATE_PERMISSION_ASSOCIATION");
  requireGateWindow(scope, clock());
  return { readySha256: sha256(readyRaw), permissionSha256: sha256(received.raw),
    jobId: received.proof.jobId, call: scope.handoff.call };
}

/** Check the same job/step and immutable artifact after a transfer or wait. */
export async function recheckGateSelection(api, scope, kind, selection, clock = Date.now, signal) {
  const proof = gateJobBinding(await api.request(`/actions/runs/${scope.context.runId}/attempts/${scope.context.attempt}/jobs?per_page=100`, { signal }), scope, kind);
  const artifact = await api.request(`/actions/artifacts/${selection.artifact.id}`, { signal });
  const selected = gateArtifactBinding({ total_count: 1, artifacts: [artifact] }, scope, kind, selection.proof.rawSha256);
  requirePublication(isDeepStrictEqual(proof, selection.proof) && isDeepStrictEqual(selected, selection.artifact),
    "PUBLICATION_GATE_BINDING_CHANGED");
  requireGateWindow(scope, clock());
  requirePublication(!signal?.aborted, "PUBLICATION_GATE_CANCELED");
}

/** Received packets are data, in a dedicated directory after a strict download. */
export async function receiveGatePacket(directory, api, scope, kind, selection, clock = Date.now) {
  const names = await readdir(directory);
  requirePublication(names.length === 1 && names[0] === `${kind}.json`, "PUBLICATION_GATE_MEMBERS");
  const raw = await publicationFile(join(directory, names[0]), 65536);
  const value = readGatePacket(raw, scope, kind, selection.proof.rawSha256);
  await recheckGateSelection(api, scope, kind, selection, clock);
  return { raw, value, ...selection };
}

/** Exact expected bytes can be held locally; this does not claim ZIP acquisition. */
export async function corroborateExpectedPermission(api, scope, readyRaw, { clock = Date.now, pause, signal } = {}) {
  const raw = gatePermission(scope, readyRaw);
  const selection = await selectGatePacket({ scope, kind: "permission", api, clock, pause, signal });
  requirePublication(selection.proof.rawSha256 === sha256(raw), "PUBLICATION_GATE_PERMISSION_ASSOCIATION");
  await recheckGateSelection(api, scope, "permission", selection, clock, signal);
  return { raw, value: readGatePacket(raw, scope, "permission", sha256(raw)), ...selection,
    input: "independently-constructed-expected-bytes" };
}
