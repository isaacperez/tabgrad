import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PackageArtifactError, stagePackageArchive, verifyPackageDirectory } from "../../scripts/package-artifact.mjs";

const repository = fileURLToPath(new URL("../..", import.meta.url));

/** Run a bounded contributor process; preserve its useful failure output. */
export function runPackageProcess(command, arguments_, cwd, { reportStderr = true, environment = process.env, timeout, maxBuffer } = {}) {
  // npm enables Node's persistent compile cache unless explicitly disabled.
  // Qualification must not leave that cache outside its disposable owner.
  const result = spawnSync(command, arguments_, { cwd, encoding: "utf8",
    env: { ...environment, NODE_DISABLE_COMPILE_CACHE: "1" }, timeout, maxBuffer, killSignal: "SIGKILL" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`${command} failed:\n${result.stdout}\n${result.stderr}`);
    error.exitCode = result.status;
    error.signal = result.signal;
    throw error;
  }
  if (reportStderr && result.stderr !== "") process.stderr.write(result.stderr);
  return result.stdout;
}

/**
 * Install outside the checkout with scripts disabled and an isolated cache.
 * Supplied archives require independently admitted evidence and use an owned
 * exact copy, never npm pack. With no input, preserve source-policy tests.
 * The returned close() owns only the disposable application, copy and cache.
 */
export async function createPackageApplication({ tarball: suppliedTarball, expected, processOptions } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "tabgrad-package-"));
  let archive;
  try {
    const artifacts = join(directory, "artifacts");
    const application = join(directory, "application");
    const cache = join(directory, "cache");
    await mkdir(artifacts);
    await mkdir(application);
    let packed, tarball, metadata, evidence;
    if (suppliedTarball === undefined) {
      assert.equal(expected, undefined, "A supplied archive is required with expected evidence.");
      packed = JSON.parse(runPackageProcess("npm", [
        "pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", artifacts,
        "--cache", cache,
      ], repository))[0];
      tarball = join(artifacts, packed.filename);
      metadata = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    } else {
      const staged = await stagePackageArchive(suppliedTarball, expected, artifacts);
      ({ tarball, metadata } = staged);
      evidence = staged.expected;
      archive = staged.archive;
      packed = { files: evidence.files };
    }
    await writeFile(join(application, "package.json"), '{"private":true,"type":"module"}\n');
    const configuration = join(directory, "npmrc");
    const globalConfiguration = join(directory, "global-npmrc");
    await writeFile(configuration, "");
    await writeFile(globalConfiguration, "");
    runPackageProcess("npm", [
      "install", tarball, "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
      "--package-lock=false", "--save=false", "--global=false", "--bin-links=false",
      "--userconfig", configuration, "--globalconfig", globalConfiguration, "--cache", cache,
    ], application, { ...processOptions, reportStderr: suppliedTarball === undefined });
    const packageDirectory = join(application, "node_modules", ...metadata.name.split("/"));
    if (evidence !== undefined) await verifyPackageDirectory(packageDirectory, evidence.files);
    return {
      directory, application, packageDirectory, tarball, packed, metadata, evidence,
      async close() { await rm(directory, { recursive: true, force: true }); },
    };
  } catch (error) {
    if (archive !== undefined) {
      if (!(error instanceof PackageArtifactError)) {
        const failure = new PackageArtifactError("INSTALLATION_FAILED", "Offline installation of the admitted archive failed.");
        failure.cause = error;
        failure.exitCode = error.exitCode;
        error = failure;
      }
      error.archive = archive;
    }
    try { await rm(directory, { recursive: true, force: true }); }
    catch (cleanupError) { error.cleanupError = cleanupError; }
    throw error;
  }
}
