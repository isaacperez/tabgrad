import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { browserDefinitions, browserVersion, resolveBrowser, runBrowserPage, selectBrowserDefinitions, startBrowserServer } from "./browser-harness.mjs";

const server = await startBrowserServer(["webgpu/webgpu-runtime.html"], {
  assets: ["webgpu/webgpu-runtime.mjs", "helpers/float32-addition-oracle.mjs", "helpers/float32-sum-oracle.mjs", "helpers/float32-multiplication-oracle.mjs", "helpers/functional-gradient-cases.mjs", "helpers/gradient-progress-cases.mjs", "helpers/gpu-copy-cases.mjs", "helpers/functional-gradient-oracle.json"],
  readAsset: (path) => readFile(String(path).endsWith("/helpers/functional-gradient-oracle.json")
    ? new URL("../js-tests/fixtures/python-tensor-oracle.json", import.meta.url) : path),
});
try {
  for (const browser of selectBrowserDefinitions(process.env.TABGRAD_BROWSER ?? "Chrome", browserDefinitions)) {
    const executable = await resolveBrowser(browser);
    const version = browserVersion(executable);
    await runBrowserPage({
      server, browser, executable, version, page: "webgpu/webgpu-runtime.html", parameters: {},
      validateResult(result) {
        assert.equal(result.ok, true, JSON.stringify(result.error));
        process.stdout.write(`${browser.name} ${version}: ${JSON.stringify(result.diagnostics)}\n`);
      },
    });
  }
} finally { await server.close(); }
