import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runBrowserPage, startBrowserServer } from "./browser-harness.mjs";

const page = "float16/float16.html";
const assets = ["float16/float16.mjs", "float16/python-worker.mjs", "helpers/float16-cases.mjs", "helpers/float16-oracle.json"];

function readConformanceAsset(path) {
  return readFile(String(path).endsWith("/helpers/float16-oracle.json")
    ? new URL("../js-tests/fixtures/float16-oracle.json", import.meta.url) : path);
}

/** Source and installed consumers share full-output and resource assertions. */
export async function runFloat16Conformance({ browser, executable, version, language, device, distributionDirectory, reportNote }) {
  const reads = [];
  const server = await startBrowserServer([page], { assets, crossOriginIsolation: device === "webgpu",
    ...(distributionDirectory === undefined ? {} : { distributionDirectory }),
    readAsset(path) { reads.push(String(path)); return readConformanceAsset(path); },
  });
  let observation;
  try {
    await runBrowserPage({ server, browser, executable, version, page, parameters: { language, device }, reportNote,
      validateResult(result) {
        assert.equal(result.ok, true, JSON.stringify(result.error));
        assert.equal(result.language, language); assert.equal(result.device, device);
        assert.deepEqual(result.cases, { construction: 992, pointwise: 8976, broadcasts: 4 });
        for (const name of ["liveTensorHandles", "liveTensorValues", "liveAllocationBytes", "liveRequestLeases"]) {
          assert.equal(result.final[name], 0, name);
        }
        if (language === "python") {
          assert.equal(result.pyodide, "314.0.6"); assert.equal(result.worker, true); assert.equal(result.jspiAvailable, false);
        }
        if (device === "webgpu") {
          assert.equal(result.beforeClose.webgpu.adapter.isFallbackAdapter, false);
          assert.ok(result.beforeClose.webgpu.kernelCalls > 0, "Selected GPU performs the numerical work.");
          assert.equal(result.beforeClose.kernelCalls, 0, "Selected GPU does not fall back to CPU kernels.");
          assert.ok(result.beforeClose.webgpu.peakOwnedBufferBytes <= 128 * 1024 ** 2);
          for (const name of ["ownedBufferBytes", "pendingSubmissions", "unknownCompletionBytes"]) {
            assert.equal(result.final.webgpu[name], 0, name);
          }
        } else {
          assert.equal(result.beforeClose.webgpu, null);
          assert.ok(result.beforeClose.kernelCalls > 0);
        }
        observation = { browser: browser.name, version, language, device, cases: result.cases };
      },
    });
    if (language === "javascript") assert(!reads.some(path => path.includes("/pyodide/")
      || path.includes("/frontends/python/") || path.endsWith("/python.js") || path.endsWith("/python/bootstrap.py")),
    "Direct JavaScript conformance must not load the Python frontend or interpreter.");
    return observation;
  } finally { await server.close(); }
}
