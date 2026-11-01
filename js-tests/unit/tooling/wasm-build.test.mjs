import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// This compiler double chooses its output independently, following Cargo's
// explicit argument / environment / default precedence. Real Cargo/ABI and
// browser checks separately qualify the resulting production modules.
const compiler = `import {appendFileSync, mkdirSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
const args=process.argv.slice(2), index=args.indexOf("--target-dir");
const target=resolve(index<0 ? (process.env.CARGO_TARGET_DIR ?? "target") : args[index+1]);
const variant=process.env.RUSTFLAGS.includes("target-feature=+simd128") ? "simd128" : "scalar";
if(process.env.TEST_CARGO_FAILURE==="yes") process.exit(9);
if(process.env.TEST_CARGO_MISSING==="yes") process.exit(0);
const marker=Buffer.from("fresh-"+variant), bytes=Buffer.from([0,97,115,109,1,0,0,0,0,marker.length+1,0,...marker]);
const path=join(target,"wasm32-unknown-unknown/release/tabgrad_wasm_kernels.wasm");
mkdirSync(dirname(path),{recursive:true}); writeFileSync(path,bytes);
appendFileSync("compiler-results.jsonl",JSON.stringify({variant,path,bytes:bytes.toString("base64")})+"\\n");
`;

async function fixture(context, { redirected = false, stale = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tabgrad-wasm-build-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  for (const script of ["build-wasm.mjs", "write-wasm-manifest.mjs"]) {
    await copyFile(new URL(`../../../scripts/${script}`, import.meta.url), join(root, "scripts", script));
  }
  const cargo = join(root, "cargo-double.mjs");
  await writeFile(cargo, `#!${process.execPath}\n${compiler}`, { mode: 0o700 });
  if (stale) {
    const directory = join(root, "target/wasm32-unknown-unknown/release");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "tabgrad_wasm_kernels.wasm"), "obsolete-module");
  }
  const env = { ...process.env, CARGO: cargo };
  delete env.CARGO_TARGET_DIR;
  if (redirected) env.CARGO_TARGET_DIR = redirected === "relative" ? "alternate target" : join(root, "alternate target");
  return { root, env };
}

function runScript(fixture, script, extra = {}) {
  return spawnSync(process.execPath, [join(fixture.root, "scripts", script)], {
    cwd: fixture.root, env: { ...fixture.env, ...extra }, encoding: "utf8",
  });
}

for (const redirected of [false, "absolute", "relative"]) {
  for (const stale of [false, true]) {
    test(`Wasm build copies each produced variant: redirect=${redirected}, stale=${stale}`, async context => {
      const state = await fixture(context, { redirected, stale });
      const result = runScript(state, "build-wasm.mjs");
      assert.equal(result.status, 0, result.stderr);
      const observations = (await readFile(join(state.root, "compiler-results.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
      assert.deepEqual(observations.map(item => item.variant), ["scalar", "simd128"]);
      assert.notEqual(observations[0].bytes, observations[1].bytes);
      assert.equal(runScript(state, "write-wasm-manifest.mjs").status, 0);
      const manifest = JSON.parse(await readFile(join(state.root, "dist/manifest.json"), "utf8"));
      for (const [index, produced] of observations.entries()) {
        const bytes = await readFile(join(state.root, `dist/wasm/kernels-${produced.variant}.wasm`));
        assert.deepEqual(bytes, Buffer.from(produced.bytes, "base64"));
        assert.equal(WebAssembly.validate(bytes), true);
        assert.equal(manifest.variants[index].byteLength, bytes.length);
        assert.equal(manifest.variants[index].sha256, createHash("sha256").update(bytes).digest("hex"));
      }
      assert.deepEqual(manifest.variants.map(item => item.requiredFeatures), [[], ["simd128"]]);
    });
  }
}

for (const failure of ["TEST_CARGO_FAILURE", "TEST_CARGO_MISSING"]) {
  test(`Wasm build cannot report success when ${failure}`, async context => {
    const state = await fixture(context, { redirected: "absolute" });
    const result = runScript(state, "build-wasm.mjs", { [failure]: "yes" });
    assert.notEqual(result.status, 0);
    await assert.rejects(access(join(state.root, "dist/wasm/kernels-scalar.wasm")));
    await assert.rejects(access(join(state.root, "dist/wasm/kernels-simd128.wasm")));
  });
}
