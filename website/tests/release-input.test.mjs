import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReleaseInput, releaseIdentity, bindIntegrationVersion } from "../scripts/release-input.mjs";

export const identity = { schemaVersion: 1, completionSha256: "a".repeat(64), operation: "a".repeat(64),
  planSha256: "b".repeat(64), sourceRevision: "c".repeat(40), recipeRevision: "d".repeat(40), runId: "123", attempt: "1",
  version: "0.4.0", inventorySha256: "e".repeat(64), archiveSha512: "f".repeat(128) };

test("one explicit release input selects content, recipe and owned package without publishing local paths", async t => {
  const directory = await mkdtemp(join(tmpdir(), "tabgrad-site-release-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "release-input.json");
  const input = { schemaVersion: 1, sourceRevision: "c".repeat(40), recipeRevision: "d".repeat(40), release: identity, packageDirectory: join(directory, "package"), inventory: [] };
  await writeFile(path, JSON.stringify(input)); assert.deepEqual(readReleaseInput(path), input);
  assert.equal(readReleaseInput(undefined), undefined); assert.ok(!Object.hasOwn(releaseIdentity(identity), "packageDirectory"));
  await symlink(path, join(directory, "link")); assert.throws(() => readReleaseInput(join(directory, "link")));
  await writeFile(path, JSON.stringify({ ...input, extra: true })); assert.throws(() => readReleaseInput(path));
  assert.throws(() => releaseIdentity({ ...identity, version: "latest" }));
  assert.throws(() => releaseIdentity({ ...identity, attempt: "2" }));
});

test("integration binding changes only exact package pins in the two supported guides", () => {
  const body = '@tabgrad/tabgrad@0.3.0/dist/index.js\n0.3.0\npyodide@0.3.0\n@tabgrad/tabgrad@0.3.01';
  assert.equal(bindIntegrationVersion("docs/compatibility.md", body, "0.3.0", "0.4.0"), body);
  assert.equal(bindIntegrationVersion("docs/reference/python-host.md", body, "0.3.0", "0.4.0"),
    '@tabgrad/tabgrad@0.4.0/dist/index.js\n0.3.0\npyodide@0.3.0\n@tabgrad/tabgrad@0.3.01');
});
