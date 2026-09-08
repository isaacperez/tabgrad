# Development environment and commands

This document is the source of truth for preparing a Tabgrad development
environment and running repository commands. A command is required only after
it is listed here and its configuration exists in the repository.

## Reproducible environment rules

Run commands from the repository root unless a command below states otherwise.
Use the versions selected by committed version files, manifests, and lockfiles.
Do not rely on an undocumented global package, shell alias, editor action, or
machine-specific path.

When the project selects Node.js, Python, Pyodide, browsers, or other tools,
record their supported versions in committed configuration and update this
document in the same change. A contributor must be able to distinguish a
required tool from an optional tool used for one specialized environment.

Do not install or update dependencies as an incidental side effect of a test.
Setup commands may install the versions recorded by the manifests and
lockfiles. Verification commands must fail clearly when setup is missing rather
than silently changing the persistent environment.

Keep credentials and local configuration outside version control. Provide a
documented example file with placeholder values when a required local setting
cannot have a safe default. Never place real secrets in an example, test,
fixture, log, or generated artifact.

## Prepare the repository tooling environment

Repository tooling uses Python 3.11. Create and activate a
virtual environment, then install the locked development dependencies:

```console
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --only-binary=:all: --require-hashes -r requirements-dev.lock
```

The activation command shown above is for POSIX shells. Use the activation
command provided by Python's `venv` module on another shell. Dependency setup
downloads packages and writes only to the selected virtual environment and
the package manager's ordinary cache.

## Prepare the browser-runtime build environment

Building the browser runtime requires two toolchains because they own different
artifacts. Node.js runs the TypeScript compiler and repository scripts. Rust
compiles numerical CPU kernels to WebAssembly. Neither toolchain is shipped to
or installed by a web application that uses the resulting files.

| Tool | Selected version or requirement | Why it is needed |
| --- | --- | --- |
| Node.js | `22.12.0`, selected by `.node-version` | Run build, test, manifest, and measurement scripts |
| npm | `11.1.0`, selected by `packageManager` in `package.json` | Install the exact `package-lock.json` resolution and run stable commands |
| Rust compiler and standard library | `1.98.1`, selected by `rust-toolchain.toml` | Compile Rust kernel source for checks and the WebAssembly target |
| WebAssembly Rust target | `wasm32-unknown-unknown` | Produce browser-portable CPU modules without an operating-system interface |
| Rustfmt and Clippy | Components from the selected Rust toolchain | Check Rust formatting and static diagnostics |
| Chrome and Firefox | Releases with baseline WebAssembly and WebAssembly SIMD | Run real-browser integration; exact tested releases belong in verification evidence |

Install Node.js with a version manager that reads `.node-version`, or provide
the exact selected version by an equivalent controlled method. An ordinary
Node.js installation includes npm; verify that its version matches
`package.json`. If it differs, deliberately select the pinned release before
installing dependencies:

```console
npm install --global npm@11.1.0 --ignore-scripts --no-audit --no-fund
```

This setup command changes the active Node.js installation and npm's cache; it
does not run a repository package lifecycle script.

Install `rustup` from the official Rust distribution channel and make its
`cargo` executable available on `PATH`. Then install the repository-selected
compiler, target, and quality components:

```console
rustup toolchain install 1.98.1 --profile minimal --component rustfmt --component clippy --target wasm32-unknown-unknown
```

The minimal profile avoids documentation and unrelated targets. Rustup writes
to its configured toolchain and Cargo directories. On its standard POSIX
installation those directories are below `.rustup` and `.cargo` in the user's
home directory; adding `.cargo/bin` to `PATH` is a shell-environment action,
not a repository change.

Install the locked JavaScript development dependency from the repository root:

```console
npm ci --ignore-scripts --no-audit --no-fund
```

This command downloads TypeScript and writes `node_modules/` plus npm's ordinary
cache. It runs no package lifecycle scripts, performs no audit network request,
and does not change `package-lock.json`. Use `npm install` only when deliberately
changing the manifest and lockfile together under the dependency policy.

The browser suite uses installed Chrome and Firefox executables; it does not
download browsers. On macOS and the GitHub Actions Linux runner it checks the
standard application paths. Set `TABGRAD_CHROME` or `TABGRAD_FIREFOX` to an
absolute executable path on another installation. Each test starts one
headless browser at a time with a disposable profile and a loopback-only HTTP
server, then terminates the process and removes that profile.

## Use the prepared environment

Run repository Python commands with the interpreter in `.venv`. On POSIX
systems, use `.venv/bin/python`; on Windows, use the corresponding interpreter
under `.venv\Scripts`. Calling that interpreter directly does not require
activating the environment first.

Before the first Python command in a task, confirm that the interpreter exists
and can load the required tool. If the environment is missing, uses the wrong
Python version, or lacks a locked dependency, do not fall back to a global
interpreter and do not install or update packages silently. Report the failed
check and the setup command above. Creating or repairing the environment may
download packages and change persistent local state, so perform it only when
that setup is authorized.

## Diagnose GitHub access

GitHub CLI commands that inspect or change remote state require network access
in addition to a stored credential. When an agent needs GitHub, it must run a
bounded read-only request such as `gh api user --jq .login` with the network
access required by its execution environment. Requesting that access does not
authorize a GitHub mutation.

A GitHub command that ran without network access cannot establish whether a
credential is valid. Treat a connection, name-resolution, sandbox, or other
transport failure as an environment failure. Retry only the minimum read-only
request with network access before drawing an authentication conclusion. An
authentication response from GitHub shows a credential problem; a response
that denies a repository, project, or operation while the user identity is
valid shows an authorization or credential-scope problem. Preserve the exact
command, access conditions, exit status, and useful output in the diagnosis.

The in-app browser and GitHub CLI do not establish access for each other. Do
not open a browser or run `gh auth login`, `gh auth refresh`, `gh auth logout`,
or another credential-changing command as an automatic fallback. First
establish the failure with network access, then explain the evidence and obtain
the user's authorization before changing credentials. Never print or persist a
token in repository files, command output, logs, or issue content.

## Configured commands

The repository provides these commands:

The `python3` spelling below is valid locally only after `.venv` has been
activated. A coding agent should avoid relying on shell activation and replace
that leading executable with `.venv/bin/python` on POSIX or the corresponding
`.venv\Scripts` interpreter on Windows. In continuous integration, the workflow
prepares the selected Python interpreter and installs the same locked
dependencies before it uses the documented `python3` entry points. The table
does not authorize an unprepared global interpreter.

| Purpose | Command | Requirements |
| --- | --- | --- |
| Install locked development dependencies | `python -m pip install --only-binary=:all: --require-hashes -r requirements-dev.lock` | An active Python 3.11 virtual environment; writes only to that environment and the package manager's ordinary cache |
| Format maintained Python files | `python3 -m ruff format scripts tests` | The prepared repository tooling environment; rewrites files in place |
| Check maintained Python formatting | `python3 -m ruff format --check scripts tests` | The prepared repository tooling environment; read-only |
| Lint maintained Python files | `python3 -m ruff check scripts tests` | The prepared repository tooling environment; read-only |
| Validate repository policies and structure | `python3 scripts/check_repository.py` | The prepared repository tooling environment |
| Test the repository validator | `python3 scripts/run_tests.py` | The prepared repository tooling environment |
| Install the pinned Rust toolchain | `rustup toolchain install 1.98.1 --profile minimal --component rustfmt --component clippy --target wasm32-unknown-unknown` | Network access and authorized writes to the configured rustup directories; does not modify the repository |
| Select the pinned npm release | `npm install --global npm@11.1.0 --ignore-scripts --no-audit --no-fund` | Node.js 22.12.0, network access, and authorized writes to that Node.js installation plus npm's cache; does not modify the repository |
| Install locked JavaScript development dependencies | `npm ci --ignore-scripts --no-audit --no-fund` | Node.js 22.12.0 and npm 11.1.0; downloads TypeScript and recreates `node_modules/` from `package-lock.json` |
| Build the browser distribution | `npm run build` | Prepared Node.js and Rust environments; rewrites ignored `dist/` and updates Cargo's ignored `target/` cache |
| Check TypeScript and Rust | `npm run check` | Prepared Node.js and Rust environments; reads TypeScript source and runs Rustfmt plus Clippy for scalar and SIMD targets |
| Run JavaScript and browser tests | `npm test` | Prepared build environment, Chrome, Firefox, permission to launch headless processes, and a free loopback port; rebuilds `dist/`, uses disposable browser profiles, and runs one browser at a time |
| Run JavaScript integration tests only | `npm run test:unit` | An existing `dist/` build and permission to listen on a loopback port; does not rebuild source |
| Run real-browser integration tests only | `npm run test:browser` | An existing `dist/` build, Chrome, Firefox, and a loopback port; launches one headless browser at a time |
| Measure bounded runtime and artifact costs | `npm run measure` | Prepared build and browser environments; rebuilds `dist/` and writes an ignored report under `test-results/` |
| Remove the browser distribution | `npm run clean` | Deletes only the ignored `dist/` directory |
| Update the JavaScript lock after an authorized dependency change | `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` | Node.js 22.12.0, npm 11.1.0, and registry access; rewrites only `package-lock.json` plus npm cache state |
| Update the Rust lock after an authorized dependency change | `cargo generate-lockfile` | Rust and Cargo 1.98.1 plus registry access if a dependency is introduced; rewrites `Cargo.lock` |
| Format maintained Rust files | `cargo fmt --all` | Rustfmt from toolchain 1.98.1; rewrites maintained Rust source |

Ruff reads `ruff.toml`. The formatter and linter cover the maintained Python
files under `scripts/` and `tests/`. The formatting command is the only command
in this group that rewrites source; verification and continuous integration use
the two read-only check commands.

TypeScript reads `tsconfig.json`. Cargo reads `Cargo.toml`, `Cargo.lock`, and
`rust-toolchain.toml`. `npm run check` does not rewrite maintained source;
developers may run `cargo fmt --all` explicitly when they intend to format Rust
source. `npm test` builds the exact ignored distribution tested by both the
Node.js integration suite and the real browsers. No test installs or updates a
dependency.

Delete `node_modules/`, `target/`, `dist/`, or `test-results/` only when their
corresponding disposable local state must be rebuilt. Each path is ignored.
Do not use a broad recursive deletion against the repository root. The
`npm run clean` command is the safe registered cleanup for the distribution;
package-manager caches and installed toolchains are shared user resources and
are not removed by repository commands.

Every configured command must appear in this registry. Add or change an entry
in the same repository change as its executable configuration and local
verification evidence.

## Add or change a command

Use one stable entry point for each purpose. Prefer package scripts or a small
repository script over instructions that require contributors to assemble a
long command manually. The entry point must return a nonzero status for a
failed check and must not rewrite source during verification unless its name
and documentation explicitly describe a formatting or generation action.

Document:

- the purpose and files or behavior covered;
- required tool and environment versions;
- setup and working directory;
- whether the command reads, rewrites, generates, downloads, starts a service,
  uses hardware, or accesses an external system;
- outputs, caches, ports, or processes it creates;
- how to clean disposable outputs without risking unrelated files; and
- the equivalent continuous-integration job when one exists.

Update [`quality.md`](quality.md), [`generated-files.md`](generated-files.md),
or [`performance.md`](performance.md) when the command establishes evidence for
those subjects.

## Diagnose environment failures

Record the exact command, tool versions, operating system, browser, hardware,
backend, configuration, exit status, and useful output. Determine whether the
same failure occurs at the base revision in a comparable environment.

Do not modify a project check to accommodate one undocumented machine. If an
environment is supported, correct the repository or its documented setup. If
it is not supported, make that boundary explicit rather than reporting the
check as passed.
