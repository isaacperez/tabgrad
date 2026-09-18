import assert from "node:assert/strict";

import {
  browserDefinitions,
  browserVersion,
  resolveBrowser,
  runBrowserPage,
  selectBrowserDefinitions,
  startBrowserServer,
} from "./browser-harness.mjs";

function assertRuntimeResult(result, variant) {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(result.values, [5, 7, 9]);
  assert.equal(result.before.backendLoads, 0);
  assert.equal(result.before.kernelCalls, 0);
  assert.equal(result.after.backendLoads, 1);
  assert.equal(result.after.kernelCalls, 1);
  assert.equal(result.after.hostToWasmBytes, 24);
  assert.equal(result.after.wasmToHostBytes, 12);
  assert.equal(
    result.after.selectedVariant,
    variant === "auto" ? "simd128" : variant,
  );
}

function assertPythonWorkerResult(result, jspi, gated, variant = "simd128") {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.answer, 43);
  assert.equal(result.pyodide, "314.0.6");
  assert.equal(result.worker, true);
  assert.equal(result.isolated, gated);
  assert.equal(result.gated, gated);
  assert.equal(result.selectedVariant, variant);
  if (jspi === "disabled") assert.equal(result.jspiAvailable, false);
}

const server = await startBrowserServer(["runtime.html", "python-lifecycle.html", "python-worker.html"], {
  assets: ["python-worker.mjs", "cpu-profile.mjs"],
});
try {
  const selectedBrowsers = selectBrowserDefinitions(
    process.env.TABGRAD_BROWSER,
    browserDefinitions,
  );
  for (const browser of selectedBrowsers) {
    const executable = await resolveBrowser(browser);
    const version = browserVersion(executable);
    process.stdout.write(`${browser.name}: ${version}\n`);
    for (const variant of ["auto", "scalar", "simd128"]) {
      await runBrowserPage({
        server,
        browser,
        executable,
        page: "runtime.html",
        parameters: { variant },
        version,
        validateResult(result) {
          assertRuntimeResult(result, variant);
        },
      });
      process.stdout.write(`PASS ${browser.name} ${variant}\n`);
    }
    for (const jspi of ["native", "disabled"]) {
      await runBrowserPage({
        server,
        browser,
        executable,
        page: "python-lifecycle.html",
        parameters: { jspi },
        version,
        validateResult(result) {
          assert.equal(result.ok, true, JSON.stringify(result.error));
          assert.equal(result.answer, 43);
          assert.equal(result.pyodide, "314.0.6");
          assert.equal(typeof result.jspiAvailable, "boolean");
          if (jspi === "disabled") assert.equal(result.jspiAvailable, false);
          process.stdout.write(`${browser.name} ${jspi}: JSPI available = ${result.jspiAvailable}\n`);
        },
      });
      process.stdout.write(`PASS ${browser.name} Python observation and lifecycle (${jspi} JSPI profile)\n`);
      await runBrowserPage({
        server, browser, executable, page: "python-worker.html", parameters: { jspi }, version,
        validateResult(result) { assertPythonWorkerResult(result, jspi, false); },
      });
      process.stdout.write(`PASS ${browser.name} Python worker (${jspi} JSPI profile, no isolation)\n`);
    }
    const isolatedServer = await startBrowserServer(["python-worker.html"], {
      crossOriginIsolation: true, assets: ["python-worker.mjs", "cpu-profile.mjs"],
    });
    try {
      await runBrowserPage({
        server: isolatedServer, browser, executable, page: "python-worker.html",
        parameters: { jspi: "disabled", gate: "shared" }, version,
        validateResult(result) { assertPythonWorkerResult(result, "disabled", true); },
      });
      process.stdout.write(`PASS ${browser.name} host admission and close while Python worker is parked\n`);
    } finally { await isolatedServer.close(); }
    for (const cpuVariant of ["scalar", "simd128"]) {
      const variantServer = await startBrowserServer(["python-worker.html"], {
        assets: ["python-worker.mjs", "cpu-profile.mjs"],
      });
      try {
        await runBrowserPage({
          server: variantServer, browser, executable, page: "python-worker.html",
          parameters: { jspi: "disabled", variant: cpuVariant }, version,
          validateResult(result) { assertPythonWorkerResult(result, "disabled", false, cpuVariant); },
        });
        process.stdout.write(`PASS ${browser.name} Python worker ${cpuVariant} (no JSPI or isolation)\n`);
      } finally { await variantServer.close(); }
    }
  }
} finally {
  await server.close();
}
