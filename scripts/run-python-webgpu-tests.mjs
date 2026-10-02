import assert from "node:assert/strict";
import { browserDefinitions, browserVersion, resolveBrowser, runBrowserPage, selectBrowserDefinitions, startBrowserServer } from "./browser-harness.mjs";

const profiles = [
  { page: "python-webgpu/python-webgpu.html" }, { page: "python-webgpu/python-webgpu-revocation.html" }, { page: "python-webgpu/python-webgpu-attachment.html" },
  ...["device-loss", "worker-loss", "interpreter-loss"].map((mode) => ({ page: "python-webgpu/python-webgpu-loss.html", mode })),
];
const server = await startBrowserServer(profiles.map(({ page }) => page), { crossOriginIsolation: true,
  assets: ["python-webgpu/python-webgpu.mjs", "python-webgpu/python-webgpu-revocation.mjs", "python-webgpu/python-webgpu-delayed.mjs", "python-webgpu/python-webgpu-attachment.mjs", "python-webgpu/python-webgpu-loss.mjs", "helpers/float32-addition-oracle.mjs"] });
try {
  for (const browser of selectBrowserDefinitions(process.env.TABGRAD_BROWSER ?? "Chrome", browserDefinitions)) {
    const executable = await resolveBrowser(browser);
    const version = browserVersion(executable);
    for (const { page, mode } of profiles) await runBrowserPage({
      server, browser, executable, version, page, parameters: mode === undefined ? {} : { mode },
      validateResult(result) {
        assert.equal(result.ok, true, JSON.stringify(result.error));
        assert.equal(result.worker, page !== "python-webgpu/python-webgpu-attachment.html");
        assert.equal(result.jspiAvailable, false);
        assert.equal(result.pyodide, "314.0.6");
        if (result.diagnostics !== undefined) assert.equal(result.diagnostics.liveRequestLeases, 0);
        else if (mode !== "interpreter-loss") assert.equal(result.attachmentBoundaries, true);
        else assert.equal(result.pythonCleanupAcknowledged, false);
        process.stdout.write(`${browser.name} ${version} ${page} ${mode ?? ""}: ${JSON.stringify(result.diagnostics ?? result.after ?? { attachmentBoundaries: true })}\n`);
      },
    });
  }
} finally { await server.close(); }
