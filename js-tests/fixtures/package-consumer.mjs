import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runPackageProcess } from "./package-application.mjs";
import { RuntimeFixtureServer } from "./runtime-fixture-server.mjs";

// Public consumer checks shared by raw package-policy tests and actual candidates.
// They register no cases and use only installed public entries for execution.
export async function checkPublicPackageEntries(fixture) {
  const name = fixture.metadata.name;
  const entries = ["", "/python", "/webgpu-worker", "/assets/manifest.json",
    "/assets/wasm/kernels-scalar.wasm", "/assets/wasm/kernels-simd128.wasm",
    "/assets/python/manifest.json", "/assets/python/torch/__init__.py"];
  const consumer = join(fixture.application, "resolve.mjs");
  await writeFile(consumer, `import { access } from "node:fs/promises";
const entries = ${JSON.stringify(entries.map(entry => name + entry))};
for (const entry of entries) await access(new URL(import.meta.resolve(entry)));
const direct = await import(${JSON.stringify(name)});
const python = await import(${JSON.stringify(`${name}/python`)});
if (typeof direct.createRuntimeSession !== "function" || typeof python.attachPython !== "function") throw Error("Missing public interface");
for (const entry of ${JSON.stringify([`${name}/runtime/runtime.js`, `${name}/testing`, `${name}/assets/runtime/runtime.js`])}) {
  try { import.meta.resolve(entry); throw Error("Private alias resolved"); }
  catch (error) { if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error; }
}
console.log("public entries resolved");
`);
  assert.equal(runPackageProcess(process.execPath, [consumer], fixture.application).trim(), "public entries resolved");
}

export async function checkPublicPackageTypes(fixture) {
  const consumer = join(fixture.application, "consumer.ts");
  await writeFile(consumer, `import { createRuntimeSession, type Tensor } from ${JSON.stringify(fixture.metadata.name)};
import { attachPython, createWebGpuWorker, type PythonInterpreter } from ${JSON.stringify(`${fixture.metadata.name}/python`)};
const session = createRuntimeSession();
const x: Tensor = session.tensor([2, 3], {requiresGrad: true});
const y: Tensor = x.mul(x).sum();
async function attach(interpreter: PythonInterpreter) { return attachPython(interpreter); }
void attach; void createWebGpuWorker; void y;
`);
  const compiler = fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", import.meta.url));
  runPackageProcess(process.execPath, [compiler, "--ignoreConfig", "--noEmit", "--strict",
    "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2022", "--lib", "es2023,dom", consumer], fixture.application);
}

export async function checkPublicPackageCpuAssets(fixture) {
  const consumer = join(fixture.application, "interfaces.mjs");
  await writeFile(consumer, `export { createRuntimeSession } from ${JSON.stringify(fixture.metadata.name)};
export { attachPython } from ${JSON.stringify(`${fixture.metadata.name}/python`)};\n`);
  const { createRuntimeSession, attachPython } = await import(pathToFileURL(consumer));
  const server = new RuntimeFixtureServer(join(fixture.packageDirectory, "dist"));
  const origin = await server.start();
  try {
    const session = createRuntimeSession({ manifestUrl: new URL("manifest.json", origin) });
    const x = session.tensor([1, 2], { requiresGrad: true });
    const weights = session.tensor([3, 4]);
    const product = x.mul(weights);
    const loss = product.sum();
    const [gradient] = session.grad(loss, [x]);
    try {
      assert.deepEqual(Array.from(await loss.toArray()), [11]);
      assert.deepEqual(Array.from(await gradient.toArray()), [3, 4]);
    } finally {
      gradient.close(); loss.close(); product.close(); weights.close(); x.close();
      await session.close();
    }
    assert.equal(session.diagnostics().liveTensorHandles, 0);
    const manifest = JSON.parse(await readFile(join(fixture.packageDirectory, "dist/manifest.json"), "utf8"));
    const corrupt = structuredClone(manifest);
    for (const variant of corrupt.variants) variant.sha256 = "0".repeat(64);
    for (const [path, value] of [["/corrupt.json", corrupt], ["/incompatible.json", { ...manifest, abiVersion: 2 }]]) {
      server.virtualResponses.set(path, { body: Buffer.from(JSON.stringify(value)), contentType: "application/json" });
    }
    for (const [path, code] of [["missing.json", "BACKEND_LOAD_FAILED"], ["corrupt.json", "BACKEND_HASH_MISMATCH"], ["incompatible.json", "BACKEND_MANIFEST_INVALID"]]) {
      const failed = createRuntimeSession({ manifestUrl: new URL(path, origin) });
      const input = failed.tensor([1]);
      const output = input.sum();
      try { await assert.rejects(output.toArray(), error => error.code === code); }
      finally { output.close(); input.close(); await failed.close(); }
      const after = failed.diagnostics();
      assert.equal(after.liveTensorHandles, 0);
      assert.equal(after.liveRequestLeases, 0);
      assert.equal(after.liveAllocationBytes, 0);
    }
    const python = JSON.parse(await readFile(join(fixture.packageDirectory, "dist/python/manifest.json"), "utf8"));
    let calls = 0;
    const interpreter = { version: "314.0.6", ffi: { PyProxy: class {} },
      runPython() { calls += 1; throw new Error("Unexpected interpreter entry"); },
      async runPythonAsync() { calls += 1; throw new Error("Unexpected interpreter entry"); } };
    server.virtualResponses.set("/python/old.json", { body: Buffer.from(JSON.stringify({ ...python, bridgeVersion: 5 })), contentType: "application/json" });
    await assert.rejects(attachPython(interpreter, { manifestUrl: new URL("python/old.json", origin) }), error => error.code === "PYTHON_ASSET_INVALID");
    server.virtualResponses.set("/python/bootstrap.py", { body: Buffer.from("corrupt source"), contentType: "text/plain" });
    await assert.rejects(attachPython(interpreter, { manifestUrl: new URL("python/manifest.json", origin) }), error => error.code === "PYTHON_ASSET_INVALID");
    assert.equal(calls, 0);
  } finally { await server.close(); }
}
