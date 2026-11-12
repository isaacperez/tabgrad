import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { articleId, prepareBlog } from "../scripts/blog.mjs";
import { blogSchema, formatPostDate, sortPosts } from "../src/blog/schema.ts";

const source = "website/content/blog/first-post.md";
const metadata = { title: "A post", description: "A short description", author: "An author", date: "2026-11-11" };

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "tabgrad-blog-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  await mkdir(join(root, "website/content/blog"), { recursive: true });
  return { root, destination: join(root, ".generated/blog") };
}

test("blog admission preserves tracked Markdown edits and retires renamed or untracked pages", async context => {
  const { root, destination } = await fixture(context);
  const original = "---\ntitle: A post\n---\n\nOriginal code: `x = 1`.\n";
  await writeFile(join(root, source), original);
  await writeFile(join(root, "website/content/blog/private-notes.md"), "Do not publish");
  git(root, "add", "--", source);
  assert.deepEqual(await prepareBlog(root, destination), [{ source, id: "first-post", route: "/blog/first-post/" }]);
  assert.equal(await readFile(join(destination, "first-post.md"), "utf8"), original);
  assert.deepEqual(await readdir(destination), ["first-post.md"]);
  const edited = original + "\nEdited without a commit.\n";
  await writeFile(join(root, source), edited);
  await prepareBlog(root, destination);
  assert.equal(await readFile(join(destination, "first-post.md"), "utf8"), edited);
  const renamed = "website/content/blog/renamed-post.md";
  await rename(join(root, source), join(root, renamed));
  git(root, "add", "--", source, renamed);
  assert.deepEqual(await prepareBlog(root, destination), [{ source: renamed, id: "renamed-post", route: "/blog/renamed-post/" }]);
  assert.deepEqual(await readdir(destination), ["renamed-post.md"]);
  git(root, "rm", "--cached", "--", renamed);
  assert.deepEqual(await prepareBlog(root, destination), []);
  assert.deepEqual(await readdir(destination), []);
});

test("blog source admission rejects file and ancestor symlinks before copying their data", async context => {
  const { root, destination } = await fixture(context);
  await writeFile(join(root, "private.md"), "private payload");
  await symlink(join(root, "private.md"), join(root, source));
  git(root, "add", "--", source);
  await assert.rejects(prepareBlog(root, destination), /Symbolic link/);
  await rm(join(root, source));
  await writeFile(join(root, source), "Tracked page");
  git(root, "add", "--", source);
  await rename(join(root, "website/content/blog"), join(root, "original-blog"));
  await symlink(join(root, "original-blog"), join(root, "website/content/blog"));
  await assert.rejects(prepareBlog(root, destination), /Symbolic link/);
  await assert.rejects(readFile(join(destination, "first-post.md")), { code: "ENOENT" });
});

test("article IDs are one-to-one safe filenames and cannot escape or alias routes", () => {
  assert.equal(articleId("website/content/blog/hello-2026.md"), "hello-2026");
  for (const name of ["../secret", "nested/post", "UPPER", "a.b", "-post", "post-", "two--words"]) {
    assert.throws(() => articleId(`website/content/blog/${name}.md`), /Invalid blog source path/);
  }
  assert.throws(() => articleId("docs/concepts/example.md"), /Invalid blog source path/);
  assert.throws(() => blogSchema.parse({ ...metadata, slug: "an-alias" }));
});

test("blog metadata validates actual calendar dates, author, summary and existing artwork", () => {
  assert.equal(blogSchema.parse({ ...metadata, date: "2024-02-29", illustration: "browser" }).date, "2024-02-29");
  for (const invalid of [{ date: "2025-02-29" }, { date: "2026-13-01" }, { date: "yesterday" }, { title: "  " }, { author: "" }, { description: "" }, { illustration: "missing" }]) {
    assert.throws(() => blogSchema.parse({ ...metadata, ...invalid }));
  }
  assert.throws(() => blogSchema.parse({ title: metadata.title }));
  assert.equal(formatPostDate("2026-11-11"), "November 11, 2026");
});

test("post order is newest first, deterministic on ties and does not mutate collection input", () => {
  const posts = [
    { id: "z", data: { ...metadata, date: "2026-11-11" } },
    { id: "old", data: { ...metadata, date: "2025-01-01" } },
    { id: "a", data: { ...metadata, date: "2026-11-11" } },
  ];
  assert.deepEqual(sortPosts(posts).map(post => post.id), ["a", "z", "old"]);
  assert.deepEqual(posts.map(post => post.id), ["z", "old", "a"]);
});
