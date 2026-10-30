import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { publicationRecordFixture } from "./publication-record.mjs";
import { canonicalBytes, sha256 } from "../../scripts/release-record-data.mjs";
import { publicationRecord } from "../../scripts/publication-record.mjs";
import { releaseRecord } from "../../scripts/release-record.mjs";
import { publicationGithub } from "../../scripts/publication-github.mjs";
import { publicationRegistry } from "../../scripts/publication-registry.mjs";
import { prepareNpmCall } from "../../scripts/publication-effects.mjs";
import { verifyPublicationAuthority } from "../../scripts/publication-plan.mjs";
import { gatePrefixes, gateRoles } from "../../scripts/publication-gate.mjs";

/** Real file-Git and production HTTP adapters, with closed synthetic provider ports. */
export async function publicationServiceFixture(t, mode = "oidc", options = {}) {
  const f = await publicationRecordFixture(t), plan = f.plan;
  f.clock = Date.now;
  plan.npm.mode = mode;
  if (options.clientSha256) plan.publisher.clientSha256 = options.clientSha256;
  plan.npm.before = mode === "oidc" ? { package: "existing", version: "absent", channel: null }
    : { package: "absent", version: "absent", channel: null };
  const archive = Buffer.from("synthetic candidate, not a real npm package"), proof = Buffer.from('{"synthetic":"unsigned"}\n');
  plan.candidate.archiveSha512 = createHash("sha512").update(archive).digest("hex");
  plan.producer.archiveProofSha256 = sha256(proof);
  const candidate = { name: plan.candidate.name, version: plan.candidate.version, private: false,
    sourceRevision: plan.candidate.sourceRevision, files: [], tarball: { path: "candidate.tgz", byteLength: archive.length,
      sha256: sha256(archive), integrity: `sha512-${Buffer.from(plan.candidate.archiveSha512, "hex").toString("base64")}` } };
  const inventory = canonicalBytes(candidate);
  plan.candidate.inventorySha256 = sha256(inventory);
  plan.producer.verification.candidate = { inventorySha256: sha256(inventory), archiveSha512: plan.candidate.archiveSha512 };
  const assets = new Map(plan.github.assets.map(asset => [asset.name,
    asset.kind === "archive" ? archive : asset.kind === "inventory" ? inventory : asset.kind === "archive-proof" ? proof
      : Buffer.from(`synthetic ${asset.kind}`)]));
  plan.github.assets = plan.github.assets.map(asset => ({ ...asset,
    byteLength: assets.get(asset.name).length, sha256: sha256(assets.get(asset.name)) }));
  const notes = "approved synthetic notes"; plan.github.notesSha256 = sha256(Buffer.from(notes));
  f.authorityObservation.planSha256 = sha256(canonicalBytes(plan));
  f.policy.repositoryId = plan.producer.verification.identity.repositoryId;
  f.policy.maintainers = [{ id: "23", ownerSha256: plan.owner }];
  const context = { event: "workflow_dispatch", ref: "refs/heads/main", revision: plan.publisher.revision,
    runId: f.authorityObservation.runId, attempt: "1", repositoryId: f.policy.repositoryId,
    workflowRef: `${plan.publisher.repository}/${plan.publisher.workflow}@refs/heads/main` };
  const jobs = new Map(), packets = new Map(), requests = [], comments = [], flags = { revoked: false, pending: false, pendingSeen: false };
  const destination = { tagRevision: null, release: null, assets: [] };
  const pack = { name: plan.candidate.name, versions: {}, time: {}, "dist-tags": {} };
  const registry = publicationRegistry({ fetcher: async (url, options) => {
    assert.equal(options.method, "GET"); assert.equal(url.origin, "https://registry.npmjs.org");
    if (url.pathname === "/-/npm/v1/attestations/fixture") return new Response(JSON.stringify({ attestations:
      [{ predicateType: "https://slsa.dev/provenance/v1", bundle: JSON.parse(proof) }] }));
    assert.equal(decodeURIComponent(url.pathname), `/${plan.candidate.name}`); return new Response(JSON.stringify(pack));
  } });
  const head = () => {
    const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "--git-dir", f.policy.record.location,
      "rev-parse", f.policy.record.ref], { encoding: "utf8", timeout: 30000,
      env: { PATH: process.env.PATH, HOME: f.directory, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  const fetcher = role => async (url, options) => {
    assert.ok(["https://api.github.com", "https://uploads.github.com"].includes(url.origin));
    if (url.origin === "https://uploads.github.com") assert.ok(url.pathname.endsWith("/releases/8/assets") && options.method === "POST");
    const prefix = `/repos/${plan.publisher.repository}`; assert.ok(url.pathname.startsWith(prefix));
    const route = url.pathname.slice(prefix.length), method = options.method;
    requests.push({ role, route, method });
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
    if (route === "") return json({ id: Number(context.repositoryId), full_name: plan.publisher.repository,
      permissions: { push: false }, archived: false, disabled: false });
    if (route === `/git/ref/${f.policy.record.ref.slice(5)}`) return json({ ref: f.policy.record.ref,
      object: { type: "commit", sha: head() } });
    if (route === `/actions/runs/${context.runId}/attempts/1/jobs`) {
      if (flags.beforeJobsRead) await flags.beforeJobsRead(role);
      const values = structuredClone([...jobs.values()]);
      if (role === "observer" && flags.pending && !flags.pendingSeen) {
        flags.pendingSeen = true;
        const upload = values[0].steps[0]; upload.name = "Readiness SHA256 ${{ steps.prepared.outputs.ready_sha }}";
        upload.status = "pending"; upload.conclusion = null;
      }
      return json({ total_count: values.length, jobs: values });
    }
    if (route === "/issues/77/comments") return json(comments);
    if (route === `/actions/runs/${context.runId}/artifacts`) return json({ total_count: packets.size,
      artifacts: [...packets.values()].map(p => p.metadata) });
    if (route.startsWith("/actions/artifacts/")) {
      const found = [...packets.values()].find(p => String(p.metadata.id) === route.split("/").at(-1));
      return found ? json(found.metadata) : json({}, 404);
    }
    if (route.startsWith("/git/ref/tags/")) return destination.tagRevision === null ? json({}, 404)
      : json({ ref: `refs/tags/${plan.github.tag}`, object: { type: "commit", sha: destination.tagRevision } });
    if (route === "/releases" && method === "GET") return role === "client" ? json([], 403)
      : json(destination.release === null ? [] : [destination.release]);
    if (route === "/releases/latest") return json(destination.release);
    if (route === "/releases/8/assets" && method === "GET") return json(destination.assets.map(a => ({ ...a, state: "uploaded", size: a.byteLength,
      digest: `sha256:${a.sha256}` })));
    if (route.startsWith("/releases/assets/")) {
      const a = destination.assets.find(a => a.id === Number(route.split("/").at(-1)));
      assert.ok(a); return new Response(assets.get(a.name));
    }
    assert.equal(role, "observer");
    const body = options.body;
    if (route === "/git/refs" && method === "POST") {
      destination.tagRevision = JSON.parse(body).sha;
      return json({ ref: `refs/tags/${plan.github.tag}`, object: { type: "commit", sha: destination.tagRevision } }, 201);
    }
    if (route === "/releases" && method === "POST") {
      destination.release = { ...JSON.parse(body), id: 8, immutable: false }; return json(destination.release, 201);
    }
    if (route === "/releases/8/assets" && method === "POST") {
      const name = url.searchParams.get("name"), raw = Buffer.from(body);
      const asset = { id: 100 + destination.assets.length, name, byteLength: raw.length, sha256: sha256(raw) };
      destination.assets.push(asset); return json({ ...asset, size: raw.length, digest: `sha256:${sha256(raw)}`, state: "uploaded" }, 201);
    }
    if (route === "/releases/8" && method === "PATCH") {
      destination.release = { ...destination.release, ...JSON.parse(body), immutable: true }; return json(destination.release);
    }
    throw new Error(`unexpected closed fixture request ${method} ${route}`);
  };
  const clientApi = publicationGithub({ repository: plan.publisher.repository, token: "fixture-not-a-credential", readOnly: true,
    fetcher: fetcher("client") });
  const observerApi = publicationGithub({ repository: plan.publisher.repository, token: "fixture-not-a-credential",
    draftVisibility: "qualified-workflow-writer", fetcher: fetcher("observer") });
  const fresh = async () => {
    if (flags.revoked) throw Object.assign(new Error("synthetic revocation"), { code: "AUTHORITY_REVOKED" });
    verifyPublicationAuthority(plan, sha256(canonicalBytes(plan)), f.authorityObservation, f.policy.writerPolicySha256);
    return f.authorityObservation;
  };
  const record = await publicationRecord(f);
  const handoff = await prepareNpmCall({ plan, record, fresh, notes,
    inspectNpm: m => mode === "oidc" ? registry.inspect(plan, m) : Promise.resolve({ status: "requires-qualified-human-read" }),
    inspectGithub: () => observerApi.state(plan, new Map(plan.github.assets.map(a => [a.name, a]))) });
  const history = join(f.directory, "initial-history"); await mkdir(history);
  for (const [identity, path] of Object.entries(record.config.evidence)) await copyFile(path, join(history, `${identity}.json`));
  const root = join(f.directory, "client"), observerRoot = join(f.directory, "observer");
  for (const r of [root, observerRoot]) {
    for (const p of ["public-output", "gate", "private"]) await mkdir(join(r, p), { recursive: true });
  }
  const state = { plan, planSha256: sha256(canonicalBytes(plan)), context, policy: f.policy, api: clientApi, fresh };
  const observerState = { ...state, api: observerApi };
  const environment = { GH_TOKEN: "fixture-not-a-credential", TABGRAD_RECORD_INPUT: history, TABGRAD_PUBLICATION_CLIENT: "/fixture/client",
    TABGRAD_RECEIPT_ISSUE: "77" };
  const admission = { handoff, authorityObservation: f.authorityObservation, candidate,
    journal: await releaseRecord({ command: "read", config: record.config, expectedHead: record.head }) };
  const archivePath = join(f.directory, "candidate.tgz"), proofPath = join(f.directory, "proof.json");
  await writeFile(archivePath, archive); await writeFile(proofPath, proof);
  let calls = 0;
  const applyPublishedState = () => {
    pack.versions[plan.candidate.version] = { name: plan.candidate.name, version: plan.candidate.version,
      dist: { integrity: candidate.tarball.integrity, attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/fixture" } } };
    pack["dist-tags"][plan.npm.channel] = plan.candidate.version;
  };
  const ports = { identifyClient: async () => ({ manifestSha256: plan.publisher.clientSha256 }),
    registry, publish: async () => {
      calls++;
      applyPublishedState();
      return { dispatched: true, status: 0, stdout: JSON.stringify({ [plan.candidate.name]: {
        name: plan.candidate.name, version: plan.candidate.version, integrity: candidate.tarball.integrity } }) };
    } };
  const emit = async (kind, raw) => {
    const id = kind === "ready" ? 11 : 12;
    jobs.set(kind, { id, run_id: Number(context.runId), head_sha: context.revision,
      name: kind === "ready" ? (mode === "oidc" ? gateRoles.client : gateRoles.bootstrap) : gateRoles.observer,
      status: kind === "ready" ? "in_progress" : "completed", conclusion: kind === "ready" ? null : "success",
      steps: [{ name: gatePrefixes[kind] + sha256(raw), number: 3, status: "completed", conclusion: "success" },
        ...(kind === "ready" ? [{ name: "Await observed permission", number: 4, status: "in_progress", conclusion: null }] : [])] });
    const envelope = canonicalBytes({ member: `${kind}.json`, raw: raw.toString("base64") });
    packets.set(kind, { raw, metadata: { id, name: `publication-${kind}-${context.runId}-${sha256(raw)}`,
      digest: `sha256:${sha256(envelope)}`, size_in_bytes: envelope.length, expired: false, expires_at: plan.window.deadline,
      workflow_run: { id: Number(context.runId), head_sha: context.revision, head_branch: "main",
        repository_id: Number(context.repositoryId), head_repository_id: Number(context.repositoryId) } } });
  };
  const transfer = async (kind, destination_) => {
    await mkdir(destination_, { recursive: true });
    await writeFile(join(destination_, `${kind}.json`), packets.get(kind).raw, { flag: "wx" });
  };
  const material = { archive: archivePath, proof: proofPath, notes, assets, candidate };
  return { ...f, root, observerRoot, state, observerState, environment, admission, material, ports, registry, record,
    candidate, assets, destination, jobs, packets, flags, requests, comments, emit, transfer, applyPublishedState,
    clientApi: signal => publicationGithub({ repository: plan.publisher.repository, token: "fixture-not-a-credential",
      readOnly: true, fetcher: fetcher("client"), signal }), get calls() { return calls; } };
}
