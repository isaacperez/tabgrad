import { firstCodeBlock } from "./content.mjs";

/** Build downloads from the same source values used by the page, never maintained copies.
 * HTML downloads are text responses with explicit download filenames: visiting
 * a source URL cannot execute its CDN code as another website route.
 * @param {{integrationHtml:string,integrationPythonHtml:string,integrationPythonWorker:string}} data */
export function integrationFiles(data) {
  const html = `<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Tabgrad · JavaScript in your browser</title>\n${data.integrationHtml}\n</html>\n`;
  return [
    { path: "examples/javascript/index.html.txt", name: "index.html", body: html },
    { path: "examples/python/index.html.txt", name: "index.html", body: data.integrationPythonHtml },
    { path: "examples/python/python-worker.js.txt", name: "python-worker.js", body: data.integrationPythonWorker },
  ];
}

/** Read both guides from one admitted archive, with no fallback to current main.
 * @param {object} group @returns {{browser:string,python:string}} */
export function integrationGuides(group) {
  const browser = group?.entries.find(entry => entry.source === "docs/reference/browser-package.md")?.body;
  const python = group?.entries.find(entry => entry.source === "docs/reference/python-host.md")?.body;
  if (browser === undefined || python === undefined) throw new Error("Release has no complete integration guides");
  return { browser, python };
}

/** Every admitted candidate must satisfy the same tutorial consumer as a release.
 * @param {object} group @returns {{integrationHtml:string,integrationPythonHtml:string,integrationPythonWorker:string}} */
export function integrationSource(group) {
  const guides = integrationGuides(group);
  for (const body of Object.values(guides)) {
    const pins = [...body.matchAll(/@tabgrad\/tabgrad@([^/"'`\s<>]+)/g)];
    if (!pins.length || pins.some(match => match[1] !== group.version)) throw new Error("Integration guide package version differs from documentation version");
  }
  return { integrationHtml: firstCodeBlock(guides.browser, "html"),
    integrationPythonHtml: firstCodeBlock(guides.python, "html", "index.html"),
    integrationPythonWorker: firstCodeBlock(guides.python, "javascript", "python-worker.js") };
}
