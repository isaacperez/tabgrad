import { copyFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const outputDirectory = fileURLToPath(new URL("../dist/wasm", import.meta.url));
const compiledModule = fileURLToPath(
  new URL(
    "../target/wasm32-unknown-unknown/release/tabgrad_wasm_kernels.wasm",
    import.meta.url,
  ),
);

const commonRustFlags = [
  "-C", "link-arg=--import-memory",
  "-C", "link-arg=--initial-memory=2097152",
  "-C", "link-arg=--max-memory=67108864",
];

await mkdir(outputDirectory, { recursive: true });

for (const variant of [
  { id: "scalar", targetFeature: "-simd128" },
  { id: "simd128", targetFeature: "+simd128" },
]) {
  const result = spawnSync(
    process.env.CARGO ?? "cargo",
    [
      "build",
      "--locked",
      "--release",
      "--target",
      "wasm32-unknown-unknown",
      "--package",
      "tabgrad-wasm-kernels",
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        RUSTFLAGS: [...commonRustFlags, "-C", `target-feature=${variant.targetFeature}`].join(" "),
      },
      stdio: "inherit",
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  await copyFile(compiledModule, `${outputDirectory}/add-f32-${variant.id}.wasm`);
}
