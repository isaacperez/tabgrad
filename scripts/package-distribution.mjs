import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));

function run(command, arguments_, cwd) {
  const result = spawnSync(command, arguments_, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed:\n${result.stdout}\n${result.stderr}`);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  return result.stdout;
}

function cleanRevision() {
  if (run("git", ["status", "--porcelain", "--untracked-files=normal"], repository).trim() !== "") {
    throw new Error("Package preparation requires a clean identified source tree.");
  }
  return run("git", ["rev-parse", "HEAD"], repository).trim();
}

function selectedPath(path) {
  return /^(?:dist\/[A-Za-z0-9_./-]+|LICENSE|README\.md|package\.json)$/.test(path)
    && !path.split("/").includes("..")
    && !["dist/testing.js", "dist/testing.d.ts"].includes(path);
}

function packRecord(stdout) {
  const records = JSON.parse(stdout);
  if (!Array.isArray(records) || records.length !== 1 || !Array.isArray(records[0]?.files)) {
    throw new Error("npm did not identify one inspected package.");
  }
  const record = records[0];
  if (!record.files.every(file => typeof file.path === "string" && selectedPath(file.path))) {
    throw new Error("The selected package contains an unsupported file.");
  }
  return record;
}

async function inventory(directory, files) {
  const result = [];
  for (const { path } of [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    const bytes = await readFile(join(directory, path));
    result.push({ path, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return result;
}

/**
 * Build and inspect an offline candidate from the current clean commit.
 * The retained package/dist directory is the matching static payload. No
 * registry operation, install, account lookup or package lifecycle is run.
 * A newly created output is owned here and removed if preparation fails;
 * existing output is never overwritten or removed.
 */
async function prepareCandidate(output) {
  const revision = cleanRevision();
  const metadata = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
  const nodeVersion = (await readFile(join(repository, ".node-version"), "utf8")).trim();
  const npmVersion = run("npm", ["--version"], repository).trim();
  if (`npm@${npmVersion}` !== metadata.packageManager || process.version !== `v${nodeVersion}`) {
    throw new Error("Package preparation requires the repository-selected Node.js and npm versions.");
  }
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  try {
    process.stderr.write(run("npm", ["run", "build", "--ignore-scripts"], repository));
    const cache = join(output, ".npm-cache");
    const packOptions = ["--offline", "--ignore-scripts", "--json", "--cache", cache];
    const selection = packRecord(run("npm", ["pack", "--dry-run", ...packOptions], repository));
    const selectedPaths = new Set(selection.files.map(file => file.path));
    const packageDirectory = join(output, "package");
    await mkdir(packageDirectory);
    for (const { path } of selection.files) {
      const destination = join(packageDirectory, path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(repository, path), destination);
    }
    const { scripts, devDependencies, packageManager, ...packageMetadata } = metadata;
    await writeFile(join(packageDirectory, "package.json"), `${JSON.stringify(packageMetadata, null, 2)}\n`);
    const readme = (await readFile(join(repository, "docs/reference/browser-package.md"), "utf8"))
      .replace(/^# [^\n]+\n\n/, "")
      .replaceAll("https://github.com/isaacperez/tabgrad/blob/main/", `https://github.com/isaacperez/tabgrad/blob/${revision}/`);
    await writeFile(join(packageDirectory, "README.md"),
      `# Tabgrad ${metadata.version}\n\nSource commit: \`${revision}\`.\n\n${readme}`);
    const packed = packRecord(run("npm", ["pack", ...packOptions, "--pack-destination", output], packageDirectory));
    if (packed.name !== metadata.name || packed.version !== metadata.version
      || packed.files.length !== selection.files.length
      || !packed.files.every(file => selectedPaths.has(file.path))) {
      throw new Error("The final archive differs from the inspected file selection.");
    }
    const files = await inventory(packageDirectory, packed.files);
    const tarball = await readFile(join(output, packed.filename));
    if (cleanRevision() !== revision) throw new Error("Source identity changed while preparing the package.");
    const report = {
      schemaVersion: 1, sourceRevision: revision, name: metadata.name, version: metadata.version,
      private: packageMetadata.private, tools: { node: process.version, npm: npmVersion },
      staticDirectory: "package/dist", files,
      tarball: { path: packed.filename, byteLength: tarball.length,
        sha256: createHash("sha256").update(tarball).digest("hex"), integrity: packed.integrity },
    };
    await writeFile(join(output, "candidate.json"), `${JSON.stringify(report, null, 2)}\n`);
    await rm(cache, { recursive: true, force: true });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

const arguments_ = process.argv.slice(2);
if (arguments_.length > 1) throw new Error("Usage: npm run package -- [new-output-directory]");
await prepareCandidate(resolve(repository, arguments_[0] ?? "build/browser-package"));
