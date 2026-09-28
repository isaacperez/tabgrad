import assert from "node:assert/strict";
import { browserDefinitions, browserVersion, resolveBrowser, runBrowserPage, selectBrowserDefinitions, startBrowserServer } from "./browser-harness.mjs";

const server = await startBrowserServer(["webgpu-runtime.html"], { assets: ["webgpu-runtime.mjs", "float32-addition-oracle.mjs"] });
try {
  for (const browser of selectBrowserDefinitions(process.env.TABGRAD_BROWSER ?? "Chrome", browserDefinitions)) {
    const executable = await resolveBrowser(browser);
    const version = browserVersion(executable);
    await runBrowserPage({
      server, browser, executable, version, page: "webgpu-runtime.html", parameters: {},
      validateResult(result) {
        assert.equal(result.ok, true, JSON.stringify(result.error));
        process.stdout.write(`${browser.name} ${version}: ${JSON.stringify(result.diagnostics)}\n`);
      },
    });
  }
} finally { await server.close(); }
