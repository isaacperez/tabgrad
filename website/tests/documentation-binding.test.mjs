import assert from "node:assert/strict";
import test from "node:test";
import { documentationBaseline, loadReleaseData } from "../scripts/release-data.mjs";

import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(root, ...args) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, encoding: "utf8" }).trim();
}

test("completed documentation retains its exact baseline after main advances or recovery changes the recipe", async t => {
  const root = await mkdtemp(join(tmpdir(), "tabgrad-doc-binding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "docs/reference"), { recursive: true });
  await mkdir(join(root, "website"));
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.4.0" }));
  await writeFile(join(root, "CHANGELOG.md"), "## 0.4.0 - 2026-11-15\n\n### Added\n\n- Broadcast compatible tensor shapes.\n");
  const support = { summary: "Calculate locally.", capabilities: [{ title: "Arithmetic", description: "Add tensors.", source: "docs/reference/a.md" }],
    environments: [{ title: "CPU", usage: "Default", tested: "Chrome", setup: "Load the package.", links: [{ label: "Setup", source: "docs/reference/a.md" }] }], limits: [{ title: "Data", description: "Float32." }] };
  await writeFile(join(root, "docs/reference/release-0.4.0.md"), `# Tabgrad 0.4.0 source and support record\n\n<!-- tabgrad-release\n${JSON.stringify({ schemaVersion: 1, version: "0.4.0", title: "Broadcasting", documentationImpact: "Updated arithmetic references.", support })}\n-->\n`);
  await writeFile(join(root, "docs/reference/a.md"), "# Released behavior\n");
  await writeFile(join(root, "website/release-catalogue.json"), JSON.stringify({ schemaVersion: 1, releases: [{ version: "0.4.0", source: "candidate", documentation: { directories: [], individual: ["docs/reference/a.md"] } }] }));
  git(root, "init", "--quiet"); git(root, "add", "."); git(root, "commit", "--quiet", "-m", "Released source");
  const released = git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "docs/reference/a.md"), "# Future behavior\n");
  git(root, "commit", "--quiet", "-am", "Advance main");
  const later = git(root, "rev-parse", "HEAD");
  const loaded = await loadReleaseData(root, "0.4.0", { release: { version: "0.4.0", sourceRevision: released }, candidateRevision: later, publication: true });
  assert.equal(loaded.groups[0].baselineRevision, released);
  assert.equal(loaded.groups[0].entries[0].body, "# Released behavior\n");
});

test("candidate previews require explicit validation and cannot enter a publication without completion", () => {
  const entry = { version: "0.4.0", source: "candidate" }, revision = "a".repeat(40);
  assert.throws(() => documentationBaseline(entry, {}), /candidate/);
  assert.deepEqual(documentationBaseline(entry, { candidateRevision: revision }), { revision, candidate: true });
  assert.equal(documentationBaseline(entry, { candidateRevision: revision, publication: true }), null);
  assert.throws(() => documentationBaseline({ ...entry, source: "b".repeat(40) }, { release: { version: entry.version, sourceRevision: revision } }), /differs/);
});
