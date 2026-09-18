import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const output = new URL("../dist/python/", import.meta.url);
await mkdir(new URL("torch/", output), { recursive: true });
const files = [];
for (const path of ["bootstrap.py", "torch/__init__.py"]) {
  const bytes = await readFile(new URL(`../python/${path}`, import.meta.url));
  await writeFile(new URL(path, output), bytes);
  files.push({
    path,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
await writeFile(new URL("manifest.json", output), `${JSON.stringify({
  schemaVersion: 1,
  bridgeVersion: 1,
  pyodideVersion: "314.0.6",
  files,
}, null, 2)}\n`);
