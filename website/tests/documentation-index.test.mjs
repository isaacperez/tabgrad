import assert from "node:assert/strict";
import test from "node:test";
import { validateDocumentationIndex, preserveDocumentationArchives } from "../scripts/documentation-index.mjs";
const group = version => ({ version, baselineRevision: "a".repeat(40), recordRevision: "b".repeat(40), recordSha256: "c".repeat(64), correction: null,
  documents: [{ source: "docs/README.md", route: `/docs/${version}/` }, { source: "docs/reference/a.md", route: `/docs/${version}/reference/a/` }] });
const index = versions => ({ schemaVersion: 1, stableVersion: versions[0], renderingRevision: "b".repeat(40), versions: versions.map(group) });
test("documentation inventory rejects malformed and ambiguous public routes", () => {
  const original = index(["0.3.0"]); validateDocumentationIndex(original);
  for (const route of ["/docs/0.3.0/../a/", "/docs/0.3.0/a?wrong/", "/docs/0.3.0/a\\wrong/", "/docs/0.3.0/a//", "/docs/0.4.0/"]) {
    const changed = structuredClone(original); changed.versions[0].documents[1].route = route;
    assert.throws(() => validateDocumentationIndex(changed), /route/);
  }
});
test("archive presentation can be corrected without rebasing, dropping versions or retiring routes", () => {
  const earlier = index(["0.3.0"]), later = index(["0.4.0", "0.3.0"]);
  later.versions[1].correction = { path: "website/content/corrections/0.3.0.json", revision: "d".repeat(40), sha256: "e".repeat(64) };
  preserveDocumentationArchives(earlier, later);
  for (const mutate of [value => { value.versions.pop(); }, value => { value.versions[1].baselineRevision = "d".repeat(40); },
    value => { value.versions[1].documents.pop(); }]) {
    const changed = structuredClone(later); mutate(changed);
    assert.throws(() => preserveDocumentationArchives(earlier, changed), /archive|baseline|route/);
  }
});
