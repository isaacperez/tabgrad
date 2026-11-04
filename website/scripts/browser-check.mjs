import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { browserVersion, resolveBrowser, selectBrowserDefinitions, startBrowserServer, runBrowserPage } from "../../scripts/browser-harness.mjs";
import { websiteRoot } from "./config.mjs";
import { contentType, deliveryHeaders } from "./delivery.mjs";
import { writeChanged } from "./files.mjs";

import { exampleSource } from "../src/playground/presets.ts";
const fixture = "website-smoke.html";
const requestedAssets = new Set();
/** Adapt only the registered fixture; all app requests read the built output.
 * @param {string} path @returns {Promise<Buffer>}
 */
async function readAsset(path) {
  if (path.endsWith("/js-tests/browser/" + fixture)) return readFile(join(websiteRoot, "tests/browser.html"));
  if (path === join(websiteRoot, "dist/__examples.json")) {
    const catalog = JSON.parse(await readFile(join(websiteRoot, "src/playground/examples.json"), "utf8"));
    return Buffer.from(JSON.stringify(catalog.map((example) => ({ ...example, python: { ...example.python, code: exampleSource(example, "python", "cpu") }, javascript: { ...example.javascript, code: exampleSource(example, "javascript", "cpu") } }))));
  }
  if (path === join(websiteRoot, "dist/__requests.json")) return Buffer.from(JSON.stringify([...requestedAssets]));
  requestedAssets.add(relative(join(websiteRoot, "dist"), path));
  return readFile((await stat(path)).isDirectory() ? join(path, "index.html") : path);
}
const server = await startBrowserServer([fixture], {
  distributionDirectory: join(websiteRoot, "dist"), readAsset,
  assetHeaders(path, body) {
    // The fixture drives the app; app and worker retain the preview's real CSP.
    if (path === "/" + fixture || path === "/__examples.json") return { "content-type": contentType(path) };
    const html = path.endsWith("/") || path.endsWith(".html");
    return { "content-type": contentType(html ? "index.html" : path), ...deliveryHeaders(path, html ? body.toString("utf8") : "") };
  },
});
try {
  if (process.argv.includes("--serve")) {
    console.log(`${server.origin}/${fixture}`);
    process.once("SIGINT", () => server.close());
    process.once("SIGTERM", () => server.close());
  } else {
    const reports = [];
    for (const browser of selectBrowserDefinitions(process.env.TABGRAD_BROWSER)) {
      requestedAssets.clear();
      const executable = await resolveBrowser(browser);
      const version = browserVersion(executable);
      const result = await runBrowserPage({ server, browser, executable, version, page: fixture,
        applicationTimeoutMilliseconds: 150000,
        validateResult(report) { assert.equal(report.passed, true, report.error); assert.equal(report.cases.length, 11); return report; },
      });
      reports.push({ browser: browser.name, version, result });
      console.log(`${version}: website CPU integration passed`);
    }
    await writeChanged(join(websiteRoot, ".generated/browser-check.json"), JSON.stringify(reports, null, 2) + "\n");
    await server.close();
  }
} catch (error) { await server.close(); throw error; }
