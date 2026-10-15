import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPackageProcess } from "./package-application.mjs";

const repository = fileURLToPath(new URL("../..", import.meta.url));
export const sourceRevision = "a".repeat(40);

export function hash(bytes, algorithm = "sha256", encoding = "hex") {
  return createHash(algorithm).update(bytes).digest(encoding);
}

export function archiveIdentity(bytes) {
  return { byteLength: bytes.length, sha256: hash(bytes), integrity: `sha512-${hash(bytes, "sha512", "base64")}` };
}

export async function packageFixture(context, { fullRuntime = false, extraFiles = [], metadataOverrides = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "tabgrad-retained-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source with spaces");
  await mkdir(join(source, "dist"), { recursive: true });
  const metadata = fullRuntime ? JSON.parse(await readFile(join(repository, "package.json"), "utf8"))
    : { type: "module", files: ["dist/"], exports: { ".": "./dist/index.js" } };
  metadata.name = "@tabgrad/retained-fixture";
  metadata.version = "0.9.7";
  metadata.private = false;
  delete metadata.devDependencies;
  delete metadata.packageManager;
  const lifecycleMarker = join(directory, "lifecycle-executed");
  metadata.scripts = { postinstall: `node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(lifecycleMarker)}, 'unexpected')`)}` };
  Object.assign(metadata, metadataOverrides);
  if (fullRuntime) await cp(join(repository, "dist"), join(source, "dist"), { recursive: true });
  else await writeFile(join(source, "dist/index.js"), "export const value = 11;\n");
  for (const [path, bytes] of extraFiles) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), bytes);
  }
  await writeFile(join(source, "package.json"), JSON.stringify(metadata));
  await writeFile(join(source, "LICENSE"), "Synthetic retained-package fixture.\n");
  const documentation = fullRuntime ? await readFile(join(repository, "docs/reference/browser-package.md"), "utf8") : "Synthetic package.\n";
  await writeFile(join(source, "README.md"), `# Tabgrad ${metadata.version}\n\nSource commit: \`${sourceRevision}\`.\n\n${documentation}`);
  const packed = JSON.parse(runPackageProcess("npm", ["pack", "--offline", "--ignore-scripts", "--json",
    "--pack-destination", directory, "--cache", join(directory, "pack-cache")], source))[0];
  const files = [];
  for (const { path } of packed.files) {
    const bytes = await readFile(join(source, path));
    files.push({ path, byteLength: bytes.length, sha256: hash(bytes) });
  }
  const tarball = join(directory, packed.filename);
  const bytes = await readFile(tarball);
  const expected = { schemaVersion: 1, name: metadata.name, version: metadata.version, private: false,
    sourceRevision, staticDirectory: "package/dist", files, tarball: { path: packed.filename, ...archiveIdentity(bytes) } };
  return { directory, source, metadata, tarball, bytes, expected, lifecycleMarker };
}

