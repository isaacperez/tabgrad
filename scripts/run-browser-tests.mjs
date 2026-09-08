import assert from "node:assert/strict";

import {
  browserDefinitions,
  browserVersion,
  resolveBrowser,
  runBrowserPage,
  startBrowserServer,
} from "./browser-harness.mjs";

const server = await startBrowserServer(["runtime.html"]);
try {
  for (const browser of browserDefinitions) {
    const executable = await resolveBrowser(browser);
    process.stdout.write(`${browser.name}: ${browserVersion(executable)}\n`);
    for (const variant of ["auto", "scalar", "simd128"]) {
      const result = await runBrowserPage({
        server,
        browser,
        executable,
        page: "runtime.html",
        parameters: { variant },
      });
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
      process.stdout.write(`PASS ${browser.name} ${variant}\n`);
    }
  }
} finally {
  await server.close();
}
