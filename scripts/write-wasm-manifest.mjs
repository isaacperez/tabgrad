import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const variants = [];
for (const descriptor of [
  { id: "scalar", requiredFeatures: [] },
  { id: "simd128", requiredFeatures: ["simd128"] },
]) {
  const relativePath = `wasm/add-f32-${descriptor.id}.wasm`;
  const bytes = await readFile(new URL(`../dist/${relativePath}`, import.meta.url));
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
  moduleVersion: 1,
  abiVersion: 1,
  addressWidth: 32,
  sharedMemory: false,
  capabilities: ["add-f32"],
  imports: [{ module: "env", name: "memory", kind: "memory" }],
  memory: {
    initialPages: 32,
    maximumPages: 1024,
    alignment: 16,
  },
  variants,
};

await writeFile(
  new URL("../dist/manifest.json", import.meta.url),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
