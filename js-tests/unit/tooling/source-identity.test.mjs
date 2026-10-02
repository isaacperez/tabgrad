import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fingerprintTypeScriptSources } from "../../../scripts/source-identity.mjs";

/**
 * Make one test-owned tree; preserve input creation order and clean it on exit.
 * @param {import("node:test").TestContext} context
 * @param {[string, string | Uint8Array][]} entries
 * @returns {Promise<{ rootPath: string, root: URL }>}
 */
async function sourceTree(context, entries = []) {
  const rootPath = await fs.mkdtemp(join(tmpdir(), "tabgrad-source-identity-"));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  for (const [name, bytes] of entries) {
    const path = join(rootPath, ...name.split("/"));
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, bytes);
  }
  return { rootPath, root: pathToFileURL(rootPath) };
}

/**
 * The former launchers' flat name/byte algorithm, independent of the helper.
 * @param {string} rootPath
 * @returns {Promise<string>}
 */
async function legacyFlatFingerprint(rootPath) {
  const fingerprint = createHash("sha256");
  const names = (await fs.readdir(rootPath)).filter((name) => name.endsWith(".ts")).sort();
  for (const name of names) fingerprint.update(name).update(await fs.readFile(join(rootPath, name)));
  return fingerprint.digest("hex");
}

test("unchanged flat sources keep their former identity, including raw bytes and declarations", async (context) => {
  const tree = await sourceTree(context, [
    ["z.ts", new Uint8Array([0, 255, 13, 10])], ["a.ts", "export {};\n"],
    ["contract.d.ts", "declare const value: number;\n"], ["notes.md", "ignored"],
  ]);
  assert.equal(await fingerprintTypeScriptSources(tree.root), await legacyFlatFingerprint(tree.rootPath));
});

test("nested names are root-relative, slash-separated, sorted and covered exactly once", async (context) => {
  const tree = await sourceTree(context, [
    ["runtime/shared.ts", "semantic"], ["gpu/shared.ts", "physical"],
    ["a.ts", "root"], ["group.ts/café #source.d.ts", new Uint8Array([128, 0, 254])],
  ]);
  const expected = createHash("sha256")
    .update("a.ts").update("root")
    .update("gpu/shared.ts").update("physical")
    .update("group.ts/café #source.d.ts").update(new Uint8Array([128, 0, 254]))
    .update("runtime/shared.ts").update("semantic")
    .digest("hex");
  assert.equal(await fingerprintTypeScriptSources(tree.root), expected);
  await fs.writeFile(join(tree.rootPath, "gpu", "shared.ts"), "changed physical");
  assert.notEqual(await fingerprintTypeScriptSources(tree.root), expected);
});

test("nested additions and removals change identity without changing root files", async (context) => {
  const tree = await sourceTree(context, [["a.ts", "root"]]);
  const initial = await fingerprintTypeScriptSources(tree.root);
  await fs.mkdir(join(tree.rootPath, "component"));
  const nested = join(tree.rootPath, "component", "new.ts");
  await fs.writeFile(nested, "nested");
  assert.notEqual(await fingerprintTypeScriptSources(tree.root), initial);
  await fs.unlink(nested);
  assert.equal(await fingerprintTypeScriptSources(tree.root), initial);
});

test("file and parent-directory renames change identity even when bytes are identical", async (context) => {
  const tree = await sourceTree(context, [["component/a.ts", "unchanged"]]);
  const initial = await fingerprintTypeScriptSources(tree.root);
  await fs.rename(join(tree.rootPath, "component", "a.ts"), join(tree.rootPath, "component", "b.ts"));
  const renamedFile = await fingerprintTypeScriptSources(tree.root);
  assert.notEqual(renamedFile, initial);
  await fs.rename(join(tree.rootPath, "component"), join(tree.rootPath, "other"));
  assert.notEqual(await fingerprintTypeScriptSources(tree.root), renamedFile);
});

test("filesystem creation order does not affect the complete source identity", async (context) => {
  const entries = [["z.ts", "last"], ["z/same.ts", "z"], ["a/same.ts", "a"], ["a.ts", "first"]];
  const first = await sourceTree(context, entries);
  const reversed = await sourceTree(context, entries.toReversed());
  assert.equal(await fingerprintTypeScriptSources(first.root), await fingerprintTypeScriptSources(reversed.root));
});

test("other extensions and empty directories do not supply source bytes", async (context) => {
  const tree = await sourceTree(context, [
    ["a.ts", "source"], ["component/shader.wgsl", "shader"],
    ["component/widget.tsx", "widget"], ["component/data.json", "{}"],
  ]);
  const expected = createHash("sha256").update("a.ts").update("source").digest("hex");
  assert.equal(await fingerprintTypeScriptSources(tree.root), expected);
  await fs.writeFile(join(tree.rootPath, "component", "widget.tsx"), "different widget");
  await fs.mkdir(join(tree.rootPath, "empty.ts"));
  assert.equal(await fingerprintTypeScriptSources(tree.root), expected);
});

test("an empty source tree yields the SHA-256 empty byte-stream identity", async (context) => {
  const tree = await sourceTree(context, [["notes.md", "not source"]]);
  assert.equal(await fingerprintTypeScriptSources(tree.root),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("missing and non-directory roots reject rather than produce a partial identity", async (context) => {
  const tree = await sourceTree(context, [["a.ts", "source"]]);
  await assert.rejects(fingerprintTypeScriptSources(pathToFileURL(join(tree.rootPath, "missing"))), { code: "ENOENT" });
  await assert.rejects(fingerprintTypeScriptSources(pathToFileURL(join(tree.rootPath, "a.ts"))), { code: "ENOTDIR" });
});

test("file read failures propagate their original error instead of hashing partial sources", async (context) => {
  const tree = await sourceTree(context, [["a.ts", "first"], ["b.ts", "second"]]);
  const failure = Object.assign(new Error("controlled unreadable source"), { code: "EACCES" });
  const reads = context.mock.method(fs, "readFile", async () => { throw failure; });
  await assert.rejects(fingerprintTypeScriptSources(tree.root), (error) => error === failure);
  assert.equal(reads.mock.callCount(), 1);
  assert.equal(reads.mock.calls[0].arguments[0], join(tree.rootPath, "a.ts"));
});

for (const kind of ["file", "directory", "dangling", "cycle", "excluded-extension"]) {
  test(`rejects ${kind} symbolic links without following or silently excluding them`, async (context) => {
    const tree = await sourceTree(context, [["a.ts", "local"]]);
    const outside = await sourceTree(context, [["external.ts", "outside"]]);
    const target = kind === "directory" ? outside.rootPath
      : kind === "cycle" ? tree.rootPath
        : kind === "dangling" ? join(outside.rootPath, "missing.ts")
          : join(outside.rootPath, "external.ts");
    const name = kind === "excluded-extension" ? "linked.md" : "linked.ts";
    await fs.symlink(target, join(tree.rootPath, name), ["directory", "cycle"].includes(kind) ? "dir" : "file");
    await assert.rejects(fingerprintTypeScriptSources(tree.root),
      new RegExp(`Source identity does not allow symbolic links: ${name.replace(".", "\\.")}`));
  });
}

for (const name of ["measure-webgpu.mjs", "measure-python-webgpu.mjs"]) {
  for (const args of [[], ["invalid-mode"]]) {
    test(`${name} rejects ${args.length === 0 ? "missing" : "invalid"} mode before browser or measurement work`, () => {
      const command = fileURLToPath(new URL(`../../../scripts/${name}`, import.meta.url));
      const result = spawnSync(process.execPath, [command, ...args], { encoding: "utf8", timeout: 5000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(`Use: node scripts/${name.replace(".", "\\.")}`));
      assert.equal(result.stdout, "");
    });
  }
}
