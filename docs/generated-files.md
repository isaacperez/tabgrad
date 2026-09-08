# Generated files

This document records every generated file that Tabgrad stores in version
control and the source from which it must be reproduced. Generated output must
never become an unexplained second source of truth.

## Registration requirement

Before committing generated output, add an entry containing:

- the generated path or path pattern;
- the authoritative source files;
- the generator and its pinned version;
- the exact generation command from the repository root;
- relevant deterministic inputs and environment requirements;
- whether the output is committed and why;
- the check that detects stale or irreproducible output;
- any license, attribution, binary-review, or release requirement; and
- the safe cleanup procedure for disposable output.

Do not edit a generated file by hand. Change its source and run the registered
generator. Review both the source change and generated difference. A generator
must produce the same bytes from the same committed inputs, or document and
control every expected source of variation.

Commit generated output only when consumers cannot reasonably generate it,
when it is a distributed artifact whose source must remain reviewable, or when
including it materially improves supported use without creating unacceptable
drift. Caches, local build output, coverage data, logs, downloaded dependencies,
and editor files are not committed generated output.

## Generated-file register

Register every committed generated path in this section using the fields above.
An absent entry provides no authority to commit generated output. Reports,
caches, and other local outputs produced by checks are disposable and must not
be committed. Maintained checker or generator source is not generated output.

Update `.gitignore`, distribution manifests, dependency records, and release
checks in the same change as a registered generated path.

### JavaScript dependency lock

- **Path:** `package-lock.json`.
- **Sources:** `package.json` and the npm registry metadata selected from it.
- **Generator:** npm 11.1.0, selected by `packageManager` in `package.json`.
- **Command:** `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` when an authorized dependency change requires a new resolution.
- **Inputs:** Node.js 22.12.0, npm 11.1.0, the direct version constraints, and registry metadata.
- **Commit policy:** committed because development and release builds must resolve the same compiler artifact and integrity digest.
- **Verification:** `npm ci --ignore-scripts --no-audit --no-fund` accepts the lock without rewriting it; dependency review checks the resulting package tree and license.
- **License and review:** each direct and transitive package remains governed by [Dependencies and third-party code](dependencies.md).
- **Cleanup:** remove only the ignored `node_modules/` installation when a clean install is needed; do not delete the lockfile as cleanup.

### Rust dependency lock

- **Path:** `Cargo.lock`.
- **Sources:** the workspace and crate `Cargo.toml` manifests.
- **Generator:** Cargo 1.98.1 from the toolchain selected by `rust-toolchain.toml`.
- **Command:** `cargo generate-lockfile` after an authorized manifest change.
- **Inputs:** the committed Cargo manifests and the selected Rust toolchain.
- **Commit policy:** committed so kernel builds and checks use an explicit package resolution even when the workspace has no external crates.
- **Verification:** every Cargo build and Clippy command uses `--locked`.
- **License and review:** additions to the lock require the source, license, integrity, and distribution review in [Dependencies and third-party code](dependencies.md).
- **Cleanup:** Cargo's ignored `target/` directory may be removed independently; do not delete the lockfile as cleanup.

### Browser distribution

- **Paths:** `dist/index.js`, `dist/index.d.ts`, their emitted internal JavaScript and declaration modules, `dist/manifest.json`, and `dist/wasm/add-f32-{scalar,simd128}.wasm`.
- **Sources:** `src/**/*.ts`, `crates/tabgrad-wasm-kernels/src/lib.rs`, the Cargo manifests and lock, `tsconfig.json`, `rust-toolchain.toml`, and the build scripts under `scripts/`.
- **Generators:** TypeScript 6.0.3, Rust and Cargo 1.98.1, and the maintained Node.js build scripts.
- **Command:** `npm run build` from the repository root.
- **Inputs:** the prepared environment in [Development environment and commands](development.md). The Rust build fixes release optimization, imported-memory bounds, and scalar or `simd128` target features. The manifest generator hashes the exact emitted module bytes with SHA-256.
- **Commit policy:** not committed. It is ignored because a repository checkout contains the authoritative source and consumers receive distribution artifacts from a controlled release build.
- **Verification:** `npm test` rebuilds the distribution, checks its manifest and raw ABI through Node.js, and loads the same files in Chrome and Firefox. A release additionally records and inspects artifact checksums under [Versions, releases, and migrations](releases.md).
- **License and review:** generated JavaScript and WebAssembly remain Tabgrad output under Apache-2.0; no third-party runtime code is linked into the kernel crate.
- **Cleanup:** `npm run clean` deletes only `dist/`.

### Disposable runtime reports

`npm run measure` writes bounded raw observations under
`test-results/performance.json`. The report includes its environment and exact
revision but is not committed; the applicable issue or pull request preserves
the reviewed evidence and conclusion. The whole `test-results/` directory is
ignored and may be removed without affecting source. Browser profiles are
created in the operating system's temporary directory and removed by the
runner even after a failed case.

## Verify generated output

Run the registered generator in a controlled environment and compare the
complete result with the committed output. An unexpected diff fails the check.
Do not make CI regenerate and silently accept the changed result.

When generated output is binary, preserve a reproducible checksum and a way to
inspect its meaningful source-level content. Treat generation tools and
downloaded inputs as dependencies under [`dependencies.md`](dependencies.md).
