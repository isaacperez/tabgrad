import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { wasmProfile } from "./wasm-profile.mjs";
import { assertCpuArtifactAbi, assertCpuMemoryImport, cpuArenaBase } from "../dist/backends/cpu/artifact-abi.js";
import { CPU_ABI_VERSION, CPU_CAPABILITIES } from "../dist/backends/cpu/kernel-catalogue.js";

const variants = [];
for (const descriptor of [
  { id: "scalar", requiredFeatures: [] },
  { id: "simd128", requiredFeatures: ["simd128"] },
]) {
  const relativePath = `wasm/kernels-${descriptor.id}.wasm`;
  const bytes = await readFile(new URL(`../dist/${relativePath}`, import.meta.url));
  const module = await WebAssembly.compile(bytes);
  assertCpuMemoryImport(module);
  const memory = new WebAssembly.Memory({ initial: wasmProfile.initialPages, maximum: wasmProfile.maximumPages });
  const instance = await WebAssembly.instantiate(module, { env: { memory } });
  assertCpuArtifactAbi(instance.exports);
  cpuArenaBase(instance.exports, memory, wasmProfile.alignment);
  variants.push({
    id: descriptor.id,
    path: relativePath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    requiredFeatures: descriptor.requiredFeatures,
  });
}

const manifest = {
  schemaVersion: 1,
  moduleVersion: wasmProfile.moduleVersion,
  abiVersion: CPU_ABI_VERSION,
  addressWidth: 32,
  sharedMemory: false,
  capabilities: CPU_CAPABILITIES,
  imports: [{ module: "env", name: "memory", kind: "memory" }],
  memory: {
    initialPages: wasmProfile.initialPages,
    maximumPages: wasmProfile.maximumPages,
    alignment: wasmProfile.alignment,
  },
  variants,
};

await writeFile(
  new URL("../dist/manifest.json", import.meta.url),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
