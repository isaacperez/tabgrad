import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { browserVersion, resolveBrowser, selectBrowserDefinitions, startBrowserServer, runBrowserPage } from "../../scripts/browser-harness.mjs";
import { websiteRoot } from "./config.mjs";
import { contentType, deliveryHeaders } from "./delivery.mjs";
import { writeChanged } from "./files.mjs";
import { exampleSource } from "../src/playground/presets.ts";
import { nativeAssets } from "./native-assets.mjs";

const fixture = "website-gpu-smoke.html";
const requests = new Set();
const native = nativeAssets(process.env.TABGRAD_WEBSITE_NATIVE_ORIGIN, join(websiteRoot, "dist"));
/** @param {string} path @returns {Promise<Buffer>} */
async function readAsset(path) {
  if (path === join(websiteRoot, "dist/__example_checks.mjs")) return readFile(join(websiteRoot, "tests/example-checks.mjs"));
  if (path.endsWith("/js-tests/browser/" + fixture)) return readFile(join(websiteRoot, "tests/gpu-browser.html"));
  if (path === join(websiteRoot, "dist/__gpu_examples.json")) {
    const catalog = JSON.parse(await readFile(join(websiteRoot, "src/playground/examples.json"), "utf8"));
    return Buffer.from(JSON.stringify(catalog.map(example => ({ ...example,
      python: { ...example.python, code: exampleSource(example, "python", "webgpu") },
      javascript: { ...example.javascript, code: exampleSource(example, "javascript", "webgpu") },
    }))));
  }
  if (path === join(websiteRoot, "dist/__requests.json")) return Buffer.from(JSON.stringify([...requests]));
  requests.add(relative(join(websiteRoot, "dist"), path));
  if (native.read) return native.read(path);
  return readFile((await stat(path)).isDirectory() ? join(path, "index.html") : path);
}
const server = await startBrowserServer([fixture], {
  distributionDirectory: join(websiteRoot, "dist"), readAsset,
  assetHeaders(path, body) {
    if (path === "/" + fixture) return { "content-type": "text/html", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
    if (path === "/__gpu_examples.json") return { "content-type": "application/json" };
    if (native.read && !["/__requests.json", "/__example_checks.mjs"].includes(path)) return native.headers(path);
    const html = path.endsWith("/") || path.endsWith(".html");
    return { "content-type": contentType(html ? "index.html" : path), ...deliveryHeaders(path, html ? body.toString("utf8") : "") };
  },
});
try {
  const reports = [];
  for (const browser of selectBrowserDefinitions(process.env.TABGRAD_BROWSER ?? "chrome")) {
    requests.clear();
    const executable = await resolveBrowser(browser);
    const version = browserVersion(executable);
    const result = await runBrowserPage({ server, browser, executable, version, page: fixture,
      applicationTimeoutMilliseconds: 150000,
      validateResult(report) { assert.equal(report.passed, true, report.error); assert.equal(report.cases.length, 15); return report; },
    });
    reports.push({ browser: browser.name, version, result });
    console.log(`${version}: physical WebGPU website integration passed`);
  }
  await writeChanged(join(websiteRoot, `.generated/${native.read ? "native-" : ""}gpu-browser-check.json`), JSON.stringify(reports, null, 2) + "\n");
} finally { await server.close(); }
