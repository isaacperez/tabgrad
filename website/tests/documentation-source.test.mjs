import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { gitDocumentationSource, admittedSourceDocuments, correctSourceDocuments } from "../scripts/documentation-source.mjs";

function git(root, ...args) {
  return execFileSync("git", ["-c", "user.name=Documentation fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, encoding: "utf8" }).trim();
}

test("two exact source revisions expose their own pages and regular repository targets", async t => {
  const root = await mkdtemp(join(tmpdir(), "tabgrad-doc-sources-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "docs/concepts"), { recursive: true });
  await writeFile(join(root, "docs/concepts/a.md"), "# Earlier shape\n");
  git(root, "init", "--quiet"); git(root, "add", "."); git(root, "commit", "--quiet", "-m", "Earlier documentation");
  const earlier = git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "docs/concepts/a.md"), "# New shape\n");
  await writeFile(join(root, "docs/concepts/b.md"), "# New operation\n");
  await symlink("a.md", join(root, "docs/concepts/link.md"));
  git(root, "add", "."); git(root, "commit", "--quiet", "-m", "Later documentation");
  const later = git(root, "rev-parse", "HEAD");
  const oldSource = gitDocumentationSource(root, earlier), newSource = gitDocumentationSource(root, later);
  assert.equal(oldSource.read("docs/concepts/a.md"), "# Earlier shape\n");
  assert.equal(newSource.read("docs/concepts/a.md"), "# New shape\n");
  assert.equal(oldSource.paths.has("docs/concepts/b.md"), false);
  assert.equal(newSource.paths.has("docs/concepts/b.md"), true);
  assert.throws(() => newSource.read("docs/concepts/link.md"), /regular/);
  assert.throws(() => admittedSourceDocuments(newSource, { directories: ["concepts"], individual: [] }), /Nonregular/);
  assert.throws(() => gitDocumentationSource(root, "HEAD"), /exact commit/);
  assert.throws(() => oldSource.read("../outside.md"), /regular/);
  assert.equal(admittedSourceDocuments(oldSource, { directories: ["concepts"], individual: [] }).length, 1);
  assert.throws(() => admittedSourceDocuments(oldSource, { directories: [], individual: ["docs/concepts/b.md"] }), /Missing admitted/);
});

test("corrections retain an exact baseline and reject changed, absent, repeated or ambiguous text", () => {
  const revision = "a".repeat(40), source = "docs/concepts/a.md", body = "# Shape\n\nA typo.\n";
  const change = { source, baselineSha256: createHash("sha256").update(body).digest("hex"), replacements: [{ find: "A typo.", replace: "A corrected explanation." }] };
  const record = { schemaVersion: 1, version: "0.3.0", baseline: revision, documents: [change] };
  const apply = value => correctSourceDocuments([{ source, body }], JSON.stringify(value), "0.3.0", revision);
  const corrected = apply(record);
  assert.equal(corrected.documents[0].body, "# Shape\n\nA corrected explanation.\n");
  assert.match(corrected.sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => apply({ ...record, baseline: "b".repeat(40) }), /Invalid/);
  assert.throws(() => apply({ ...record, documents: [{ ...change, baselineSha256: "b".repeat(64) }] }), /baseline changed/);
  assert.throws(() => apply({ ...record, documents: [change, change] }), /repeated/);
  assert.throws(() => apply({ ...record, documents: [{ ...change, replacements: [{ find: "Missing", replace: "x" }] }] }), /absent/);
  const ambiguous = "# Shape\n\nA typo. A typo.\n";
  assert.throws(() => correctSourceDocuments([{ source, body: ambiguous }], JSON.stringify({ ...record, documents: [{ ...change, baselineSha256: createHash("sha256").update(ambiguous).digest("hex") }] }), "0.3.0", revision), /Ambiguous/);
});
