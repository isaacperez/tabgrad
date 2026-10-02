import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntimeSession } from "../../../dist/index.js";

const distributionRoot = new URL("../../../dist/", import.meta.url);

for (const [name, manifestUrl, expected] of [
  ["default", undefined, new URL("manifest.json", distributionRoot)],
  ["relative filename", "custom-manifest.json", new URL("custom-manifest.json", distributionRoot)],
  ["relative subdirectory", "assets/manifest.json", new URL("assets/manifest.json", distributionRoot)],
  ["relative parent", "../custom/manifest.json", new URL("../custom/manifest.json", distributionRoot)],
  ["empty string", "", new URL("runtime.js", distributionRoot)],
  ["query only", "?revision=1", new URL("runtime.js?revision=1", distributionRoot)],
  ["fragment only", "#manifest", new URL("runtime.js#manifest", distributionRoot)],
  ["absolute string", "https://example.invalid/model/manifest.json", new URL("https://example.invalid/model/manifest.json")],
  ["absolute URL", new URL("https://example.invalid/model/manifest.json"), new URL("https://example.invalid/model/manifest.json")],
]) {
  test(`CPU manifest ${name} preserves the distribution-root resolution base`, async (context) => {
    const requests = [];
    const failure = new Error("controlled manifest fetch failure");
    context.mock.method(globalThis, "fetch", async (url) => {
      requests.push(String(url));
      throw failure;
    });
    const session = createRuntimeSession(manifestUrl === undefined ? {} : { manifestUrl });
    const input = session.tensor([1]);
    const output = input.add(input);
    try {
      await assert.rejects(output.toArray(), (error) => (
        error.code === "BACKEND_LOAD_FAILED"
        && error.details.phase === "manifest-fetch"
        && error.details.manifestUrl === expected.href
        && error.cause === failure
      ));
      assert.deepEqual(requests, [expected.href]);
    } finally {
      output.close();
      input.close();
      await session.close();
    }
  });
}
