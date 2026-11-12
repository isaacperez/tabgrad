import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { documentationSourceContext } from "../scripts/source-context.mjs";

test("documentation links distinguish published source, dirty edits and clean unpublished commits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tabgrad-doc-source-"));
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "--template=", "--initial-branch=main");
    git("config", "user.name", "Documentation fixture"); git("config", "user.email", "fixture@example.invalid");
    await writeFile(join(directory, "README.md"), "Published source\n");
    git("add", "README.md"); git("commit", "-m", "Published fixture");
    const published = git("rev-parse", "HEAD");
    // A local fixture for the remote-tracking observation, without any network.
    git("update-ref", "refs/remotes/origin/main", published);
    assert.deepEqual(documentationSourceContext(directory), { sourceRevision: published, sourceLinkRevision: published, localChanges: false });
    await writeFile(join(directory, "README.md"), "Local edit\n");
    assert.deepEqual(documentationSourceContext(directory), { sourceRevision: published, sourceLinkRevision: published, localChanges: true });
    git("commit", "-am", "Unpublished fixture");
    const local = git("rev-parse", "HEAD");
    assert.deepEqual(documentationSourceContext(directory), { sourceRevision: local, sourceLinkRevision: published, localChanges: true });
    git("update-ref", "refs/remotes/origin/website", local);
    assert.deepEqual(documentationSourceContext(directory), { sourceRevision: local, sourceLinkRevision: local, localChanges: false });
    git("update-ref", "-d", "refs/remotes/origin/website"); git("update-ref", "-d", "refs/remotes/origin/main");
    assert.deepEqual(documentationSourceContext(directory), { sourceRevision: local, sourceLinkRevision: "main", localChanges: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
