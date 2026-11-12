import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { browserVersion, resolveBrowser, selectBrowserDefinitions, startBrowserServer, runBrowserPage } from "../../scripts/browser-harness.mjs";
import { firstCodeBlock } from "./content.mjs";
import { repositoryRoot, websiteRoot, runtimeVersion, pyodideVersion } from "./config.mjs";
import { scriptHashes } from "./delivery.mjs";
import { writeChanged } from "./files.mjs";

// Explicit live-network qualification, separate from deterministic website CI.
// Run the very block rendered by Get started; never serve local runtime assets.
const fixture = "tabgrad-cdn.html";
const failureFixture = "tabgrad-cdn-import-failure.html";
const guide = await readFile(join(repositoryRoot, "docs/reference/browser-package.md"), "utf8");
const snippet = firstCodeBlock(guide, "html");
const cdnBase = `https://cdn.jsdelivr.net/npm/@tabgrad/tabgrad@${runtimeVersion}/dist/`;
assert.ok(snippet.includes(`"${cdnBase}index.js"`), "HTML example and selected runtime version must agree");
assert.equal((snippet.match(/<script type="module">/g) ?? []).length, 1);
const standalone = `<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Tabgrad — HTML/CDN example</title>\n${snippet}\n</html>\n`;
await writeChanged(join(websiteRoot, ".generated/cdn-example.html"), standalone);

// The only instrumentation of the source block is an awaited report after its
// original finalization. Import errors are observed before the module loads.
const reporting = `
const token = new URL(location.href).searchParams.get("token");
let reported = false;
async function report(value) {
  if (reported) return;
  reported = true;
  await fetch("/__result?token=" + encodeURIComponent(token), { method: "POST", body: JSON.stringify(value) });
}
`;
const observer = `<script>
${reporting}
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
// The same source with only its import target changed to a throwing local module.
const failureObserver = `<script>${reporting}
globalThis.finishCdnExample = async function () {
  const output = document.getElementById("output").textContent;
  await report({ passed: output === "Could not run Tabgrad. Check the console for details.", output });
};</script>`;
const importFailure = standalone.replace(snippet, failureObserver + snippet
  .replace(cdnBase + "index.js", "./failing-starter-module.js")
  .replace("</script>", "  await globalThis.finishCdnExample();\n</script>"));
const pythonGuide = await readFile(join(repositoryRoot, "docs/reference/python-host.md"), "utf8");
const pythonHtml = firstCodeBlock(pythonGuide, "html", "index.html");
const pythonWorker = firstCodeBlock(pythonGuide, "javascript", "python-worker.js");
assert.ok(pythonWorker.includes(`from "${cdnBase}python.js"`), "Python example and selected runtime must agree");
assert.ok(pythonWorker.includes(`https://cdn.jsdelivr.net/npm/pyodide@${pyodideVersion}/pyodide.mjs`), "Python interpreter pin must agree");
await writeChanged(join(websiteRoot, ".generated/python-cdn-example/index.html"), pythonHtml + "\n");
await writeChanged(join(websiteRoot, ".generated/python-cdn-example/python-worker.js"), pythonWorker + "\n");
const pythonCases = [
  { name: "python-cdn", runs: 2, expected: "[-2.0, 4.0]", status: "Finished.", worker: pythonWorker },
  // Failure derivatives are test controls; the successful case serves exact documented bytes.
  { name: "python-program-failure", runs: 1, expected: "example failure", status: "Failed.",
    worker: pythonWorker.replace('print(x.grad.tolist())', 'print(x.grad.tolist())\nraise RuntimeError("example failure")') },
  { name: "python-worker-failure", runs: 1, expected: "worker startup failure", status: "Failed.",
    worker: 'throw new Error("worker startup failure");' },
  { name: "python-wasm-failure", runs: 1, expected: "Python Wasm test failure", status: "Failed.",
    worker: 'WebAssembly.instantiateStreaming = async () => { throw new Error("Python Wasm test failure"); };\n' + pythonWorker },
];
function pythonPage(test) {
  // Add a DOM observer, without modifying the documented HTML module or worker.
  return pythonHtml + `<script>
${reporting}
addEventListener("load", () => {
  const run = document.getElementById("run"), status = document.getElementById("status"), output = document.getElementById("output");
  let completed = 0;
  if (status.textContent !== "Ready." || run.disabled) { void report({ passed: false, error: "Example must wait for an explicit click" }); return; }
  const observed = [];
  const changes = new MutationObserver(() => {
    if (!["Finished.", "Failed."].includes(status.textContent)) return;
    observed.push({ status: status.textContent, output: output.textContent, enabled: !run.disabled });
    if (status.textContent !== ${JSON.stringify(test.status)} || !output.textContent.includes(${JSON.stringify(test.expected)}) || run.disabled
      || (${JSON.stringify(test.name)} === "python-program-failure" && !output.textContent.includes("[-2.0, 4.0]"))) {
      changes.disconnect(); void report({ passed: false, error: "Unexpected Python result", observed }); return;
    }
    completed++;
    if (completed === ${test.runs}) { changes.disconnect(); void report({ passed: true, explicitStart: true, observed }); }
    else run.click();
  });
  changes.observe(status, { childList: true, subtree: true });
  run.click();
  if (!run.disabled || status.textContent !== "Loading Python…") { changes.disconnect(); void report({ passed: false, error: "Click must disable duplicate execution and show loading" }); }
});
</script>`;
}
const pythonPages = pythonCases.map((test) => `${test.name}/index.html`);
const localRequests = [];
const server = await startBrowserServer([fixture, failureFixture, ...pythonPages], {
  assets: ["failing-starter-module.js", ...pythonCases.map((test) => `${test.name}/python-worker.js`)],
  async readAsset(path) {
    localRequests.push(path);
    if (path.endsWith("/js-tests/browser/" + fixture)) return Buffer.from(instrumented);
    if (path.endsWith("/js-tests/browser/" + failureFixture)) return Buffer.from(importFailure);
    if (path.endsWith("/failing-starter-module.js")) return Buffer.from('throw new Error("Controlled starter module failure");');
    for (const test of pythonCases) {
      if (path.endsWith(`/${test.name}/index.html`)) return Buffer.from(pythonPage(test));
      if (path.endsWith(`/${test.name}/python-worker.js`)) return Buffer.from(test.worker);
    }
    throw new Error("The CDN check must not receive a local runtime resource");
  },
  assetHeaders(path) {
    if (path.endsWith("/python-worker.js")) return { "content-security-policy": "default-src 'none'; script-src https://cdn.jsdelivr.net 'unsafe-eval' 'wasm-unsafe-eval'; connect-src https://cdn.jsdelivr.net; base-uri 'none'" };
    const test = pythonCases.find((item) => path.endsWith(`/${item.name}/index.html`));
    const html = test ? pythonPage(test) : path.endsWith(failureFixture) ? importFailure : instrumented;
    return { "content-security-policy": `default-src 'none'; script-src ${path.endsWith(failureFixture) ? "'self' " : ""}${scriptHashes(html).join(" ")} https://cdn.jsdelivr.net 'wasm-unsafe-eval'; worker-src 'self' https://cdn.jsdelivr.net; connect-src 'self' https://cdn.jsdelivr.net; base-uri 'none'` };
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
    const failure = await runBrowserPage({ server, browser, executable, version, page: failureFixture,
      applicationTimeoutMilliseconds: 60000,
      validateResult(report) { assert.equal(report.passed, true, JSON.stringify(report)); return report; },
    });
    reports.push({ browser: browser.name, version, example: "starter-import-failure", result: failure });
    console.log(`${version}: documented HTML import failure is visible`);
    for (const test of pythonCases) {
      localRequests.length = 0;
      const result = await runBrowserPage({ server, browser, executable, version, page: `${test.name}/index.html`,
        applicationTimeoutMilliseconds: 120000,
        validateResult(report) {
          assert.equal(report.passed, true, JSON.stringify(report));
          assert.equal(localRequests.length, test.runs + 1, "only the HTML and same-origin worker come from the local server");
          assert.equal(localRequests.filter((path) => path.endsWith("/python-worker.js")).length, test.runs);
          return report;
        },
      });
      reports.push({ browser: browser.name, version, example: test.name, result });
      console.log(`${version}: ${test.name} passed (${test.runs} run${test.runs === 1 ? "" : "s"})`);
    }
  }
} finally {
  await writeChanged(join(websiteRoot, ".generated/cdn-check.json"), JSON.stringify(reports, null, 2) + "\n");
  await server.close();
}
