import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { createPackageApplication } from "../../fixtures/package-application.mjs";
import { checkPublicPackageEntries, checkPublicPackageTypes, checkPublicPackageCpuAssets } from "../../fixtures/package-consumer.mjs";

let fixture;
before(async () => { fixture = await createPackageApplication(); });
after(async () => { await fixture?.close(); });

test("an external application resolves the public entries and bounded resources", async () => { await checkPublicPackageEntries(fixture); });

test("public package content omits the standalone testing entry", async () => {
  const paths = fixture.packed.files.map(file => file.path);
  assert.ok(!paths.includes("dist/testing.js"), "standalone testing JavaScript was packed");
  assert.ok(!paths.includes("dist/testing.d.ts"), "standalone testing declarations were packed");
  for (const path of ["dist/index.js", "dist/python.js", "dist/webgpu-worker.js", "dist/runtime/runtime.js", "dist/manifest.json", "dist/python/manifest.json", "LICENSE"]) {
    await access(join(fixture.packageDirectory, path));
  }
  assert.ok(paths.every(path => path.startsWith("dist/") || ["package.json", "README.md", "LICENSE"].includes(path)));
});

test("external root and Python declarations compile without checkout resolution", async () => { await checkPublicPackageTypes(fixture); });

test("external public CPU use computes gradients and drains after invalid assets", async () => { await checkPublicPackageCpuAssets(fixture); });
