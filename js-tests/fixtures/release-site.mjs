import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readyFixture } from "./tag-release.mjs";
import { completedRelease } from "../../scripts/release-website.mjs";

export async function siteFixture(t, { website } = {}) {
  const f = await readyFixture(t);
  if (website) f.plan.website = website;
  const descriptor = { schemaVersion: 1, plan: f.plan, publisher: { runId: "601", attempt: "1" },
    inventory: f.bytes.toString("base64"), releaseId: "701", environment: f.profile.tagDelivery.websiteEnvironment };
  const selected = completedRelease(descriptor);
  f.values.set("/actions/runs/601", { ...f.values.get("/actions/runs/301"), id: 601, status: "in_progress", conclusion: null });
  f.values.set("/actions/runs/601/attempts/1/jobs?per_page=100", { total_count: 1, jobs: [{ name: "complete-github-release",
    run_id: 601, head_sha: f.plan.publisher.revision, status: "completed", conclusion: "success", steps: [{
      name: `Completed release ${selected.sha256}`, status: "completed", conclusion: "success" }] }] });
  const artifact = { id: "902", sha256: "b".repeat(64) };
  f.values.set("/actions/artifacts/902", { id: 902, name: "tabgrad-publication-completion-601-1", digest: `sha256:${artifact.sha256}`, expired: false,
    workflow_run: { id: 601, head_sha: f.plan.publisher.revision, repository_id: 17 } });
  const current = { release: { id: 701, draft: false, prerelease: false, immutable: true, tag_name: f.plan.github.tag } };
  f.values.set("/releases/701", current.release);
  f.values.set(`/git/ref/tags/${f.plan.github.tag}`, { object: { type: "tag", sha: "e".repeat(40) } });
  f.values.set(`/git/tags/${"e".repeat(40)}`, { object: { type: "commit", sha: f.plan.candidate.sourceRevision } });
  const assets = [];
  for (const [index, asset] of f.plan.github.assets.entries()) {
    assets.push({ id: 1000 + index, name: asset.name, size: asset.byteLength, state: "uploaded" });
    f.values.set(`/releases/assets/${1000 + index}`, await readFile(asset.kind === "archive" ? f.tarball
      : asset.kind === "inventory" ? join(f.root, "data/candidate.json")
      : asset.kind.endsWith("-proof") ? join(f.root, "proofs", `${asset.kind}.json`)
      : join(f.root, "input", asset.kind === "evidence" ? "producer-evidence.json" : "release-checksums.txt")));
  }
  f.values.set("/releases/701/assets?per_page=100&page=1", assets);
  const api = f.api;
  return { ...f, environment: { ...f.environment, GITHUB_RUN_ID: "601" }, descriptor, selected, artifact, current, api };
}

