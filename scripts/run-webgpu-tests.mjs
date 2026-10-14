import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { browserDefinitions, browserVersion, resolveBrowser, runBrowserPage, selectBrowserDefinitions, startBrowserServer } from "./browser-harness.mjs";

const server = await startBrowserServer(["webgpu/webgpu-runtime.html"], {
  assets: ["webgpu/webgpu-runtime.mjs", "helpers/float32-addition-oracle.mjs", "helpers/float32-sum-oracle.mjs", "helpers/float32-multiplication-oracle.mjs", "helpers/float32-coefficient-oracle.mjs", "helpers/gpu-sgd-cases.mjs", "helpers/functional-gradient-cases.mjs", "helpers/gradient-progress-cases.mjs", "helpers/gpu-copy-cases.mjs", "helpers/backward-cases.mjs", "helpers/python-tensor-device.mjs", "helpers/backward-lifetime.mjs", "helpers/sgd-cases.mjs", "helpers/sgd-lifetime.mjs", "helpers/gpu-backward-cases.mjs", "helpers/matrix-cases.mjs", "helpers/float32-matrix-oracle.mjs", "helpers/python-matrix-cases.mjs", "helpers/functional-gradient-oracle.json"],
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
        assert.equal(result.matrixNumerics.cases, 97);
        assert.equal(result.matrixTraining.length, 10);
        assert.equal(result.matrixPending.length, 8);
        process.stdout.write(`${JSON.stringify({ matrixPending: result.matrixPending })}\n`);
        assert.equal(result.matrixBackend.cases, 376);
        process.stdout.write(`${JSON.stringify({ matrixBackend: result.matrixBackend })}\n`);
        process.stdout.write(`${JSON.stringify({ matrixNumerics: result.matrixNumerics, matrixTraining: result.matrixTraining })}\n`);
        process.stdout.write(`${browser.name} ${version}: ${JSON.stringify(result.diagnostics)}\n`);
        process.stdout.write(`${JSON.stringify({ backwardResources: result.backwardResources })}\n`);
        process.stdout.write(`${JSON.stringify({ sgdArithmetic: result.sgdArithmetic, sgdCases: result.sgdCases })}\n`);
        process.stdout.write(`${JSON.stringify({ sgdResources: result.sgdResources, sgdSavedControl: result.sgdSavedControl })}\n`);
      },
    });
  }
} finally { await server.close(); }
