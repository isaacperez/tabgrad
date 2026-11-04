import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { browserVersion, resolveBrowser, selectBrowserDefinitions, startBrowserServer, runBrowserPage } from "../../scripts/browser-harness.mjs";
import { firstCodeBlock } from "./content.mjs";
import { repositoryRoot, websiteRoot, runtimeVersion } from "./config.mjs";
import { scriptHashes } from "./delivery.mjs";
import { writeChanged } from "./files.mjs";

// Explicit live-network qualification, separate from deterministic website CI.
// Run the very block rendered by Get started; never serve local runtime assets.
const fixture = "tabgrad-cdn.html";
const guide = await readFile(join(repositoryRoot, "docs/reference/browser-package.md"), "utf8");
const snippet = firstCodeBlock(guide, "html");
const cdnBase = `https://cdn.jsdelivr.net/npm/@tabgrad/tabgrad@${runtimeVersion}/dist/`;
assert.ok(snippet.includes(`from "${cdnBase}index.js"`), "HTML example and selected runtime version must agree");
assert.equal((snippet.match(/<script type="module">/g) ?? []).length, 1);
const standalone = `<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Tabgrad — HTML/CDN example</title>\n${snippet}\n</html>\n`;
await writeChanged(join(websiteRoot, ".generated/cdn-example.html"), standalone);

// The only instrumentation of the source block is an awaited report after its
// original finalization. Import errors are observed before the module loads.
const observer = `<script>
const token = new URL(location.href).searchParams.get("token");
let reported = false;
async function report(value) {
  if (reported) return;
  reported = true;
  await fetch("/__result?token=" + encodeURIComponent(token), { method: "POST", body: JSON.stringify(value) });
}
addEventListener("error", (event) => { void report({ passed: false, error: event.message || "Module resource failed" }); });
addEventListener("unhandledrejection", (event) => { void report({ passed: false, error: String(event.reason) }); });
globalThis.finishCdnExample = async function () {
  const output = document.getElementById("output").textContent;
  const resources = performance.getEntriesByType("resource").map((entry) => entry.name);
  const remote = resources.filter((url) => url.startsWith(${JSON.stringify(cdnBase)}));
  const unexpected = resources.filter((url) => !url.startsWith(${JSON.stringify(cdnBase)}));
  const passed = output === "Sum: 6" && remote.some((url) => url.endsWith("/manifest.json"))
    && remote.some((url) => url.endsWith(".wasm")) && unexpected.length === 0
    && !remote.some((url) => /pyodide|\\/python\\//i.test(url));
  await report({ passed, output, resources, cleanupCompleted: true,
    error: passed ? undefined : "Expected a complete CDN-only CPU calculation without Python" });
};
</script>`;
const instrumented = standalone.replace(snippet,
  observer + snippet.replace("</script>", "  await globalThis.finishCdnExample();\n</script>"));
const localRequests = [];
const server = await startBrowserServer([fixture], {
  async readAsset(path) {
    localRequests.push(path);
    if (path.endsWith("/js-tests/browser/" + fixture)) return Buffer.from(instrumented);
    throw new Error("The CDN check must not receive a local runtime resource");
  },
  assetHeaders() {
    return { "content-security-policy": `default-src 'none'; script-src ${scriptHashes(instrumented).join(" ")} https://cdn.jsdelivr.net 'wasm-unsafe-eval'; connect-src 'self' https://cdn.jsdelivr.net; base-uri 'none'` };
  },
});
const reports = [];
try {
  for (const browser of selectBrowserDefinitions(process.env.TABGRAD_BROWSER)) {
    localRequests.length = 0;
    const executable = await resolveBrowser(browser);
    const version = browserVersion(executable);
    const result = await runBrowserPage({ server, browser, executable, version, page: fixture,
      applicationTimeoutMilliseconds: 60000,
      validateResult(report) {
        assert.equal(report.passed, true, report.error);
        assert.equal(localRequests.length, 1, "only the HTML comes from the local server");
        return report;
      },
    });
    reports.push({ browser: browser.name, version, result });
    console.log(`${version}: documented HTML/CDN CPU example passed`);
  }
} finally {
  await writeChanged(join(websiteRoot, ".generated/cdn-check.json"), JSON.stringify(reports, null, 2) + "\n");
  await server.close();
}
