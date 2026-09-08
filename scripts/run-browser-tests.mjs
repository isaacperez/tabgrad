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

const server = await startBrowserServer(["runtime.html"]);
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
  }
} finally {
  await server.close();
}
