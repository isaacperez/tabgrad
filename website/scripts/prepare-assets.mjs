import { copyFile, cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { websiteRoot, repositoryRoot, runtimeVersion, pyodideVersion, releaseInput } from "./config.mjs";
import { verifyPackageDirectory } from "../../scripts/package-artifact.mjs";
import { sha256, writeChanged } from "./files.mjs";
import { brandPaths, componentNoticePath, checkGeneratedAssets } from "./generated-assets.mjs";

/** @param {string} root @param {string} prefix @returns {Promise<Record<string,string>>} */
async function inventory(root, prefix = "") {
  const hashes = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symlink in browser assets: ${path}`);
    if (entry.isDirectory()) Object.assign(hashes, await inventory(root, path));
    else if (entry.isFile()) hashes[path] = sha256(await readFile(join(root, path)));
  }
  return hashes;
}

/** @returns {Promise<void>} */
export async function prepareAssets() {
  const packageRoot = releaseInput?.packageDirectory ?? join(websiteRoot, "node_modules/@tabgrad/tabgrad");
  if (releaseInput) await verifyPackageDirectory(packageRoot, releaseInput.inventory);
  const interpreterRoot = join(websiteRoot, "node_modules/pyodide");
  const runtime = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const interpreter = JSON.parse(await readFile(join(interpreterRoot, "package.json"), "utf8"));
  if (runtime.name !== "@tabgrad/tabgrad" || runtime.version !== runtimeVersion || interpreter.version !== pyodideVersion) {
    throw new Error("Installed website browser input versions do not match the website contract");
  }
  await checkGeneratedAssets(join(websiteRoot, "public"), [...brandPaths, componentNoticePath], { allowMissing: true });
  const runtimeDestination = join(websiteRoot, `public/vendor/tabgrad/${runtimeVersion}`);
  const interpreterDestination = join(websiteRoot, `public/vendor/pyodide/${pyodideVersion}`);
  await rm(join(websiteRoot, "public/vendor"), { recursive: true, force: true });
  await mkdir(runtimeDestination, { recursive: true });
  await cp(join(packageRoot, "dist"), runtimeDestination, { recursive: true });
  for (const name of ["LICENSE", "NOTICE", "README.md", "package.json"]) {
    try { await copyFile(join(packageRoot, name), join(runtimeDestination, name)); }
    catch (error) { if (!(name === "NOTICE" && error.code === "ENOENT")) throw error; }
  }
  await mkdir(interpreterDestination, { recursive: true });
  for (const name of ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json", "README.md", "package.json"]) {
    await copyFile(join(interpreterRoot, name), join(interpreterDestination, name));
  }
  for (const name of ["PYODIDE-LICENSE", "PYTHON-LICENSE", "EMSCRIPTEN-LICENSE"]) {
    await copyFile(join(websiteRoot, "third-party", name), join(interpreterDestination, name));
  }
  await mkdir(join(websiteRoot, "public/brand"), { recursive: true });
  for (const path of brandPaths) {
    await copyFile(join(repositoryRoot, "assets", path), join(websiteRoot, "public", path));
  }
  const notices = [];
  for (const name of ["astro", "@astrojs/starlight", "pagefind", "astro-expressive-code", "@expressive-code/core", "@expressive-code/plugin-frames", "@expressive-code/plugin-shiki", "prismjs"]) {
    const root = join(websiteRoot, "node_modules", name);
    const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const path = name === "pagefind" ? join(root, "LICENSE/LICENSE") : join(root, "LICENSE");
    notices.push(`${name} ${metadata.version} (${metadata.license})\n${typeof metadata.repository === "object" ? metadata.repository.url : metadata.repository}\n\n${await readFile(path, "utf8")}`);
  }
  notices.push("@pagefind/default-ui: same Pagefind project license above. Browser UI sources are included in the exact locked package.");
  notices.push(`Svelte 4 runtime bundled by Pagefind UI (MIT)\nhttps://github.com/sveltejs/svelte\n\n${await readFile(join(websiteRoot, "third-party/SVELTE-LICENSE"), "utf8")}`);
  notices.push(`Inter 4.1 (SIL Open Font License 1.1)\nhttps://github.com/rsms/inter/tree/e3a3d4c57d5ecc01453a575621882a384c1995a3\n\n${await readFile(join(websiteRoot, "third-party/INTER-LICENSE"), "utf8")}`);
  await writeChanged(join(websiteRoot, "public", componentNoticePath), notices.join("\n\n--------------------\n\n") + "\n");
  const original = await inventory(join(packageRoot, "dist"));
  const copied = await inventory(runtimeDestination);
  for (const [path, hash] of Object.entries(original)) {
    if (copied[path] !== hash) throw new Error(`Browser asset copy changed bytes: ${path}`);
  }
  const workerSource = await readFile(join(websiteRoot, "src/playground/executor.worker.js"));
  const workerUrl = `/playground/executor-${sha256(workerSource)}.worker.js`;
  await rm(join(websiteRoot, "public/playground"), { recursive: true, force: true });
  await writeChanged(join(websiteRoot, "public", workerUrl), workerSource);
  await writeChanged(join(websiteRoot, ".generated/asset-data.json"), JSON.stringify({
    workerUrl, runtimeBase: `/vendor/tabgrad/${runtimeVersion}/`, pyodideBase: `/vendor/pyodide/${pyodideVersion}/`,
    runtimeVersion, pyodideVersion, runtimeHashes: original,
    pyodideHashes: await inventory(interpreterDestination),
  }, null, 2) + "\n");
}
