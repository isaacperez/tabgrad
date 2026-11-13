import { execFileSync } from "node:child_process";

/** Local commits are build inputs, not evidence that a GitHub permalink exists. */
export function documentationSourceContext(directory, release) {
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const sourceRevision = git("rev-parse", "HEAD");
  const published = git("for-each-ref", "--format=%(refname)", "--contains=HEAD", "refs/remotes/origin/").length > 0;
  const dirty = git("status", "--porcelain", "--", "docs", "website", "README.md", "assets/brand").length > 0;
  if (release) {
    if (sourceRevision !== release.sourceRevision || dirty) throw new Error("Released documentation source changed");
    return { sourceRevision, sourceLinkRevision: sourceRevision, localChanges: false };
  }
  let sourceLinkRevision = sourceRevision;
  if (!published) {
    try { sourceLinkRevision = git("merge-base", "HEAD", "refs/remotes/origin/main"); }
    catch { sourceLinkRevision = "main"; }
  }
  return { sourceRevision, sourceLinkRevision, localChanges: dirty || !published };
}
