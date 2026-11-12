import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { checkGeneratedAssets, brandPaths, componentNoticePath } from "../scripts/generated-assets.mjs";

const expected = [...brandPaths, componentNoticePath, "examples/javascript/index.html.txt", "examples/python/index.html.txt", "examples/python/python-worker.js.txt"];

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "tabgrad-generated-assets-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const path of expected) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), `Original ${path}\n`);
  }
  return root;
}

test("first preparation admits absent files, but final output requires all declared assets", async context => {
  const root = await fixture(context);
  await rm(join(root, "examples"), { recursive: true });
  await checkGeneratedAssets(root, expected, { allowMissing: true });
  await assert.rejects(checkGeneratedAssets(root, expected), /Missing generated asset: examples/);
  await checkGeneratedAssets(join(root, "first-build"), expected, { allowMissing: true });
  await assert.rejects(checkGeneratedAssets(join(root, "first-build"), expected), { code: "ENOENT" });
});

for (const namespace of ["brand", "licenses", "examples"]) {
  test(`reused ${namespace} rejects retired files and empty directories without removing them`, async context => {
    const root = await fixture(context);
    const retired = join(root, namespace, "retired.txt");
    await writeFile(retired, "Keep this evidence\n");
    for (const allowMissing of [true, false])
      await assert.rejects(checkGeneratedAssets(root, expected, { allowMissing }), /Unexpected generated asset/);
    assert.equal(await readFile(retired, "utf8"), "Keep this evidence\n");
    await rm(retired);
    await mkdir(join(root, namespace, "retired-directory"));
    await assert.rejects(checkGeneratedAssets(root, expected), /Unexpected generated asset/);
  });
}

test("the authored license page coexists with generated notices; unrelated namespaces remain untouched", async context => {
  const root = await fixture(context);
  await writeFile(join(root, "licenses/index.html"), "Authored page\n");
  await mkdir(join(root, "unrelated"));
  await writeFile(join(root, "unrelated/keep.txt"), "Authored elsewhere\n");
  await assert.rejects(checkGeneratedAssets(root, expected), /Unexpected generated asset: licenses\/index.html/);
  await checkGeneratedAssets(root, expected, { authoredPaths: ["licenses/index.html"] });
  assert.equal(await readFile(join(root, "licenses/index.html"), "utf8"), "Authored page\n");
  assert.equal(await readFile(join(root, "unrelated/keep.txt"), "utf8"), "Authored elsewhere\n");
});

test("symlinked roots, namespaces and declared files are rejected without following or modifying targets", async context => {
  const root = await fixture(context);
  const outside = await mkdtemp(join(tmpdir(), "tabgrad-asset-target-"));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "keep.txt"), "External original\n");
  await symlink(outside, join(root, "linked-root"));
  await assert.rejects(checkGeneratedAssets(join(root, "linked-root"), expected), /root must be a regular directory/);
  await rm(join(root, "brand"), { recursive: true });
  await symlink(outside, join(root, "brand"));
  await assert.rejects(checkGeneratedAssets(root, expected), /Symbolic link in generated assets: brand/);
  await rm(join(root, "brand"));
  await mkdir(join(root, "brand"));
  await symlink(join(outside, "keep.txt"), join(root, brandPaths[0]));
  await assert.rejects(checkGeneratedAssets(root, expected, { allowMissing: true }), /Symbolic link in generated assets/);
  assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "External original\n");
});

test("generated declarations cannot escape or admit an unowned namespace", async context => {
  const root = await fixture(context);
  for (const path of ["../keep.txt", "/brand/a.svg", "brand/../keep.txt", "brand\\a.svg", "vendor/other.js"])
    await assert.rejects(checkGeneratedAssets(root, [path], { allowMissing: true }), /Invalid generated asset declaration/);
});
