import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { watchGitIndex } from "../scripts/source-watch.mjs";

test("Git index admission observes atomic replacement and excludes lock-file writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "website-index-"));
  let changes = 0;
  const watcher = watchGitIndex(join(root, "index"), () => { changes++; });
  try {
    await writeFile(join(root, "index.lock"), "prepared");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(changes, 0);
    await rename(join(root, "index.lock"), join(root, "index"));
    const end = Date.now() + 2000;
    while (changes === 0 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(changes > 0, "atomic Git index replacement must refresh admission");
  } finally { watcher.close(); await rm(root, { recursive: true, force: true }); }
});
