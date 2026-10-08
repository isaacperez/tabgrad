import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { loadPythonSources } from "../../../dist/frontends/python/python-assets.js";
import { attachPython } from "../../../dist/python.js";

const manifestUrl = new URL("https://assets.example.invalid/custom/manifest.json");

async function assetFixture(context, change = () => {}) {
  const manifest = JSON.parse(await readFile(new URL("../../../dist/python/manifest.json", import.meta.url), "utf8"));
  const resources = new Map();
  for (const file of manifest.files) resources.set(file.path,
    await readFile(new URL(`../../../dist/python/${file.path}`, import.meta.url)));
  change(manifest, resources);
  context.mock.method(globalThis, "fetch", async (url) => url.href === manifestUrl.href
    ? Response.json(manifest) : new Response(resources.get(new URL(url).pathname.split("/custom/")[1])));
  return { manifest, resources };
}

test("admission associates shuffled descriptors by path and emits protocol5", async (context) => {
  const { manifest, resources } = await assetFixture(context, (manifest) => manifest.files.reverse());
  assert.equal(manifest.bridgeVersion, 5);
  const sources = await loadPythonSources(manifestUrl);
  assert.equal(sources.bootstrap, resources.get("bootstrap.py").toString("utf8"));
  assert.deepEqual(sources.packageSources, new Map(
    [...resources].filter(([path]) => path !== "bootstrap.py").map(([path, bytes]) => [path, bytes.toString("utf8")]),
  ));
});

for (const failure of ["old-protocol", "future-protocol", "schema", "pyodide", "missing", "duplicate", "unexpected", "size", "hash", "utf8"]) {
  test(`admission rejects ${failure} before Python executes`, async (context) => {
    await assetFixture(context, (manifest, resources) => {
      if (failure === "old-protocol") manifest.bridgeVersion = 4;
      if (failure === "future-protocol") manifest.bridgeVersion = 6;
      if (failure === "schema") manifest.schemaVersion = 2;
      if (failure === "pyodide") manifest.pyodideVersion = "0.0.0";
      if (failure === "missing") manifest.files.pop();
      if (failure === "duplicate") manifest.files[1] = manifest.files[0];
      if (failure === "unexpected") manifest.files[1].path = "torch/extra.py";
      if (failure === "size") manifest.files[1].byteLength += 1;
      if (failure === "hash") manifest.files[1].sha256 = "0".repeat(64);
      if (failure === "utf8") {
        const bytes = new Uint8Array([0xff]);
        resources.set(manifest.files[1].path, bytes);
        manifest.files[1].byteLength = bytes.length;
        manifest.files[1].sha256 = createHash("sha256").update(bytes).digest("hex");
      }
    });
    let calls = 0;
    const interpreter = { version: "314.0.6", runPython() { calls += 1; },
      async runPythonAsync() {}, ffi: { PyProxy: class {} } };
    await assert.rejects(attachPython(interpreter, { manifestUrl }), { code: "PYTHON_ASSET_INVALID" });
    assert.equal(calls, 0);
  });
}
