import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { browserVersion, resolveBrowser, selectBrowserDefinitions, startBrowserServer, runBrowserPage } from "../../scripts/browser-harness.mjs";
import { websiteRoot } from "./config.mjs";
import { contentType, deliveryHeaders } from "./delivery.mjs";
import { writeChanged } from "./files.mjs";

const fixture = "documentation-browser.html";
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
      validateResult(report) { assert.equal(report.passed, true, report.error); assert.deepEqual(report.widths, [1280, 390]); return report; } });
    reports.push({ browser: browser.name, version, result });
    console.log(`${version}: versioned documentation integration passed`);
  }
  await writeChanged(join(websiteRoot, ".generated/documentation-browser-check.json"), JSON.stringify(reports, null, 2) + "\n");
} finally { await server.close(); }
