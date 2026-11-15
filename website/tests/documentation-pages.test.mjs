import assert from "node:assert/strict";
import test from "node:test";
import { prepareDocumentationPages } from "../scripts/documentation-pages.mjs";
const source = "docs/concepts/a.md";
const data = () => ({ groups: [{ version: "0.4.0", baselineRevision: "a".repeat(40), recordRevision: "b".repeat(40), correction: null, candidate: true,
  entries: [{ source, body: "# Supported behavior\n\n## Setup\n\nLoad the matching runtime.\n" }], paths: new Set([source]), directories: new Set() }],
  releases: [{ version: "0.4.0", support: { capabilities: [{ source }], environments: [{ links: [{ source, fragment: "setup" }] }] } }] });
test("pre-tag generation checks support links for the candidate before it becomes the selected runtime", () => {
  assert.equal(prepareDocumentationPages(data(), "0.3.0", "renderer", "").documents.length, 2);
  for (const mutate of [value => { value.releases[0].support.capabilities[0].source = "docs/concepts/missing.md"; },
    value => { value.releases[0].support.environments[0].links[0].fragment = "missing-heading"; }]) {
    const value = data(); mutate(value);
    assert.throws(() => prepareDocumentationPages(value, "0.3.0", "renderer", ""), /support/);
  }
});

test("candidate integration guides cannot retain another package version", () => {
  const value = data(), path = "docs/reference/browser-package.md";
  value.groups[0].entries.push({source:path,body:'# Browser guide\n\n```html\n<script type="module">import { createSession } from "https://cdn.example.invalid/@tabgrad/tabgrad@0.3.0/dist/index.js";</script>\n```\n'});
  value.groups[0].paths.add(path);
  assert.throws(() => prepareDocumentationPages(value, "0.3.0", "renderer", ""), /package version/);
});
