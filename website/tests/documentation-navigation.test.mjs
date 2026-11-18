import assert from "node:assert/strict";
import test from "node:test";
import { documentationPage, documentationNavigation, documentationVersionChoices, documentationSidebar, documentationSearchScope } from "../scripts/documentation-navigation.mjs";

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

test("reference navigation exposes admitted dtype and memory guides only in their own version", () => {
  const sources = ["docs/reference/float16.md", "docs/reference/memory-capacity.md"];
  const releaseData = { runtimeVersion: "0.5.0", releases: [{ version: "0.5.0", available: true }, { version: "0.4.0", available: true }],
    documents: [doc("0.5.0", "docs/README.md"), doc("0.4.0", "docs/README.md"), ...sources.map(source => doc("0.5.0", source))] };
  const current = documentationSidebar(releaseData, "/docs/0.5.0/reference/float16/");
  const reference = current.find(group => group.type === "group" && group.label === "API reference");
  assert.ok(reference, "Admitted reference guides must be reachable from the sidebar");
  assert.deepEqual(reference.entries.map(entry => [entry.href, entry.isCurrent]), [
    ["/docs/0.5.0/reference/float16/", true], ["/docs/0.5.0/reference/memory-capacity/", false],
  ]);
  const historical = documentationSidebar(releaseData, "/docs/0.4.0/");
  assert.ok(!historical.some(group => group.type === "group" && group.label === "API reference"));
});

test("onboarding navigation follows only the current runtime while historical setup remains version-local", () => {
  const links = version => documentationSidebar(data, `/docs/${version}/javascript-api/`).flatMap(group => group.type === "group" ? group.entries : [group]);
  assert.ok(links("0.4.0").some(link => link.href === "/start/"));
  assert.ok(!links("0.3.0").some(link => link.href === "/start/"));
});

test("global documentation navigation keeps a historical version and uses stable entry outside docs", () => {
  assert.deepEqual(documentationNavigation(data, "/docs/0.3.0/javascript-api/"), { href: "/docs/0.3.0/", current: true });
  assert.deepEqual(documentationNavigation(data, "/docs/javascript-api/"), { href: "/docs/0.4.0/", current: true });
  assert.deepEqual(documentationNavigation(data, "/start/"), { href: "/docs/", current: false });
});
