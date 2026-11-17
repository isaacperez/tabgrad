import { runFloat16Conformance } from "./float16-conformance.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { browserDefinitions, browserVersion, resolveBrowser, runBrowserPage, selectBrowserDefinitions, startBrowserServer } from "./browser-harness.mjs";

const server = await startBrowserServer(["webgpu/webgpu-runtime.html", "webgpu/webgpu-dispatch.html"], {
  assets: ["webgpu/webgpu-runtime.mjs", "helpers/gpu-dispatch-cases.mjs", "helpers/float32-addition-oracle.mjs", "helpers/float32-sum-oracle.mjs", "helpers/float32-multiplication-oracle.mjs", "helpers/float32-coefficient-oracle.mjs", "helpers/gpu-sgd-cases.mjs", "helpers/functional-gradient-cases.mjs", "helpers/gradient-progress-cases.mjs", "helpers/gpu-copy-cases.mjs", "helpers/backward-cases.mjs", "helpers/python-tensor-device.mjs", "helpers/backward-lifetime.mjs", "helpers/sgd-cases.mjs", "helpers/sgd-lifetime.mjs", "helpers/gpu-backward-cases.mjs", "helpers/matrix-cases.mjs", "helpers/float32-matrix-oracle.mjs", "helpers/python-matrix-cases.mjs", "helpers/broadcast-cases.mjs", "helpers/functional-gradient-oracle.json"],
  readAsset: (path) => readFile(String(path).endsWith("/helpers/functional-gradient-oracle.json")
    ? new URL("../js-tests/fixtures/python-tensor-oracle.json", import.meta.url) : path),
});
try {
  for (const browser of selectBrowserDefinitions(process.env.TABGRAD_BROWSER ?? "Chrome", browserDefinitions)) {
    const executable = await resolveBrowser(browser);
    const version = browserVersion(executable);
    await runFloat16Conformance({ browser, executable, version, language: "javascript", device: "webgpu" });
    process.stdout.write(`PASS ${browser.name} float16 javascript GPU\n`);
    await runBrowserPage({
      server, browser, executable, version, page: "webgpu/webgpu-runtime.html", parameters: {},
      validateResult(result) {
        assert.equal(result.ok, true, JSON.stringify(result.error));
        assert.equal(result.matrixNumerics.cases, 97);
        assert.equal(result.broadcast.cases, 46);
        process.stdout.write(`${JSON.stringify({ broadcast: result.broadcast })}\n`);
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
    for (const mode of ["controlled-axis", "large"]) await runBrowserPage({
      server, browser, executable, version, page: "webgpu/webgpu-dispatch.html", parameters: { mode },
      validateResult(result) {
        assert.equal(result.ok, true, JSON.stringify(result.error));
        assert.equal(result.diagnostics.webgpu.ownedBufferBytes, 0);
        assert.equal(result.diagnostics.webgpu.pendingSubmissions, 0);
        assert.equal(result.diagnostics.webgpu.unknownCompletionBytes, 0);
        assert.equal(result.cases.gpu.adapter.isFallbackAdapter, false);
        assert.ok(result.cases.gpu.peakOwnedBufferBytes <= 128 * 1024 ** 2);
        if (mode === "large") {
          assert.equal(result.cases.elements, 4194305);
          assert.equal(result.cases.sumElements, 8388481);
        } else {
          assert.equal(result.matrix.cases, 376);
          assert.equal(result.matrixGrid.cases, 4);
          assert.equal(result.arithmetic.cases, 3);
        }
        process.stdout.write(`${browser.name} ${version}: ${JSON.stringify({ dispatch: mode, cases: result.cases })}\n`);
      },
    });
  }
} finally { await server.close(); }
