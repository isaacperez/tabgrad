import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { browserVersion, resolveBrowser, selectBrowserDefinitions, startBrowserServer, runBrowserPage } from "../../scripts/browser-harness.mjs";
import { websiteRoot, repositoryRoot, runtimeVersion, pyodideVersion } from "./config.mjs";
import { contentType, deliveryHeaders } from "./delivery.mjs";
import { writeChanged, sha256 } from "./files.mjs";
import { firstCodeBlock } from "./content.mjs";
import { outputFiles } from "./verify-output.mjs";
import { nativeAssets } from "./native-assets.mjs";

import { exampleSource } from "../src/playground/presets.ts";
const fixture = "website-smoke.html";
const requestedAssets = new Set();
const native = nativeAssets(process.env.TABGRAD_WEBSITE_NATIVE_ORIGIN, join(websiteRoot, "dist"));
const pythonHost = await readFile(join(repositoryRoot, "docs/reference/python-host.md"), "utf8");
const diagnosticsSection = pythonHost.split("## Read local runtime observations\n")[1]?.split("\n## ")[0];
assert.ok(diagnosticsSection, "the documented local diagnostics section exists");
const diagnosticsSource = `import { loadPyodide } from '/vendor/pyodide/${pyodideVersion}/pyodide.mjs';
import { attachPython } from '/vendor/tabgrad/${runtimeVersion}/python.js';
const interpreter = await loadPyodide({indexURL:'/vendor/pyodide/${pyodideVersion}/'});
const printed = [];
const console = {log: value => printed.push(value)};
try {
${firstCodeBlock(diagnosticsSection, "javascript")}
const after = binding.diagnostics();
let closed = false;
try { await binding.runPythonAsync('pass'); }
catch (error) { closed = error.code === 'CLOSED_PYTHON_BINDING'; }
postMessage({ok:true, peak:printed[0], after:after.highWaterAllocationBytes, closed});
} catch (error) { postMessage({ok:false, error:String(error)}); }
`;
// The fixture uses the same per-worker CSP and exact published assets as the app.
const diagnosticsPath = `/playground/executor-${sha256(diagnosticsSource)}.worker.js`;
/** Adapt only the registered fixture; all app requests read the built output.
 * @param {string} path @returns {Promise<Buffer>}
 */
async function readAsset(path) {
  if (path === join(websiteRoot, "dist/__example_checks.mjs")) return readFile(join(websiteRoot, "tests/example-checks.mjs"));
  if (path.endsWith("/js-tests/browser/" + fixture)) return readFile(join(websiteRoot, "tests/browser.html"));
  if (path === join(websiteRoot, "dist", diagnosticsPath.slice(1))) return Buffer.from(diagnosticsSource);
  if (path === join(websiteRoot, "dist/__diagnostics-worker.json")) return Buffer.from(JSON.stringify({url:diagnosticsPath}));
  if (path === join(websiteRoot, "dist/__routes.json")) {
    const files = await outputFiles(join(websiteRoot, "dist"));
    return Buffer.from(JSON.stringify(files.filter(file => file.endsWith(".html")).map(file => "/" + file.replace(/index\.html$/, ""))));
  }
  if (path === join(websiteRoot, "dist/__examples.json")) {
    const catalog = JSON.parse(await readFile(join(websiteRoot, "src/playground/examples.json"), "utf8"));
    return Buffer.from(JSON.stringify(catalog.map((example) => ({ ...example, python: { ...example.python, code: exampleSource(example, "python", "cpu") }, javascript: { ...example.javascript, code: exampleSource(example, "javascript", "cpu") } }))));
  }
  if (path === join(websiteRoot, "dist/__blog-example.json")) {
    const post = await readFile(join(websiteRoot, "content/blog/introducing-tabgrad.md"), "utf8");
    const { posts } = JSON.parse(await readFile(join(websiteRoot, ".generated/site-data.json"), "utf8"));
    return Buffer.from(JSON.stringify({ python: firstCodeBlock(post, "python"), posts }));
  }
  if (path === join(websiteRoot, "dist/__requests.json")) return Buffer.from(JSON.stringify([...requestedAssets]));
  requestedAssets.add(relative(join(websiteRoot, "dist"), path));
  if (native.read) return native.read(path);
  return readFile((await stat(path)).isDirectory() ? join(path, "index.html") : path);
}
const server = await startBrowserServer([fixture], {
  distributionDirectory: join(websiteRoot, "dist"), readAsset,
  assetHeaders(path, body) {
    // The fixture drives the app; app and worker retain the preview's real CSP.
    if (path === "/" + fixture || path === "/__examples.json") return { "content-type": contentType(path) };
    if (native.read && ![diagnosticsPath, "/__diagnostics-worker.json", "/__routes.json", "/__blog-example.json", "/__requests.json", "/__example_checks.mjs"].includes(path)) return native.headers(path);
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
        validateResult(report) { assert.equal(report.passed, true, report.error); assert.equal(report.cases.length, 13); return report; },
      });
      reports.push({ browser: browser.name, version, result });
      console.log(`${version}: website CPU integration passed`);
    }
    await writeChanged(join(websiteRoot, `.generated/${native.read ? "native-" : ""}browser-check.json`), JSON.stringify(reports, null, 2) + "\n");
    await server.close();
  }
} catch (error) { await server.close(); throw error; }
