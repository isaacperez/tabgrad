import { setupNavigation, referenceNavigation } from "./config.mjs";

/** @typedef {{source:string,title:string,route:string,canonicalRoute:string,version:string,headings:string[],alias:boolean}} Document */
/** @typedef {{runtimeVersion:string,documents:Document[],releases:{version:string,available:boolean}[]}} DocumentationData */

/** @param {DocumentationData} data @param {string} path @returns {Document|undefined} */
export function documentationPage(data, path) {
  return data.documents.find(entry => entry.route === (path.endsWith("/") ? path : path + "/"));
}

/** Shared entry navigation keeps an already selected documentation version.
 * @param {DocumentationData} data @param {string} path @returns {{href:string,current:boolean}} */
export function documentationNavigation(data, path) {
  const document = documentationPage(data, path);
  return { href: document ? `/docs/${document.version}/` : "/docs/", current: document !== undefined };
}

/** @param {DocumentationData} data @param {string} path
 * @returns {{version:string,href:string,missing:boolean,headings:string[]}[]} */
export function documentationVersionChoices(data, path) {
  const current = documentationPage(data, path);
  return data.releases.filter(release => release.available).map(release => {
    const exact = data.documents.find(entry => !entry.alias && entry.version === release.version && entry.source === (current?.source ?? "docs/README.md"));
    const overview = data.documents.find(entry => !entry.alias && entry.version === release.version && entry.source === "docs/README.md");
    if (!overview) throw new Error("Documentation version has no overview");
    return { version: release.version, href: (exact ?? overview).canonicalRoute + (exact ? "" : "?page=missing"), missing: exact === undefined, headings: (exact ?? overview).headings };
  });
}

/** @param {Document|undefined} document @param {string} current @param {string} [label]
 * @returns {import('@astrojs/starlight/route-data').StarlightRouteData['sidebar']} */
function sidebarLink(document, current, label) {
  return document ? navigationLink(document.canonicalRoute, label ?? document.title, document.source === current) : [];
}

/** @param {string} href @param {string} label @param {boolean} isCurrent
 * @returns {import('@astrojs/starlight/route-data').StarlightRouteData['sidebar']} */
function navigationLink(href, label, isCurrent) {
  return [{ type: "link", label, href, isCurrent, badge: undefined, attrs: {} }];
}

/** @param {string} label @param {import('@astrojs/starlight/route-data').StarlightRouteData['sidebar']} entries @param {boolean} collapsed
 * @returns {import('@astrojs/starlight/route-data').StarlightRouteData['sidebar']} */
function sidebarGroup(label, entries, collapsed) {
  return entries.length ? [{ type: "group", label, entries, collapsed, badge: undefined }] : [];
}

/** @param {DocumentationData} data @param {string} path
 * @returns {import('@astrojs/starlight/route-data').StarlightRouteData['sidebar']} */
export function documentationSidebar(data, path) {
  const current = documentationPage(data, path);
  if (!current) return [];
  const documents = data.documents.filter(entry => !entry.alias && entry.version === current.version);
  const bySource = new Map(documents.map(entry => [entry.source, entry]));
  const start = [...sidebarLink(bySource.get("docs/README.md"), current.source, "Documentation"),
    ...(current.version === data.runtimeVersion ? navigationLink("/start/", "Get started", false) : []),
    ...setupNavigation.flatMap(([name, label]) => sidebarLink(bySource.get(`docs/reference/${name}.md`), current.source, label))];
  const reference = [...sidebarLink(bySource.get("docs/javascript-api.md"), current.source, "JavaScript API"),
    ...referenceNavigation.flatMap(([name, label]) => sidebarLink(bySource.get(`docs/reference/${name}.md`), current.source, label)),
    ...sidebarLink(bySource.get("docs/compatibility.md"), current.source, "Compatibility")];
  const result = [...sidebarGroup("Start here", start, false), ...sidebarGroup("API reference", reference, true)];
  for (const directory of ["concepts", "architecture", "components", "flows"]) {
    const entries = documents.filter(entry => entry.source.startsWith(`docs/${directory}/`))
      .sort((a, b) => Number(!a.source.endsWith("/README.md")) - Number(!b.source.endsWith("/README.md")) || a.title.localeCompare(b.title));
    result.push(...sidebarGroup(directory[0].toUpperCase() + directory.slice(1), entries.flatMap(entry => sidebarLink(entry, current.source, entry.source.endsWith("/README.md") ? "Overview" : undefined)), true));
  }
  return result;
}

/** A single scope avoids intersecting mutually exclusive documentation versions.
 * @param {DocumentationData} data @param {string} path @returns {string} */
export function documentationSearchScope(data, path) {
  const current = documentationPage(data, path);
  return current?.version ?? "current";
}
