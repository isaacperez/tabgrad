import assert from "node:assert/strict";
import { test } from "node:test";

import { removeBrowserProfile } from "../../scripts/browser-harness.mjs";

test("browser profile cleanup retries transient directory races", async () => {
  let observedPath;
  let observedOptions;

  await removeBrowserProfile("/temporary/browser-profile", async (path, options) => {
    observedPath = path;
    observedOptions = options;
  });

  assert.equal(observedPath, "/temporary/browser-profile");
  assert.deepEqual(observedOptions, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 100,
  });
});
