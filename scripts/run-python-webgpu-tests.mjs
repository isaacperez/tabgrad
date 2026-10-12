import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { browserDefinitions, browserVersion, resolveBrowser, runBrowserPage, selectBrowserDefinitions, startBrowserServer } from "./browser-harness.mjs";

const profiles = [
  { page: "python-webgpu/python-webgpu.html" }, { page: "python-webgpu/python-webgpu-revocation.html" }, { page: "python-webgpu/python-webgpu-attachment.html" },
  { page: "python-webgpu/python-webgpu-revocation.html", operation: "sum" },
  { page: "python-webgpu/python-webgpu-revocation.html", operation: "mul" },
  { page: "python-webgpu/python-webgpu-revocation.html", operation: "grad" },
  { page: "python-webgpu/python-webgpu-revocation.html", operation: "sgd-update" },
  { page: "python-webgpu/python-webgpu-revocation.html", operation: "sgd-reset" },
  ...["device-loss", "worker-loss", "interpreter-loss"].map((mode) => ({ page: "python-webgpu/python-webgpu-loss.html", mode })),
];
const server = await startBrowserServer(profiles.map(({ page }) => page), { crossOriginIsolation: true,
  assets: ["python-webgpu/python-webgpu.mjs", "python-webgpu/python-webgpu-revocation.mjs", "python-webgpu/python-webgpu-delayed.mjs", "python-webgpu/python-webgpu-attachment.mjs", "python-webgpu/python-webgpu-loss.mjs", "helpers/float32-addition-oracle.mjs", "helpers/float32-sum-oracle.mjs", "helpers/float32-multiplication-oracle.mjs", "helpers/functional-gradient-cases.mjs", "helpers/python-copy-cases.mjs", "helpers/gradient-progress-cases.mjs", "helpers/backward-cases.mjs", "helpers/python-tensor-device.mjs", "helpers/backward-lifetime.mjs", "helpers/sgd-cases.mjs", "helpers/sgd-lifetime.mjs", "helpers/gpu-sgd-cases.mjs", "helpers/float32-coefficient-oracle.mjs", "helpers/functional-gradient-oracle.json"],
  readAsset: (path) => readFile(String(path).endsWith("/helpers/functional-gradient-oracle.json")
    ? new URL("../js-tests/fixtures/python-tensor-oracle.json", import.meta.url) : path),
});
try {
  for (const browser of selectBrowserDefinitions(process.env.TABGRAD_BROWSER ?? "Chrome", browserDefinitions)) {
    const executable = await resolveBrowser(browser);
    const version = browserVersion(executable);
    for (const { page, mode, operation } of profiles) await runBrowserPage({
      server, browser, executable, version, page, parameters: { ...(mode === undefined ? {} : { mode }), ...(operation === undefined ? {} : { operation }) },
      validateResult(result) {
        assert.equal(result.ok, true, JSON.stringify(result.error));
        assert.equal(result.worker, page !== "python-webgpu/python-webgpu-attachment.html");
        assert.equal(result.jspiAvailable, false);
        assert.equal(result.pyodide, "314.0.6");
        if (result.diagnostics !== undefined) assert.equal(result.diagnostics.liveRequestLeases, 0);
        else if (mode !== "interpreter-loss") assert.equal(result.attachmentBoundaries, true);
        else assert.equal(result.pythonCleanupAcknowledged, false);
        process.stdout.write(`${browser.name} ${version} ${page} ${mode ?? operation ?? ""}: ${JSON.stringify(result.diagnostics ?? result.after ?? { attachmentBoundaries: true })}\n`);
        if (result.sgdResources !== undefined) process.stdout.write(`${JSON.stringify({ sgdResources: result.sgdResources })}\n`);
      },
    });
  }
} finally { await server.close(); }
