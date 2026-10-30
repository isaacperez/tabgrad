import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix } from "node:path";

// Reviewed internal pin data is shared by acquisition and admission, never read from a proof.
const profile = JSON.parse(await readFile(new URL("./publication-client-profile.json", import.meta.url), "utf8"));
export const publicationVersions = Object.freeze({ node: profile.node.version, npm: profile.npm.version });
const digest = (bytes, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
const sha256 = /^[0-9a-f]{64}$/;
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);

export class PublicationClientError extends Error {
  constructor(code, dispatched = false, options) {
    super(code, options); this.name = "PublicationClientError";
    this.code = code; this.dispatched = dispatched;
  }
}

function check(condition, code) { if (!condition) throw new PublicationClientError(code); }
function keys(value, names) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}

async function regular(path, expectedBytes) {
  const stat = await lstat(path);
  check(stat.isFile() && !stat.isSymbolicLink() && (expectedBytes === undefined || stat.size === expectedBytes),
    "PUBLICATION_CLIENT_CHANGED");
  return readFile(path);
}

async function inspectDirectory(root, admitted) {
  const directories = new Set([""]);
  for (const name of admitted) {
    let parent = posix.dirname(name);
    while (parent !== ".") { directories.add(parent); parent = posix.dirname(parent); }
  }
  const names = [];
  const pending = [""];
  while (pending.length > 0) {
    const parent = pending.pop();
    for (const entry of await readdir(join(root, parent), { withFileTypes: true })) {
      const relative = posix.join(parent, entry.name);
      if (entry.isDirectory()) {
        check(directories.has(relative), "PUBLICATION_CLIENT_CHANGED");
        pending.push(relative);
      }
      else {
        check(entry.isFile(), "PUBLICATION_CLIENT_CHANGED");
        names.push(relative);
        check(names.length <= admitted.length, "PUBLICATION_CLIENT_CHANGED");
      }
    }
  }
  return names.sort();
}

/** Explicit prepared locator + independently admitted manifest digest; never install here. */
export async function identifyPublicationClient(directory, expectedSha256, limits) {
  check(isAbsolute(directory) && matches(sha256, expectedSha256), "PUBLICATION_CLIENT_IDENTITY");
  const root = await realpath(directory);
  const manifestPath = join(root, "client.json");
  const stat = await lstat(manifestPath);
  check(stat.isFile() && stat.size <= 1024 * 1024, "PUBLICATION_CLIENT_IDENTITY");
  const bytes = await regular(manifestPath);
  check(digest(bytes) === expectedSha256, "PUBLICATION_CLIENT_IDENTITY");
  let client;
  try { client = JSON.parse(bytes); } catch { throw new PublicationClientError("PUBLICATION_CLIENT_IDENTITY"); }
  check(keys(client, ["schemaVersion", "platform", "architecture", "node", "npm"])
    && client.schemaVersion === 1 && client.platform === process.platform && client.architecture === process.arch
    && keys(client.node, ["path", "version", "byteLength", "sha256", "sourceArchiveSha256", "license"])
    && client.node.path === "node" && client.node.version === publicationVersions.node
    && Number.isSafeInteger(client.node.byteLength) && client.node.byteLength > 0
    && client.node.byteLength <= profile.node.maxBinaryBytes
    && matches(sha256, client.node.sha256)
    && client.node.sourceArchiveSha256 === profile.node.archives[`${process.platform}-${process.arch}`]?.sha256
    && keys(client.node.license, ["path", "byteLength", "sha256"]) && client.node.license.path === "node-license.txt"
    && Number.isSafeInteger(client.node.license.byteLength) && client.node.license.byteLength > 0
    && client.node.license.byteLength <= profile.node.maxLicenseBytes && matches(sha256, client.node.license.sha256)
    && keys(client.npm, ["directory", "version", "sourceArchiveSha512", "files"])
    && client.npm.directory === "npm" && client.npm.version === publicationVersions.npm
    && client.npm.sourceArchiveSha512 === profile.npm.sha512
    && Array.isArray(client.npm.files) && client.npm.files.length === profile.npm.fileCount,
  "PUBLICATION_CLIENT_IDENTITY");
  check(digest(await regular(join(root, "node"), client.node.byteLength)) === client.node.sha256, "PUBLICATION_CLIENT_CHANGED");
  check(digest(await regular(join(root, "node-license.txt"), client.node.license.byteLength)) === client.node.license.sha256,
    "PUBLICATION_CLIENT_CHANGED");
  const admitted = [];
  const npmRoot = await lstat(join(root, "npm"));
  check(npmRoot.isDirectory() && !npmRoot.isSymbolicLink(), "PUBLICATION_CLIENT_CHANGED");
  let byteLength = 0;
  for (const file of client.npm.files) {
    check(keys(file, ["path", "byteLength", "sha256"]) && typeof file.path === "string"
      && file.path.length > 0 && file.path !== "." && !file.path.startsWith("/")
      && !file.path.includes("\\") && !file.path.split("/").includes("..")
      && posix.normalize(file.path) === file.path && Number.isSafeInteger(file.byteLength)
      && file.byteLength >= 0 && matches(sha256, file.sha256), "PUBLICATION_CLIENT_IDENTITY");
    byteLength += file.byteLength;
    check(byteLength <= profile.npm.unpackedBytes, "PUBLICATION_CLIENT_IDENTITY");
    admitted.push(file.path);
    check(digest(await regular(join(root, "npm", file.path), file.byteLength)) === file.sha256,
      "PUBLICATION_CLIENT_CHANGED");
  }
  check(byteLength === profile.npm.unpackedBytes && new Set(admitted).size === admitted.length
    && admitted.includes("bin/npm-cli.js"), "PUBLICATION_CLIENT_IDENTITY");
  check(JSON.stringify(await inspectDirectory(join(root, "npm"), admitted)) === JSON.stringify(admitted.sort()),
    "PUBLICATION_CLIENT_CHANGED");
  const state = { ...client, directory: root, manifestSha256: expectedSha256,
    executable: join(root, "node"), npmEntry: join(root, "npm/bin/npm-cli.js") };
  // Do not load a project/user .npmrc from the supplied tools directory while
  // identifying it. Version probes have their own disposable HOME and cwd.
  const directory_ = await mkdtemp(join(tmpdir(), "tabgrad-publication-version-"));
  try {
    const environment = publicationEnvironment(directory_);
    const node = await runPublicationProcess(state.executable, ["--version"], { directory: directory_, environment, ...limits });
    const npm = await runPublicationProcess(state.executable, [state.npmEntry, "--version"], { directory: directory_, environment, ...limits });
    check(node.stdout.trim() === `v${publicationVersions.node}` && npm.stdout.trim() === publicationVersions.npm,
      "PUBLICATION_CLIENT_VERSION");
  } finally { await rm(directory_, { recursive: true, force: true }); }
  return state;
}

/** No inherited npm/Git/SSH/proxy/Node identity. Role credentials are added by their owner. */
export function publicationEnvironment(directory, input = process.env) {
  const result = {};
  for (const name of ["SYSTEMROOT", "WINDIR", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ"]) {
    if (typeof input[name] === "string") result[name] = input[name];
  }
  return { ...result, HOME: directory, USERPROFILE: directory, XDG_CONFIG_HOME: join(directory, "config"),
    XDG_CACHE_HOME: join(directory, "cache"), NODE_DISABLE_COMPILE_CACHE: "1", NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "" };
}

/** Both human launch layers preserve a genuine terminal; no stream is captured. */
export function publicationTerminalStdio() {
  check(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY, "PUBLICATION_INTERACTIVE_REQUIRED");
  return ["inherit", "inherit", "inherit"];
}

/** Owned child completion is observed; a failed dispatched write remains uncertain. */
export async function runPublicationProcess(executable, arguments_, { directory, environment, timeoutMs, maxOutputBytes,
  interactive = false, signal }) {
  check(isAbsolute(executable) && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2147483647
    && Number.isSafeInteger(maxOutputBytes) && maxOutputBytes > 0, "PUBLICATION_CLIENT_BOUNDS");
  const stdio = interactive ? publicationTerminalStdio() : ["ignore", "pipe", "pipe"];
  check(!signal?.aborted, "PUBLICATION_CLIENT_CANCELLED");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, { cwd: directory, env: environment, stdio });
    const stdout = [], stderr = [];
    let count = 0, failure;
    const timer = setTimeout(() => {
      failure ??= "PUBLICATION_CLIENT_TIMEOUT"; child.kill("SIGKILL");
    }, timeoutMs);
    const cancel = () => { failure ??= "PUBLICATION_CLIENT_CANCELLED"; child.kill("SIGKILL"); };
    signal?.addEventListener("abort", cancel, { once: true });
    child.on("error", cause => {
      failure ??= "PUBLICATION_CLIENT_FAILED";
      child.privateCause = cause;
    });
    const accept = (buffer, target) => {
      count += buffer.length;
      if (count > maxOutputBytes) { failure ??= "PUBLICATION_CLIENT_OUTPUT_LIMIT"; child.kill("SIGKILL"); }
      else target.push(buffer);
    };
    child.stdout?.on("data", buffer => accept(buffer, stdout));
    child.stderr?.on("data", buffer => accept(buffer, stderr));
    child.once("close", (status, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      const result = { status, signal: exitSignal, stdout: interactive ? null : Buffer.concat(stdout).toString("utf8"),
        stderr: interactive ? null : Buffer.concat(stderr).toString("utf8"), dispatched: child.pid !== undefined };
      if (interactive) result.outputMode = "inherited-terminal";
      if (failure || status !== 0) {
        const error = new PublicationClientError(failure ?? "PUBLICATION_CLIENT_REJECTED", result.dispatched,
          { cause: child.privateCause });
        error.privateClientEvidence = result;
        reject(error);
      } else resolve(result);
    });
  });
}
