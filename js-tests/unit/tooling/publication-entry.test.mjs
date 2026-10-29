import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { publicationEnvironment } from "../../../scripts/publication-client.mjs";
const entry = fileURLToPath(new URL("../../../scripts/release-publication.mjs", import.meta.url));

test("actual CLI is inert by default for every CI role, creates no files and exposes only a bounded code", async t => {
  const root = await mkdtemp(join(tmpdir(), "tabgrad-publication-entry-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const role of ["precheck", "admit", "npm", "bootstrap", "observe", "consume", "complete"]) {
    const result = spawnSync(process.execPath, [entry, role, root], { env: publicationEnvironment(root), encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 1, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.code, "PUBLICATION_DISABLED"); assert.equal(body.status, "failed");
    assert.equal(result.stderr, ""); assert.equal(result.stdout.includes(root), false);
    assert.deepEqual(await readdir(root), []);
  }
});
