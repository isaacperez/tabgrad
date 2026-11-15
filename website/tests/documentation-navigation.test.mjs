import assert from "node:assert/strict";
import test from "node:test";
import { documentationPage, documentationVersionChoices, documentationSidebar, documentationSearchScope } from "../scripts/documentation-navigation.mjs";

const doc = (version, source, alias = false) => ({ version, source, alias, title: source,
  route: `/docs/${alias ? "" : version + "/"}${source === "docs/README.md" ? "" : source.slice(5, -3) + "/"}`,
  canonicalRoute: `/docs/${version}/${source === "docs/README.md" ? "" : source.slice(5, -3) + "/"}`, headings: ["intro"] });
const data = { runtimeVersion: "0.4.0", releases: [{ version: "0.4.0", available: true }, { version: "0.3.0", available: true }, { version: "0.2.0", available: false }],
  documents: [doc("0.4.0", "docs/README.md"), doc("0.3.0", "docs/README.md"), doc("0.4.0", "docs/javascript-api.md"),
    doc("0.3.0", "docs/javascript-api.md"), doc("0.4.0", "docs/javascript-api.md", true), doc("0.4.0", "docs/architecture/new.md")] };

test("version selection preserves pages and explicitly identifies missing historical pages", () => {
  assert.equal(documentationPage(data, "/docs/javascript-api/").version, "0.4.0");
  const choices = documentationVersionChoices(data, "/docs/javascript-api/");
  assert.equal(choices.length, 2);
  assert.equal(choices[1].href, "/docs/0.3.0/javascript-api/");
  const unavailable = documentationVersionChoices(data, "/docs/0.4.0/architecture/new/")[1];
  assert.deepEqual(unavailable, { version: "0.3.0", href: "/docs/0.3.0/?page=missing", missing: true, headings: ["intro"] });
  assert.equal(documentationPage(data, "/docs/0.3.0/architecture/new/"), undefined);
});

test("navigation and default search are local to the selected documentation version", () => {
  const sidebar = documentationSidebar(data, "/docs/0.3.0/javascript-api/");
  const links = sidebar.flatMap(group => group.type === "group" ? group.entries : [group]);
  assert.ok(links.every(entry => entry.type === "link" && entry.href.startsWith("/docs/0.3.0/")));
  assert.equal(links.filter(entry => entry.type === "link" && entry.isCurrent).length, 1);
  assert.deepEqual(documentationSearchScope(data, "/docs/0.3.0/javascript-api/"), "0.3.0");
  assert.deepEqual(documentationSearchScope(data, "/blog/"), "current");
});
