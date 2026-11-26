import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { browserVersion, resolveBrowser, selectBrowserDefinitions, startBrowserServer, runBrowserPage } from "../../scripts/browser-harness.mjs";
import { documentRoute, repositoryRoot, websiteRoot } from "./config.mjs";
import { gitDocumentationSource } from "./documentation-source.mjs";
import { readOperationCompatibility } from "../../scripts/operation-compatibility.mjs";
import { contentType, deliveryHeaders } from "./delivery.mjs";
import { writeChanged } from "./files.mjs";

const fixture = "documentation-browser.html";
const siteData = JSON.parse(await readFile(join(websiteRoot, ".generated/site-data.json"), "utf8"));
const compatibilitySource = "docs/compatibility.md";
const compatibility = siteData.documentationGroups.find(group => {
  const source = gitDocumentationSource(repositoryRoot, group.baselineRevision);
  return source.paths.has(compatibilitySource) && readOperationCompatibility(source.read(compatibilitySource)) !== undefined;
});
/** @param {string} path @returns {Promise<Buffer>} */
async function readAsset(path) {
  if (path.endsWith(`/js-tests/browser/${fixture}`)) return readFile(join(websiteRoot, "tests", fixture));
  return readFile((await stat(path)).isDirectory() ? join(path, "index.html") : path);
}
const server = await startBrowserServer([fixture], { distributionDirectory: join(websiteRoot, "dist"), readAsset,
  assetHeaders(path, body) {
    if (path === `/${fixture}`) return { "content-type": "text/html; charset=utf-8" };
    const html = path.endsWith("/") || path.endsWith(".html");
    return { "content-type": contentType(html ? "index.html" : path), ...deliveryHeaders(path, html ? body.toString("utf8") : "") };
  },
});
try {
  const reports = [];
  for (const browser of selectBrowserDefinitions(process.env.TABGRAD_BROWSER)) {
    const executable = await resolveBrowser(browser), version = browserVersion(executable);
    const result = await runBrowserPage({ server, browser, executable, version, page: fixture,
      parameters: { compatibility: compatibility ? documentRoute(compatibilitySource, compatibility.version) : "" },
      validateResult(report) {
        assert.equal(report.passed, true, report.error);
        assert.deepEqual(report.widths, [1280, 390]);
        assert.equal(report.operationCompatibility, compatibility !== undefined);
        return report;
      } });
    reports.push({ browser: browser.name, version, result });
    console.log(`${version}: versioned documentation integration passed`);
  }
  await writeChanged(join(websiteRoot, ".generated/documentation-browser-check.json"), JSON.stringify(reports, null, 2) + "\n");
} finally { await server.close(); }
