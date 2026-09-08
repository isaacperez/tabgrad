import { spawnSync } from "node:child_process";

function run(arguments_, environment = {}) {
  const result = spawnSync(process.env.CARGO ?? "cargo", arguments_, {
    env: { ...process.env, ...environment },
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(["fmt", "--all", "--check"]);

for (const targetFeature of ["-simd128", "+simd128"]) {
  run(
    [
      "clippy",
      "--locked",
      "--release",
      "--target",
      "wasm32-unknown-unknown",
      "--package",
      "tabgrad-wasm-kernels",
      "--",
      "-D",
      "warnings",
    ],
    { RUSTFLAGS: `-C target-feature=${targetFeature}` },
  );
}
