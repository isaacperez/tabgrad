import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { parseFragment } from "parse5";
import { createMarkdownProcessor, unified } from "@astrojs/markdown-remark";
import { references } from "../scripts/config.mjs";
import { collectDocuments, adaptDocument, createDocumentIndex, firstCodeBlock } from "../scripts/content.mjs";

test("named integration files come from their exact Markdown fences", () => {
  const source = '# Setup\n\n```javascript\nother example\n```\n\n```html title="index.html"\n<button>Run</button>\n```\n\n```javascript title="python-worker.js"\nawait runPython();\n```\n';
  assert.equal(firstCodeBlock(source, "javascript"), "other example");
  assert.equal(firstCodeBlock(source, "javascript", "python-worker.js"), "await runPython();");
  assert.equal(firstCodeBlock(source, "html", "index.html"), "<button>Run</button>");
  assert.throws(() => firstCodeBlock(source, "javascript", "missing.js"), /No .*sample/);
  assert.throws(() => firstCodeBlock(source + '\n```javascript title="python-worker.js"\nduplicate\n```\n', "javascript", "python-worker.js"), /Duplicate/);
});

test("documentation summaries describe their own first paragraph without copying Markdown syntax", () => {
  const docs = createDocumentIndex([
    { source: "docs/concepts/a.md", body: '# Shapes\n\nA **shape** describes `dimensions`.\nRead [examples](#examples) with ![an illustration](image.svg).\n\n## Examples\n\nLater text.\n' },
    { source: "docs/reference/b.md", body: '# Sum\n\n```python\nnot_a_summary()\n```\n\nAdd all tensor values.\n' },
    { source: "docs/concepts/empty.md", body: '# Index\n\n- [Shapes](a.md)\n' },
  ]);
  assert.equal(docs.get("docs/concepts/a.md").description, "A shape describes dimensions. Read examples with an illustration.");
  assert.equal(docs.get("docs/reference/b.md").description, "Add all tensor values.");
  assert.equal(docs.get("docs/concepts/empty.md").description, "Index");
});

test("editorial summaries describe decision chapters rather than their acceptance notices", () => {
  const docs = createDocumentIndex([{ source: "docs/architecture/browser-distribution.md", body: "# Versioned browser distribution\n\n**Decision:** accepted on a recorded date.\n\nThe distribution design follows.\n" }]);
  assert.equal(docs.get("docs/architecture/browser-distribution.md").description, "How Tabgrad keeps JavaScript, Python, workers and numerical assets together in one versioned browser distribution.");
});

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
  assert.match(result.render(), /\[Read\]\(\/docs\/reference\/b\/#values\)/);
  assert.match(result.render(), /blob\/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\/CONTRIBUTING\.md/);
  assert.match(result.render(), /const a = '\[literal\]\(\.\.\/reference\/b\.md\)';/);
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
  const sizes = new Map([[result.diagrams[0].id, { width: 700, height: 320 }]]);
  const rendered = result.render(sizes);
  assert.match(rendered, /width="700" height="320"/);
  assert.match(rendered, /Diagram source/);
  assert.match(rendered, /<a href="\/diagrams\/[a-f0-9]+\.svg">Open full-size diagram<\/a>/);
  assert.match(rendered, /class="diagram-viewport" tabindex="0" role="group" aria-label="Scrollable diagram: One: One"/);
  assert.equal(textContent(findElement(parseFragment(rendered), "code")), result.diagrams[0].definition);
});

test("Markdown rendering keeps multiline diagram source separate from the chapter", async () => {
  const source = "docs/concepts/a.md";
  const definition = 'flowchart LR\n A["Input <value> & &#10;"] --> B[Output]\n\n %% A blank line is valid Mermaid\n B --> C[Done]';
  const body = `# One\n\n\`\`\`mermaid\n${definition}\n\`\`\`\n\n## Read this next\n\nThis explanation must remain visible.\n\n- A chapter step\n\n\`\`\`mermaid\nflowchart LR\n D --> E\n\`\`\`\n\n## Final section\n\nThe chapter continues.\n`;
  const docs = createDocumentIndex([{ source, body }]);
  const adapted = adaptDocument({ source, body }, docs, "a".repeat(40));
  const processor = await createMarkdownProcessor({ processor: unified({ smartypants: false }) });
  const html = parseFragment((await processor.render(adapted.render())).code);
  const disclosure = findElement(html, "details");
  assert.equal(findElement(disclosure, "h2"), undefined, "the closed disclosure must not hide chapter headings");
  assert.equal(findElement(disclosure, "p"), undefined, "the closed disclosure must not hide chapter prose");
  assert.equal(textContent(findElement(disclosure, "code")), definition, "source remains exact, including blank lines, HTML characters and literal entities");
  assert.equal(html.childNodes.filter(node => node.tagName === "details").length, 2, "diagrams remain independent siblings");
  assert.equal(html.childNodes.filter(node => node.tagName === "h2").length, 2, "both following sections remain chapter siblings");
});

test("the documented remote diagnostics example uses the connected binding and closes it first", async () => {
  const body = await readFile(new URL("../../docs/reference/python-host.md", import.meta.url), "utf8");
  const section = body.split("## Read managed GPU observations\n")[1]?.split("\n## ")[0];
  assert.ok(section);
  const events = [];
  const binding = { async close() { events.push("binding close"); } };
  const gpu = { diagnostics() { events.push("snapshot"); return { adapter: { vendor: "test" }, kernelCalls: 1, state: "closed", ownedBufferBytes: 0, unknownCompletionBytes: 0 }; }, async close() { events.push("gpu close"); } };
  const execute = new (async function() {}).constructor("binding", "gpu", "console", firstCodeBlock(section, "javascript"));
  await execute(binding, gpu, { log() {} });
  assert.deepEqual(events, ["snapshot", "binding close", "gpu close", "snapshot"]);
});

test("diagram sizing never rewrites an executable sample that resembles generated HTML", () => {
  const source = "docs/concepts/a.md";
  const literal = `<img src="/diagrams/${"a".repeat(64)}.svg" alt="literal">`;
  const body = `# One\n\n\`\`\`javascript\nconsole.log('${literal}');\n\`\`\`\n`;
  const docs = createDocumentIndex([{ source, body }]);
  const result = adaptDocument({ source, body }, docs, "a".repeat(40));
  assert.match(result.render(new Map()), new RegExp(`console.log\\('.*alt="literal">'\\);`));
  assert.ok(result.render(new Map()).includes(literal));
});

test("public usage references exclude contributor qualification procedures", () => {
  assert.ok(!references.includes("browser-diagnostics"));
  assert.ok(references.includes("python-host") && references.includes("webgpu-runtime"));
});
