import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** @typedef {{ runtime: boolean, browser: boolean, reason: string }} ValidationScope */

const nonExecutableRoots = new Set([
  "README.md", "CONTRIBUTING.md", "AGENTS.md", "SECURITY.md", "CHANGELOG.md",
  "LICENSE", "NOTICE", ".github/pull_request_template.md",
]);

/** @param {string} reason @returns {ValidationScope} */
function fullScope(reason) { return { runtime: true, browser: true, reason }; }

/** @param {string} path @returns {boolean} */
function isRepositoryPath(path) {
  return typeof path === "string" && path.length > 0 && !path.includes("\\")
    && !path.includes("\0") && !path.split("/").some((part) => ["", ".", ".."].includes(part));
}

/** @param {string} path @returns {boolean} */
function isConsistencyOnlyChange(path) {
  return nonExecutableRoots.has(path)
    || (path.startsWith("docs/") && path.endsWith(".md"))
    || (path.startsWith("assets/brand/") && /\.(md|svg)$/.test(path))
    || (path.startsWith(".github/ISSUE_TEMPLATE/") && /\.(md|yml|yaml)$/.test(path))
    || (path.startsWith("tests/") && path.endsWith(".py"));
}

/**
 * Select CI execution families, not individual tests. Only known exclusions
 * narrow coverage; unknown files and empty/incomplete comparisons require all.
 * Native tooling and instruction review remain the consistency/review owners.
 * @param {string[]} paths Complete NUL-decoded Git paths, with renames disabled.
 * @returns {ValidationScope}
 */
export function classifyValidationPaths(paths) {
  if (paths.length === 0 || !paths.every(isRepositoryPath)) return fullScope("empty-or-invalid-comparison");
  let runtime = false;
  for (const path of paths) {
    if (isConsistencyOnlyChange(path)) continue;
    if (path.startsWith("js-tests/unit/") && path.endsWith(".mjs")) runtime = true;
    else return fullScope("execution-or-unclassified-change");
  }
  return { runtime, browser: false, reason: runtime ? "unit-tests-only" : "consistency-only" };
}

/**
 * Compare the actual checked-out candidate with its event base. No merge-base
 * guessing or path truncation: failures conservatively retain full coverage.
 * @param {{ event?: string, base?: string, head?: string, repository?: string }} options
 * @returns {ValidationScope}
 */
export function selectValidationScope({ event, base, head, repository = process.cwd() }) {
  if (event !== "pull_request") return fullScope("integrated-or-unknown-event");
  const commit = /^[a-f0-9]{40}$/;
  if (typeof base !== "string" || typeof head !== "string" || !commit.test(base) || !commit.test(head)) {
    return fullScope("unavailable-comparison");
  }
  try {
    const options = { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000, maxBuffer: 8 * 1024 * 1024 };
    if (execFileSync("git", ["rev-parse", "HEAD"], options).trim() !== head) return fullScope("unavailable-comparison");
    execFileSync("git", ["merge-base", "--is-ancestor", base, head], options);
    const changed = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", base, head, "--"], options);
    if (changed !== "" && !changed.endsWith("\0")) return fullScope("unavailable-comparison");
    return classifyValidationPaths(changed === "" ? [] : changed.slice(0, -1).split("\0"));
  } catch {
    // Git failures can contain local paths. The categorical fallback is public;
    // it broadens checks rather than turning an unavailable diff into a skip.
    return fullScope("unavailable-comparison");
  }
}

/** @param {string | undefined} value @returns {boolean} */
function readRequiredFlag(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("Missing or invalid validation applicability output.");
}

/** @returns {void} */
function main() {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "--report" && ["runtime", "browser"].includes(args[1])) {
    const required = readRequiredFlag(process.env[args[1] === "runtime" ? "TABGRAD_VALIDATION_RUNTIME" : "TABGRAD_VALIDATION_BROWSER"]);
    console.log(JSON.stringify({ family: args[1], applicability: required ? "required" : "not-applicable" }));
    return;
  }
  if (args.length !== 0) throw new Error("Use: node scripts/validation-scope.mjs [--report runtime|browser]");
  const scope = selectValidationScope({
    event: process.env.TABGRAD_VALIDATION_EVENT,
    base: process.env.TABGRAD_VALIDATION_BASE,
    head: process.env.TABGRAD_VALIDATION_HEAD,
  });
  console.log(JSON.stringify(scope));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `runtime=${scope.runtime}\nbrowser=${scope.browser}\nreason=${scope.reason}\n`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(); }
  catch (error) {
    // Fail the job without publishing a stack or output-file path. These
    // categorical errors distinguish a bad contract from recording failure.
    const message = error instanceof Error && /^(Missing or invalid|Use:)/.test(error.message)
      ? error.message : "Unable to record validation applicability outputs.";
    console.error(message);
    process.exitCode = 1;
  }
}
