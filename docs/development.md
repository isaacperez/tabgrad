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

## Install project agent skills

Tabgrad's agent skills are contributor procedures, not library source or build
dependencies. They are maintained in a separate private Git repository. Public
clones and CI do not download, require or validate that repository. The public
rules in `CONTRIBUTING.md` and `docs/` remain authoritative for every contributor.
The agent-specific routing in `AGENTS.md` requires the relevant skills when an
agent performs that workflow; without them, report the missing installation
rather than improvising a replacement.

An authorized maintainer clones the skill repository outside the library and
follows its installation guide to link its `skills` directory at
`.agents/skills` in each intended Tabgrad checkout. Use a durable local location,
not a temporary directory. Git ignores that project-local path. Do not force-add
it or copy the private content into public documentation, packages or CI.
An existing directory or link must be inspected and preserved before migration;
installation must not overwrite it. Contributors without access should request
setup from the maintainer only when they need the agent workflow, not to build,
test or contribute to Tabgrad by ordinary means.

New clones and worktrees need their own local link. An older checkout may still
track skills: do not replace those files under unrelated work. Integrate the
reviewed migration when safe, preserve any local skill edits, and then install
the external collection. Skills read project documents from the active Tabgrad
checkout, never relative to private storage. Restart Codex if skill discovery
has not refreshed. Project-local links avoid exposing Tabgrad procedures in
unrelated projects.

Edits through these links belong to the separate repository. Review and commit
them there, and push under the usual publication authority to back them up.
Changing public rules still requires updating their skill consumers; review
both revisions together under [instruction review](agent-instruction-review.md).
All worktrees linked to one skill clone share its updates, so do not update
that clone during an active check or review without invalidating affected
evidence. Removing public tracked files does not remove historical copies from
Git; rewriting history is a separate action, not part of this setup.

## Understand the development stack

The development machine and the browser do not need the same software.
Contributors compile Tabgrad and check it against an independent reference;
application users load prebuilt files. In particular, a Python-looking API
does not mean that the browser installs or executes the official PyTorch
runtime.

| Part of the stack | Responsibility | Where it runs |
| --- | --- | --- |
| Python compatibility source | Present the supported Python API and translate language-level calls | Inside Pyodide in the browser |
| Pyodide | Execute Python and provide its connection to JavaScript; it does not implement Tabgrad tensor arithmetic | Loaded by the application host; installed locally as a development dependency for integration checks |
| TypeScript and emitted JavaScript | Own tensor semantics and coordinate execution; TypeScript is compiled before distribution | Compiler on the development machine; emitted JavaScript in the browser |
| Rust and WebAssembly | Compile and execute Tabgrad's CPU numerical kernels | Rust toolchain on the development machine; prebuilt WebAssembly in the browser |
| WGSL and WebGPU | Express and execute GPU numerical work under the accepted backend architecture | Browser-provided WebGPU; no native GPU toolkit is installed by the user |
| Native CPython and official PyTorch | Run development tools and establish independent compatibility expectations | Development machine only; never a fallback tensor engine in the browser |
| Node.js, npm, and installed test browsers | Build, resolve development packages, and check real browser behavior | Development machine and configured CI jobs |

The [architecture guide](architecture/README.md) explains why these
responsibilities are separate. The [dependency register](dependencies.md)
owns exact dependency versions, origins and licenses; the setup sections below
explain how to prepare them. A technology's role in the architecture is not a
claim that every public operation or browser is supported: those claims belong
in the [compatibility record](compatibility.md).

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
| Pyright | `1.1.413`, selected by `package.json` and `package-lock.json` | Check maintained Python types without executing Python code; works alongside Ruff |
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

This command downloads TypeScript, Pyodide, Pyright and their locked dependencies and
writes `node_modules/` plus npm's ordinary
cache. It runs no package lifecycle scripts, performs no audit network request,
and does not change `package-lock.json`. Use `npm install` only when deliberately
changing the manifest and lockfile together under the dependency policy.

The browser suite uses installed Chrome and Firefox executables; it does not
download browsers. On macOS and the GitHub Actions Linux runner it checks the
standard application paths. Set `TABGRAD_CHROME` or `TABGRAD_FIREFOX` to an
absolute executable path on another installation. Each test starts one
headless browser at a time with a disposable profile and a loopback-only HTTP
server, then terminates the process and removes that profile. Set
`TABGRAD_BROWSER` to `Chrome` or `Firefox` to run just that browser; leave it
unset to preserve the full local sequence.

The browser sequence also checks the Python script binding with the locked
Pyodide assets from `node_modules/pyodide/`. Each browser runs ordinary Python
observation and lifecycle checks in two fresh profiles: unmodified JSPI
capabilities, then controlled absence of JSPI before loading Pyodide. The output
records the observed capability in each case; controlled absence is not a claim
about an older native browser. These runs remain sequential and separate from
the direct JavaScript scalar/SIMD checks. The harness serves only its named
Pyodide runtime files, not the complete dependency tree.
Node integration tests reuse one Pyodide interpreter for their script-binding
cases; no test installs packages or downloads an interpreter.

Each browser also runs the application-owned interpreter-worker fixture with
native and controlled-absent JSPI, without cross-origin isolation. A separate
isolated run uses a four-byte shared test gate to park Python and verify
independent host admission and close. The host releases that gate after its
checks, and the wait has a five-second failure bound; it is not a CPU runtime
dependency or a numerical stress workload. Worker fixture scripts are served
as explicitly registered assets, not mistaken for page navigations. All runs
remain sequential.

The browser harness distinguishes two bounded waits. Navigation has 60 seconds
to request the test page; after that request, the application has 30 seconds to
load its artifacts, execute, and report a result. It does not retry a failed
run. A failure reports the selected browser and version, elapsed time, last
reported lifecycle phase, bounded request history without query data, process
exit state, and bounded standard error. Profile-cleanup failures are reported
without replacing the primary execution failure.

## Prepare Python integration and its compatibility oracle

Pyodide and native Python serve different purposes. `npm ci` installs the
pinned Pyodide 314.0.6 distribution under `node_modules/pyodide/`, including
its interpreter WebAssembly and Python standard-library archive. Integration
checks serve these local assets; they must not download an interpreter during
a test. The application host supplies Pyodide to Tabgrad, as described in the
[attachment contract](architecture/python-integration.md). No wheel installer,
NumPy package, or official PyTorch runtime is needed for that browser path.

Official PyTorch is a development-only **oracle**: an independently implemented
reference used to establish expected Python values, metadata, and errors.
Install it only when generating or checking compatibility evidence, not for
ordinary repository tooling or direct JavaScript builds. The selected oracle
is PyTorch 2.14.0. Its source tag identifies
`2b3ec34829036a65cd9d1398ea72a0167dc37470`; the selected official wheel reports
build revision `08187d9e0fba026dc8217405802ab5381dc88d90`. The
[dependency record](dependencies.md#python-integration-and-oracle-dependencies)
explains this distinction. Record the actual build revision when collecting
reference results rather than substituting the tag revision.

The committed oracle lock selects CPython 3.11 wheels for macOS 14 or later on
Apple Silicon. It deliberately does not select Linux CUDA packages or claim
to prepare another native platform. This restriction is on reference
generation, not on the browser distribution. Use the prepared `.venv`:

```console
.venv/bin/python -m pip install --only-binary=:all: --require-hashes -r requirements-oracle.lock
```

The command installs the exact PyTorch wheel and its transitive dependencies
into `.venv`; it can update packages there, including `setuptools`. It writes
the ordinary pip cache, performs no source build, and installs no CUDA toolkit.
The selected PyTorch wheel alone is approximately 127 MB compressed; its
installed footprint is larger. Do not confuse this contributor download with
the browser application's download. On another native platform, stop before
installation and establish a reviewed platform-specific oracle resolution.

To update that lock deliberately, resolve `requirements-oracle.in` using pip
23.2.1 in the same prepared CPython 3.11/macOS arm64 environment. The dry run
can download wheels into pip's cache but does not install them. Keep its report
outside version control, review the resolution, and translate it with the
maintained generator:

```console
.venv/bin/python -m pip install --dry-run --ignore-installed --only-binary=:all: --report /tmp/tabgrad-oracle-resolution.json -r requirements-oracle.in
node scripts/write-oracle-lock.mjs /tmp/tabgrad-oracle-resolution.json
```

The generator checks the report's platform, direct requirements, origins, and
SHA-256 digests before replacing `requirements-oracle.lock`. It performs no
network request. The package manager owns dependency resolution; do not edit
the resulting wheel URLs or hashes by hand. Review licenses and run the
affected compatibility checks after a deliberate update.

PyTorch can warn on import that NumPy is unavailable. This environment does
not install NumPy: the oracle uses tensor/list interfaces, not NumPy
interoperation. Preserve that warning in evidence and do not count NumPy-based
checks as covered. Limit native oracle work to one intra-operation and one
inter-operation thread and small CPU tensors; importing a large package is not
permission to run a large benchmark.

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

For a small Python/direct-JavaScript resource comparison, use
`npm run measure:python` with the separately built baseline configured in
[Python tensor boundary measurements](reference/python-boundary-measurements.md).
It uses the prepared dependencies and local browsers, not an installation or
a load test. Its raw reports remain ignored local output.

Python checks use `.venv/bin/python` explicitly on POSIX. On Windows use the
corresponding `.venv\Scripts` interpreter. CI creates the same isolated
environment with the selected interpreter before installing locked tools;
checks do not depend on shell activation or an unprepared global interpreter.

| Purpose | Command | Requirements |
| --- | --- | --- |
| Install locked development dependencies | `python -m pip install --only-binary=:all: --require-hashes -r requirements-dev.lock` | An active Python 3.11 virtual environment; writes only to that environment and the package manager's ordinary cache |
| Prepare isolated Python tooling in a clean CI checkout | `python -m venv .venv && .venv/bin/python -m pip install --only-binary=:all: --require-hashes -r requirements-dev.lock` | Selected Python 3.11 interpreter and a fresh checkout; creates `.venv` and downloads locked packages; setup only |
| Format maintained Python files | `.venv/bin/python -m ruff format scripts tests python` | The prepared repository tooling environment; rewrites files in place |
| Check maintained Python formatting | `.venv/bin/python -m ruff format --check scripts tests python` | The prepared repository tooling environment; read-only |
| Lint maintained Python files | `.venv/bin/python -m ruff check scripts tests python` | The prepared repository tooling environment; read-only |
| Check maintained Python types | `npm run check:python` | Prepared Node/npm environment and `.venv`; validates the isolated Python 3.11/PyYAML environment, exposes installed Pyodide type sources, then runs locked Pyright with `pyrightconfig.json`; does not execute browser Python modules or install packages |
| Expose installed Pyodide type sources | `.venv/bin/python -I scripts/prepare_pyodide_types.py` | Reads the locked Pyodide standard-library archive and writes only its upstream Python modules under ignored `node_modules/pyodide/python-types/`; no download, installation or import of browser modules; included in `check:python` |
| Validate repository policies and structure | `.venv/bin/python scripts/check_repository.py` | The prepared repository tooling environment |
| Test the repository validator | `.venv/bin/python scripts/run_tests.py` | The prepared repository tooling environment |
| Generate bounded native tensor expectations | `.venv/bin/python scripts/generate_tensor_oracle.py` | Authorized, prepared PyTorch oracle; writes the registered JSON fixture, with one intra-operation and one inter-operation thread |
| Verify native tensor fixture freshness | `.venv/bin/python scripts/generate_tensor_oracle.py --check` | The same prepared native oracle; compares exact fixture bytes without rewriting or installing anything |
| Install the pinned Rust toolchain | `rustup toolchain install 1.98.1 --profile minimal --component rustfmt --component clippy --target wasm32-unknown-unknown` | Network access and authorized writes to the configured rustup directories; does not modify the repository |
| Install the pinned Rust build toolchain | `rustup toolchain install 1.98.1 --profile minimal --target wasm32-unknown-unknown` | Network access and authorized writes to the configured rustup directories; omits check-only components for isolated build-and-browser jobs |
| Select the pinned npm release | `npm install --global npm@11.1.0 --ignore-scripts --no-audit --no-fund` | Node.js 22.12.0, network access, and authorized writes to that Node.js installation plus npm's cache; does not modify the repository |
| Install locked JavaScript development dependencies | `npm ci --ignore-scripts --no-audit --no-fund` | Node.js 22.12.0 and npm 11.1.0; downloads TypeScript, Pyodide, Pyright and locked transitives, and recreates `node_modules/` from `package-lock.json` |
| Install the compatibility oracle | `.venv/bin/python -m pip install --only-binary=:all: --require-hashes -r requirements-oracle.lock` | Prepared CPython 3.11 environment on macOS 14+ arm64; downloads exact wheels and writes `.venv` plus pip cache; development only |
| Resolve an authorized oracle update | `.venv/bin/python -m pip install --dry-run --ignore-installed --only-binary=:all: --report /tmp/tabgrad-oracle-resolution.json -r requirements-oracle.in` | pip 23.2.1 in the prepared oracle environment; registry access, wheel downloads/cache and a disposable report; no installation |
| Generate the oracle lock from a reviewed pip report | `node scripts/write-oracle-lock.mjs /tmp/tabgrad-oracle-resolution.json` | Node.js 22.12.0; reads the report and direct requirements, rewrites only `requirements-oracle.lock`; no network |
| Build the browser distribution | `npm run build` | Prepared Node.js and Rust environments; rewrites ignored `dist/` and updates Cargo's ignored `target/` cache |
| Copy and hash maintained Python assets | `node scripts/build-python.mjs` | Prepared Node.js environment; writes `dist/python/`; included in `npm run build` |
| Check TypeScript and Rust | `npm run check` | Prepared Node.js and Rust environments; reads TypeScript source and runs Rustfmt plus Clippy for scalar and SIMD targets |
| Run JavaScript and browser tests | `npm test` | Prepared build environment, Chrome, Firefox, permission to launch headless processes, and a free loopback port; rebuilds `dist/`, uses disposable browser profiles, and runs one browser at a time |
| Build and run Node.js tests | `npm run test:node` | Prepared Node.js and Rust environments; rebuilds `dist/` and runs the JavaScript integration and raw-ABI suite without launching a browser |
| Run JavaScript integration tests only | `npm run test:unit` | An existing `dist/` build and permission to listen on a loopback port; does not rebuild source |
| Run real-browser integration tests only | `npm run test:browser` | An existing `dist/` build, Chrome, Firefox, and a loopback port; launches one headless browser at a time |
| Build and test one or both browsers from source | `npm run test:browser:from-source` | Prepared build environment, installed browsers, and a loopback port; rebuilds `dist/`, then honors `TABGRAD_BROWSER` or tests Chrome followed by Firefox when it is unset |
| Measure bounded runtime and artifact costs | `npm run measure` | Prepared build and browser environments; rebuilds `dist/` and writes an ignored report under `test-results/` |
| Compare Python and direct JavaScript boundary costs | `npm run measure:python` | Prepared build and browser environments plus an isolated baseline distribution; rebuilds current `dist/` and writes timestamped ignored reports under `test-results/`; workloads, baseline variables and limits are defined in [the command reference](reference/python-boundary-measurements.md) |
| Remove the browser distribution | `npm run clean` | Deletes only the ignored `dist/` directory |
| Update the JavaScript lock after an authorized dependency change | `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` | Node.js 22.12.0, npm 11.1.0, and registry access; rewrites only `package-lock.json` plus npm cache state |
| Update the Rust lock after an authorized dependency change | `cargo generate-lockfile` | Rust and Cargo 1.98.1 plus registry access if a dependency is introduced; rewrites `Cargo.lock` |
| Format maintained Rust files | `cargo fmt --all` | Rustfmt from toolchain 1.98.1; rewrites maintained Rust source |

Ruff reads `ruff.toml`. The formatter and linter cover the maintained Python
files under `scripts/`, `tests/` and `python/`. The formatting command is the only command
in this group that rewrites source; verification and continuous integration use
the read-only check commands. Ruff's annotation rules check function signature
coverage; they do not check that annotations agree with the implementation.

Pyright runs on Node.js and analyzes Python statically. It is installed through
the npm lockfile, not pip, and is not part of the browser distribution.
`pyrightconfig.json` selects strict checking for maintained Python under
`scripts/`, `tests/` and `python/`, including the private bridge declaration.
Repository tools and their tests target Python 3.11 in the prepared `.venv`;
the compatibility source targets Python 3.14, as embedded by the selected
Pyodide build (CPython 3.14.2). The latter is a static-analysis target, not a
requirement to install a second native interpreter. Browser integration tests
execute that source inside the real pinned Pyodide interpreter.

Pyright's bundled declarations cover the standard library and PyYAML. For
Pyodide, the check exposes the already-installed upstream typed modules from
`python_stdlib.zip` using `scripts/prepare_pyodide_types.py`. Only `pyodide/`
and `_pyodide/` are copied into the dependency's ignored `python-types/`
directory; the native tooling never imports those browser modules. This keeps
the checker aligned with the selected upstream version without maintaining a
second imitation of its API. `npm ci` recreates the dependency directory on a
version change. A missing archive fails the command, without downloading one.

The private `_tabgrad_runtime_bridge.pyi` instead describes a module that
Tabgrad itself registers from JavaScript. It is not an upstream replacement
or executable Python. Its `session` is opaque where installation only retains
its identity; code that calls bridge operations must describe and verify those
consumed contracts. The import has one scoped `reportMissingModuleSource`
exception because JavaScript provides the implementation, not a `.py` file.
No missing-import or unknown-type diagnostic is disabled globally. Real
installation tests establish that the registered module exists and retains
the correct session across close and reattachment.

Upstream typing changes are reviewed with their respective locked packages.
The command's small launcher first probes the prepared interpreter in isolated
mode and checks that it can import PyYAML, then prepares the local Pyodide type
sources before invoking Pyright. Pyright alone can report success even
when its configured virtual environment is absent; the launcher turns missing
or incompatible setup into a nonzero exit without falling back or installing.
For an editor, select this same project configuration and interpreter; an
editor-only result does not replace `npm run check:python` in CI.

The repository-consistency job runs Pyright beside Ruff and the tooling suite.
`npm run check` remains the TypeScript/Rust entry point; it does not replace
the Python checks. Embedded Python fixture strings are exercised by their
own tests rather than analyzed as independent source files. Maintained `.mjs`
scripts and embedded browser JavaScript are exercised by the corresponding
Node/browser suites, not by `tsconfig.json`. These are command-coverage facts,
not a claim that passing one language's checker validates another boundary.

TypeScript reads `tsconfig.json`. Cargo reads `Cargo.toml`, `Cargo.lock`, and
`rust-toolchain.toml`. `npm run check` does not rewrite maintained source;
developers may run `cargo fmt --all` explicitly when they intend to format Rust
source. `npm test` builds the exact ignored distribution once, runs the Node.js
suite, and then tests that same distribution in both real browsers. The two
from-source commands intentionally rebuild so isolated continuous-integration
jobs do not depend on an artifact produced elsewhere. No test installs or
updates a dependency.

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
