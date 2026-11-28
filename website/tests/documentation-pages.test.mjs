import assert from "node:assert/strict";
import test from "node:test";
import { prepareDocumentationPages } from "../scripts/documentation-pages.mjs";
const source = "docs/concepts/a.md";
const browser = { source: "docs/reference/browser-package.md", body: '# Browser guide\n\n```html\n<script type="module">import "@tabgrad/tabgrad@0.4.0/index.js";</script>\n```\n' };
const python = { source: "docs/reference/python-host.md", body: '# Python guide\n\n```html title="index.html"\n<button>Run Python</button>\n```\n\n```javascript title="python-worker.js"\nimport "@tabgrad/tabgrad@0.4.0/python.js";\n```\n' };
const data = () => ({ groups: [{ version: "0.4.0", baselineRevision: "a".repeat(40), recordRevision: "b".repeat(40), correction: null, candidate: true,
  entries: [{ ...browser }, { ...python }, { source, body: "# Supported behavior\n\n## Setup\n\nLoad the matching runtime.\n" }], paths: new Set([source, browser.source, python.source]), directories: new Set() }],
  releases: [{ version: "0.4.0", support: { capabilities: [{ source }], environments: [{ links: [{ source, fragment: "setup" }] }] } }] });
test("pre-tag generation checks support links for the candidate before it becomes the selected runtime", () => {
  assert.equal(prepareDocumentationPages(data(), "0.3.0", "renderer", "").documents.length, 4);
  for (const mutate of [value => { value.releases[0].support.capabilities[0].source = "docs/concepts/missing.md"; },
    value => { value.releases[0].support.environments[0].links[0].fragment = "missing-heading"; }]) {
    const value = data(); mutate(value);
    assert.throws(() => prepareDocumentationPages(value, "0.3.0", "renderer", ""), /support/);
  }
});

test("candidate integration guides cannot retain another package version", () => {
  const value = data();
  value.groups[0].entries[0].body = browser.body.replace("0.4.0", "0.3.0");
  assert.throws(() => prepareDocumentationPages(value, "0.3.0", "renderer", ""), /package version/);
});

test("candidate completeness covers both guide presence and every future selected integration fence", () => {
  for (const mutate of [value => { value.groups[0].entries.splice(0, 1); }, value => { value.groups[0].entries.splice(1, 1); },
    value => { value.groups[0].entries[0].body = '# Browser guide\n\n@tabgrad/tabgrad@0.4.0\n'; },
    value => { value.groups[0].entries[1].body = python.body.replace('title="index.html"', 'title="missing.html"'); },
    value => { value.groups[0].entries[1].body = python.body.replace('title="python-worker.js"', 'title="missing.js"'); }]) {
    const value = data(); mutate(value);
    assert.throws(() => prepareDocumentationPages(value, "0.3.0", "renderer", ""), /integration|sample/);
  }
});

test("the operation matrix is static and version-local without duplicating Markdown headings", () => {
  const value = data();
  const group = value.groups[0];
  const compatibility = "docs/compatibility.md";
  group.entries.push({ source: compatibility, body: "# Compatibility\n\n## Tensor dtypes by operation\n\n### Arithmetic\n\n| Operation |\n| --- |\n| Add |\n\n### Storage and state\n\n| Operation |\n| --- |\n| View |\n\n## Evidence\n\nReviewed.\n" });
  group.paths.add(compatibility);
  group.operationCompatibility = { operations: [{
    id: "add", name: "torch.add", aliases: ["<add>"], module: "torch", source, fragment: "setup", limits: "Same dtype.",
    variants: [{ inputs: ["float32", "float32"], result: "float32",
      cpu: { status: "supported", gradients: "first-order" }, webgpu: { status: "unavailable", gradients: "not-applicable" } }],
  }] };
  const result = prepareDocumentationPages(value, "0.4.0", "renderer", "");
  const pages = result.prepared.filter(page => page.path.endsWith("compatibility/index.md"));
  assert.equal(pages.length, 2);
  assert.equal(result.documents.filter(document => document.operationCompatibility && document.source === compatibility).length, 2);
  for (const page of pages) {
    const body = page.adapted.render();
    assert.match(body, /<details [^>]+id="operation-add"/);
    assert.match(body, /href="\/docs\/0\.4\.0\/concepts\/a\/#setup"/);
    assert.match(body, /id="arithmetic"/);
    assert.match(body, /id="storage-and-state"/);
    assert.match(body, /&lt;add&gt;/);
    assert.match(body, /GPU: Unavailable/);
    assert.doesNotMatch(body, /### Arithmetic|\| Add \|/);
  }
  const entry = group.entries.find(entry => entry.source === compatibility);
  entry.body = entry.body.replace("### Arithmetic", "### Tensor operations");
  const [original] = group.operationCompatibility.operations;
  const supported = { status: "supported", gradients: "not-applicable" };
  group.operationCompatibility.operations.push({
    ...original, id: "gt", name: "torch.gt", aliases: [">"], limits: "Comparison returns a mask.",
    variants: [{ inputs: ["float32", "float32"], result: "bool", cpu: supported, webgpu: supported }],
  });
  const current = prepareDocumentationPages(value, "0.4.0", "renderer", "");
  for (const page of current.prepared.filter(page => page.path.endsWith("compatibility/index.md"))) {
    const body = page.adapted.render();
    assert.match(body, /id="tensor-operations"/);
    assert.match(body, /id="operation-gt"[^>]+data-dtypes="bool float32"/);
    assert.match(body, /float32, float32 → bool/);
    assert.doesNotMatch(body, /### Tensor operations|\| Add \|/);
  }
  group.operationCompatibility.operations[0].fragment = "missing";
  assert.throws(() => prepareDocumentationPages(value, "0.4.0", "renderer", ""), /version-local operation compatibility reference/);
});
