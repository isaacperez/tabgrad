import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../..", import.meta.url));

/** Run a bounded contributor process; preserve its useful failure output. */
export function runPackageProcess(command, arguments_, cwd) {
  const result = spawnSync(command, arguments_, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed:\n${result.stdout}\n${result.stderr}`);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  return result.stdout;
}

/** Install an actual offline tarball in an application outside the checkout. */
export async function createPackageApplication({ tarball: suppliedTarball } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "tabgrad-package-"));
  try {
    const artifacts = join(directory, "artifacts");
    const application = join(directory, "application");
    const cache = join(directory, "cache");
    await mkdir(artifacts);
    await mkdir(application);
    const packed = JSON.parse(runPackageProcess("npm", [
      "pack", ...(suppliedTarball === undefined ? [] : [suppliedTarball]),
      "--offline", "--ignore-scripts", "--json", "--pack-destination", artifacts,
      "--cache", cache,
    ], repository))[0];
    const tarball = join(artifacts, packed.filename);
    await writeFile(join(application, "package.json"), '{"private":true,"type":"module"}\n');
    runPackageProcess("npm", [
      "install", tarball, "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
      "--package-lock=false", "--cache", cache,
    ], application);
    const metadata = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    const packageDirectory = join(application, "node_modules", ...metadata.name.split("/"));
    return {
      directory, application, packageDirectory, tarball, packed, metadata,
      async close() { await rm(directory, { recursive: true, force: true }); },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
