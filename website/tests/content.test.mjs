import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { parseFragment } from "parse5";
import { collectDocuments, adaptDocument, createDocumentIndex } from "../scripts/content.mjs";

function textContent(node) {
  return node.nodeName === "#text" ? node.value : (node.childNodes ?? []).map(textContent).join("");
}

function findElement(node, name) {
  if (node.tagName === name) return node;
  for (const child of node.childNodes ?? []) {
    const found = findElement(child, name);
    if (found) return found;
  }
}

test("selected source discovery excludes operational and ignored material", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "tabgrad-site-docs-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "docs/concepts"), { recursive: true });
  await mkdir(join(root, "docs/reference"), { recursive: true });
  await mkdir(join(root, "local"), { recursive: true });
  await writeFile(join(root, "docs/concepts/shape.md"), "# A shape\n");
  await writeFile(join(root, "docs/concepts/untracked-notes.md"), "# Not admitted\n");
  await writeFile(join(root, "docs/reference/release-record.md"), "# Operational record\n");
  await writeFile(join(root, "local/private.md"), "# Local\n");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "docs/concepts/shape.md", "docs/reference/release-record.md"], { cwd: root });
  const selected = await collectDocuments(root, { directories: ["concepts"], individual: [] });
  assert.deepEqual(selected.map((entry) => entry.source), ["docs/concepts/shape.md"]);
});

test("source links, fragments, code and headings retain their meanings", () => {
  const docs = createDocumentIndex([
    { source: "docs/concepts/a.md", body: "# One\n\n## Repeated\n\n## Repeated\n" },
    { source: "docs/reference/b.md", body: "# Two\n\n## Values\n" },
  ]);
  const body = "# One\n\n[Read](../reference/b.md#values) and [source](../../CONTRIBUTING.md).\n\n```javascript\nconst a = '[literal](../reference/b.md)';\n```\n";
  const result = adaptDocument({ source: "docs/concepts/a.md", body }, docs, "a".repeat(40));
  assert.match(result.markdown, /\[Read\]\(\/docs\/reference\/b\/#values\)/);
  assert.match(result.markdown, /blob\/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\/CONTRIBUTING\.md/);
  assert.match(result.markdown, /const a = '\[literal\]\(\.\.\/reference\/b\.md\)';/);
  assert.deepEqual(docs.get("docs/concepts/a.md").headings, ["one", "repeated", "repeated-1"]);
});

test("bad fragments and collisions fail instead of becoming home links", () => {
  assert.throws(() => createDocumentIndex([
    { source: "docs/concepts/README.md", body: "# A\n" },
    { source: "docs/concepts/readme.md", body: "# B\n" },
  ]), /collision/i);
  const docs = createDocumentIndex([{ source: "docs/concepts/a.md", body: "# One\n" }]);
  assert.throws(() => adaptDocument({ source: "docs/concepts/a.md", body: "# One\n\n[Bad](#missing)\n" }, docs, "a".repeat(40)), /fragment/i);
  assert.throws(() => adaptDocument({ source: "docs/concepts/a.md", body: "# One\n\n[Bad](..\/..\/..\/private.md)\n" }, docs, "a".repeat(40)), /outside/i);
});

test("diagrams remain attributable and preserve their source", () => {
  const source = "docs/concepts/a.md";
  const body = "# One\n\n```mermaid\nflowchart LR\n A[Input] --> B[Output]\n```\n";
  const docs = createDocumentIndex([{ source, body }]);
  const result = adaptDocument({ source, body }, docs, "a".repeat(40));
  assert.equal(result.diagrams.length, 1);
  assert.match(result.diagrams[0].definition, /A\[Input\] --> B\[Output\]/);
  assert.match(result.markdown, /\/diagrams\/[^\s)]+\.svg/);
  assert.match(result.markdown, /Diagram source/);
  assert.match(result.markdown, /<a href="\/diagrams\/[a-f0-9]+\.svg">Open full-size SVG<\/a>/);
  assert.equal(textContent(findElement(parseFragment(result.markdown), "code")), result.diagrams[0].definition);
});
