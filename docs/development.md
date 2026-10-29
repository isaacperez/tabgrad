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

Use the [browser diagnostics reference](reference/browser-diagnostics.md) to
interpret passive incoming traffic separately from associated requests, and
failure-time observations separately from final cleanup. Its bounded records
preserve missing, incomplete and unavailable evidence without changing token
authority, deadlines or failure outcomes. They do not establish a browser root
cause or make raw failure logs safe to publish.

Process termination and diagnostic capture have different lifetimes. The
harness sends `SIGTERM` to the process it launched and joins its exit, allowing
two seconds before escalating to `SIGKILL` and a further two seconds to confirm
exit. Sending a signal is not proof of termination. A failed join remains a
failure even if the page reported success or the local stderr channel closed.

After the join attempt, the harness closes its stderr receiving handle and
allows two seconds to confirm local handle closure. It retains at most 16,384
stderr characters. `standardErrorTruncated` records that the size limit omitted
text; `standardErrorClosedEarly` separately records that capture stopped before
natural end-of-file. Failed runs include both flags in their diagnostics. A
successful run whose capture ended without EOF prints an explicit `NOTE`, but
does not print raw stderr or run access data. Such a run establishes its page
result, process exit and local cleanup, not a complete auxiliary-service log.

This distinction matters because a browser can start an updater or another
auxiliary service that inherits stderr and outlives the disposable browser.
The harness does not wait for or kill those services, change browser update
settings, or infer full process-tree retirement from a stdio event. Browser
fixtures remain responsible for the application and backend cleanup promised
by their assertions before they report success; terminating a browser or
closing a diagnostic stream does not prove device drain.

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
| Prepare an inspected browser package candidate | `npm run package` | Clean identified source; prepared pinned Node/npm/TypeScript/Rust environment; rebuilds, stages selected files, writes an offline tarball and `candidate.json`; no install, lifecycle scripts, registry publication or account access |
| Qualify an external browser package | `npm run test:package:browser` | Prepared pinned Node/npm/TypeScript/Pyodide and Chrome/Firefox (or `TABGRAD_BROWSER`); paired `--tarball archive.tgz --expected candidate.json` consumes admitted retained bytes, or `--registry-plan private.json --expected candidate.json` qualifies explicitly authorized anonymous registry resolution/cached installation; both omit a build or checkout dist; no inputs requires clean identified source and full build setup to prepare a disposable candidate; scripts disabled, installed and relocated inventories verified, packaged README example and Python CPU/hosting rejection profiles executed; selected browser CI also runs the source route |
| Qualify managed GPU use of an external package | `npm run test:package:webgpu` | Same input choices, plus a real nonfallback WebGPU browser (Chrome by default); effective secure isolation, application-owned interpreter/physical workers, no JSPI; checks result/gradient, shared runtime identity, drain and cross-origin worker rejection; local hardware qualification, no interpreter download; registry input requires its separate read authority |
| Test the repository validator | `.venv/bin/python scripts/run_tests.py` | The prepared repository tooling environment |
| Select CI execution applicability | `node scripts/validation-scope.mjs` | Prepared Node.js and Git; reads `TABGRAD_VALIDATION_EVENT`, `TABGRAD_VALIDATION_BASE` and `TABGRAD_VALIDATION_HEAD`; compares the checked-out candidate for PRs, otherwise selects full coverage; prints categorical JSON and appends flags to `GITHUB_OUTPUT` only when set; no build or installation |
| Test CI applicability independently | `node --test --test-concurrency=2 js-tests/unit/tooling/validation-scope.test.mjs` | Prepared Node.js and Git; disposable local Git trees, no distribution or browser; always-on consistency evidence |
| Inspect release-record input | `node scripts/release-record.mjs inspect --input public-input.json` | Prepared Node; checks the exact canonical input and prints its identity, without authority or Git writes; see the [release record reference](reference/release-record.md) |
| Read or append an enrolled release record | `node scripts/release-record.mjs read --config private-config.json --expected-head KNOWN_HEAD` or the documented `enroll`/`append` forms | Prepared Node/Git; separately authorized private location, enrolled root/writer, exact head, inspected public input and retained originals; file transport or explicit HTTPS `GIT_ASKPASS` with optional `GITHUB_TOKEN`, no ambient credential selection; explicit ref writes and owned temporary cleanup; no npm/release client, signing, settings or publication admission |
| Test the local release-record protocol | `node --test --test-concurrency=2 js-tests/unit/tooling/release-record.test.mjs` | Prepared Node/Git; owned temporary local repositories, synthetic evidence and actual writes/failures, no service credentials or protection qualification; also discovered by the full Node suite |
| Test the experimental acquisition control record | `node --test --test-concurrency=2 js-tests/unit/tooling/provenance-acquisition-record.test.mjs js-tests/unit/tooling/provenance-acquisition-record-io.test.mjs` | Prepared Node; synthetic records and owned temporary files, closed format, effective file identity, positional short/failed transfers, independent logical reserves and bounded readback; no network, client, signing, physical allocation or laboratory qualification; see the [internal contract](reference/provenance-acquisition-record.md); also discovered by the full Node suite; `.mjs` contracts are documented and tested, not covered by the TypeScript `src/**/*.ts` check |
| Test local acquisition coordination and record integration | `node --test --test-concurrency=2 js-tests/unit/tooling/provenance-acquisition-control.test.mjs js-tests/unit/tooling/provenance-acquisition-control-session.test.mjs js-tests/unit/tooling/provenance-acquisition-record.test.mjs js-tests/unit/tooling/provenance-acquisition-record-io.test.mjs` | Prepared Node; separate logical actor states, synthetic clocks, actual owned temporary files, retained-opening header readback, action confirmation/revocation and failure-preserving collection; no processes, network, signing, physical clock/closure/durability or laboratory qualification; see the [internal contract](reference/provenance-acquisition-control.md); also discovered by the full Node suite; MJS is documented/tested, not statically checked by the TypeScript runtime compiler |
| Test experimental acquisition process coordination | `node --test --test-concurrency=2 js-tests/unit/tooling/provenance-acquisition-process.test.mjs js-tests/unit/tooling/provenance-acquisition-process-protocol.test.mjs js-tests/unit/tooling/provenance-acquisition-control.test.mjs js-tests/unit/tooling/provenance-acquisition-control-session.test.mjs js-tests/unit/tooling/provenance-acquisition-record.test.mjs js-tests/unit/tooling/provenance-acquisition-record-io.test.mjs` | Prepared Node, local process/IPC and owned-file permissions; finite synthetic actors, POSIX peer suspension/termination, bounded messages, role delivery, known prefixes and incomplete cleanup. No client, network service, credentials, native laboratory/resource/clock qualification, pilot or signing; see the [process contract](reference/provenance-acquisition-process.md). Also discovered by the full Node suite; MJS is documented/tested, not statically checked by the TypeScript runtime compiler |
| Verify retained producer proofs | `node scripts/package-provenance.mjs private-plan.json archive.tgz candidate.json static-dist archive-proof.json inventory-proof.json trusted-root.jsonl admitted-ci.json` | Prepared Node and separately prepared identified gh 2.102.0; explicit admitted plan, original bytes, offline roots and trusted CI corroboration; no credential/remote fallback, signing, consumer execution or release admission; see the [producer-proof reference](reference/package-provenance.md) |
| Test hosted producer composition locally | `node --test js-tests/unit/distribution/producer-trial.test.mjs` | Prepared Node/npm; synthetic packets, injected service responses and a controlled client adapter, no service access or signatures; also included in the full Node suite |
| Admit exact trial context before CI checkout | `test "$TABGRAD_TRIAL_ENABLED" = true && test "$TABGRAD_TRIAL_CONFIRMATION" = producer-trial && test "$GITHUB_EVENT_NAME" = workflow_dispatch && test "$GITHUB_REF" = refs/heads/main && test "$GITHUB_RUN_ATTEMPT" = 1 && test "$TABGRAD_TRIAL_SOURCE" = "$GITHUB_SHA"` | Separately authorized hosted trial; exact shell admission before executing checkout source; not an authorization or effective-protection proof |
| Prepare and qualify one hosted candidate | `node scripts/producer-trial.mjs prepare "$RUNNER_TEMP/tabgrad-producer-data"` | Separately authorized trial, exact admitted context, clean source and prepared build/browser dependencies; produces once and qualifies retained bytes; no signature or publication |
| Summarize the frozen handoff | `node scripts/producer-trial.mjs announce "$RUNNER_TEMP/tabgrad-producer-data"` | Same context, explicit read-only `GH_TOKEN` and this run's artifact ID/digest; checks actual metadata and appends hashes to the job summary for separate approval |
| Admit exact signing subjects | `node scripts/producer-trial.mjs subjects "$RUNNER_TEMP/tabgrad-producer-data"` | Same admitted context and explicit read token/metadata, retained candidate and qualification; emits subjects through `GITHUB_OUTPUT`, never signs |
| Recheck current trial authority | `node scripts/producer-trial.mjs admit` | Exact admitted context with unexpired deadline; no service request or mutation |
| Conserve original proof bytes | `node scripts/producer-trial.mjs retain "$ARCHIVE_PROOF" "$INVENTORY_PROOF" "$RUNNER_TEMP/tabgrad-producer-proofs"` | Existing action output paths, exact context and fresh owned output; preserves partial progress even after deadline, rejects missing/failed completeness; no signature retry |
| Prepare the optional fixed Linux verification client | `.venv/bin/python scripts/prepare_provenance_client.py "$RUNNER_TEMP/tabgrad-producer-client"` | Separate setup authority, prepared Python tooling, Linux x86-64 and new output; downloads only the fixed official gh archive, verifies exact compressed size/SHA-256 before selecting one regular executable; no global installation or authentication |
| Prepare the separate optional publishing clients | `.venv/bin/python scripts/prepare_publication_client.py NEW_OUTPUT_DIRECTORY` | Explicit isolated setup in the prepared Python environment on macOS arm64 or Linux x86-64; selects Node22.23.3 and npm12.2.0 from their fixed official archives with pinned integrity, copies into a new owned directory and records its complete client identity. No global tool change, authentication, package execution or publication; preparation does not qualify the client or enroll trust |
| Corroborate and verify the hosted trial | `node scripts/producer-trial.mjs verify "$RUNNER_TEMP/tabgrad-producer-data" "$RUNNER_TEMP/tabgrad-producer-proofs" "$RUNNER_TEMP/tabgrad-producer-client" "$RUNNER_TEMP/tabgrad-producer-verification"` | Authorized trial, exact expected source/run/artifact identities, explicit read-only `GH_TOKEN`, prepared identified client and independently admitted root hash; observes GitHub, acquires matching root bytes, then verifies original bundles offline; retains diagnostic originals, no signing or release admission; see the [trial reference](reference/producer-trial.md) |
| Test experimental acquisition Exec, capture, host/startup and preserved contracts | `node --test --test-concurrency=2 js-tests/unit/tooling/provenance-acquisition*.test.mjs` | Prepared Node, local Unix socket/process/IPC and owned-file permissions; finite wire peers and binary streams/files, synthetic native syscall/clock ports, exact profile files and finite actors. Covers [Exec HTTP/capture composition](reference/provenance-acquisition-exec.md), [payload prefixes](reference/provenance-acquisition-capture.md) and [three-control startup/guard cleanup](reference/provenance-acquisition-startup.md). No actual Docker daemon/client, trust acquisition, `/sys`/`/proc` host probe, native group operation, setup, pilot, signing, custody or physical qualification. Includes existing acquisition tests and is discovered by the full Node suite; MJS is documented/tested, outside the runtime TypeScript check |
| Test the experimental program launch profile, control and lifecycle | `node --test --test-concurrency=2 js-tests/unit/tooling/provenance-acquisition-launch-profile.test.mjs js-tests/unit/tooling/provenance-acquisition-launch-protocol.test.mjs js-tests/unit/tooling/provenance-acquisition-launch-lifecycle.test.mjs` | Prepared Node, ordinary owned temporary files and finite local child; literal codecs, quota counters, synthetic FIFO metadata/clock ports, explicit stdio, failure and late-effect cleanup under the [launcher contract](reference/provenance-acquisition-launch.md). No actual FIFO, Docker, host probe, trust acquisition, setup, pilot or signing; full Node/acquisition globs include these MJS tests, outside runtime TypeScript checking |
| Test experimental raw payload writing and Docker framing preservation | `node --test --test-concurrency=2 js-tests/unit/tooling/provenance-acquisition-payload.test.mjs js-tests/unit/tooling/provenance-acquisition-capture.test.mjs` | Prepared Node and ordinary owned files; literal binary inputs, independent channel progress, finite clock/transfer failures, confirmed prefixes and cleanup under the [raw-writer contract](reference/provenance-acquisition-payload.md). No actual FIFO, Docker, trust acquisition, setup, pilot or signing; included by full Node/acquisition discovery; MJS is documented/tested, outside runtime TypeScript checking |
| Test experimental acquisition FIFO transport | `node --test js-tests/unit/tooling/provenance-acquisition-fifo.test.mjs` | Prepared Node and ordinary owned temporary files; synthetic FIFO metadata, finite clocks/native effects and borrowed sinks under the [transport contract](reference/provenance-acquisition-fifo.md). No actual FIFO, Docker/client, host laboratory, setup, trust acquisition, pilot or signing; included by full Node/acquisition discovery; MJS is documented/tested, outside runtime TypeScript checking |
| Test experimental laboratory preparation and diagnostics | `node --test --test-concurrency=2 js-tests/unit/tooling/provenance-acquisition-lab*.test.mjs` and `.venv/bin/python -m unittest tests.test_provenance_containerd_config tests.test_provenance_case_fifo` | Prepared Node and repository Python3.11; ordinary owned files/finite Node children, synthetic manager/journal/kernel/daemon/container ports, mocked FIFO descriptors and real stdlib TOML parsing under the [laboratory](reference/provenance-acquisition-lab.md) and [case](reference/provenance-acquisition-lab-cases.md) contracts. No native host probe, systemd/journalctl/Docker service, FIFO/container, pilot, signing or publication. Discovered by Node/Python suites; MJS is dynamically tested, Python is also covered by Ruff/Pyright |
| Observe experimental laboratory inputs (separate authorization required) | `node scripts/provenance-acquisition-lab-input-entry.mjs observe PLAN_FILE EXPECTED_PLAN_SHA256` | Reads presented prepared roots/proc/tool metadata and publishes an identified candidate to existing protected ordinary files. Does not execute tools or create directories/services/groups. Tool hashes and host/clock admission stay pending under the [input-stage contract](reference/provenance-acquisition-lab.md#observing-inputs-without-invented-identities); never run as a routine test |
| Run experimental native laboratory preparation (separate authorization required) | `node scripts/provenance-acquisition-lab-entry.mjs prepare PROFILE_FILE EXPECTED_SHA256`, or `node scripts/provenance-acquisition-lab-input-entry.mjs prepare PLAN_FILE EXPECTED_PLAN_SHA256` to observe inputs first | Independently admitted Linux x86-64, complete cgroup2/procfs/clock views, systemd255, prepared identified tools/venv and bounded private storage. Creates a transient delegated service, private Docker29.9.1/managed containerd and owned groups/files, then requests exact exterior retirement and retains local originals under the [laboratory contract](reference/provenance-acquisition-lab.md). Observation and preparation share the first T0. Prepare-only performs no container/image/FIFO work; an explicit diagnostic reference selects one case before complete retirement. No installation, signing, upload, cleanup of borrowed storage or host teardown. Explicit invocation is not operational authority or qualification; never run as a routine test |
| Run the three-laboratory diagnostic experiment (separate authorization required) | `node scripts/provenance-acquisition-lab-experiment-entry.mjs PLAN_FILE EXPECTED_PLAN_SHA256` | Same independently admitted Linux/tool/image/storage/clock prerequisites as the laboratory; the closed [diagnostic contract](reference/provenance-acquisition-lab-cases.md#three-independent-laboratories) selects A/B/C in fresh private laboratories, each fully retired before another starts, under one total cutoff. Creates image/container/FIFO/capture resources only during that explicit native run. Retains one private report at an observed evidence anchor and emits a closed summary without paths or payloads. No installation, network acquisition, signing, workflow activation, upload or publication; never run as a routine test |
| Run the explicit experimental self-entering guard (separate authorization required) | `node scripts/provenance-acquisition-startup-guard.mjs PROFILE_FILE EXPECTED_SHA256` | Prepared admitted Linux/Node/clock and independently identified prepared file, delegation, group identities, permissions and initial bootstrap placement under the [startup contract](reference/provenance-acquisition-startup.md). Writes `0` once to its own role's `cgroup.procs`, verifies membership and can write case freeze/kill; creates/configures no groups. Emits closed correlated IPC observations when connected. Parent loss does not cancel the guard's original horizon; native close may remain pending. This is not a routine check, pilot authority, physical guarantee or complete acquisition/release entry |
| Run the experimental native host guard (separate authorization required) | `node scripts/provenance-acquisition-host-guard.mjs PROFILE_FILE EXPECTED_SHA256` | Prepared Node on Linux, independently admitted clock/origin and exact profile digest, externally prepared cgroup v2 hierarchy/identities/permissions and guard placement under the [host contract](reference/provenance-acquisition-host.md). Reads the owned profile and native group files; can write freeze/kill to the declared case group. Emits bounded armed/boundary IPC observations when connected; native I/O closure may remain pending. The trusted launcher owns placement, external deadline/termination, output custody and cleanup; this command creates no groups and removes no files. Not a routine check or pilot authorization; synthetic tests do not qualify it for native use |
| Qualify the actual provenance client offline | `node scripts/qualify-provenance-client.mjs /absolute/path/to/gh ADMITTED_BINARY_SHA256 prepared-fixture-directory` | Prepared identified gh 2.102.0 and the exact externally prepared public fixtures in the reference; no install/download/authentication; specialized client evidence, separate from default synthetic policy/adapter tests and live generator qualification |
| Record runtime CI applicability | `node scripts/validation-scope.mjs --report runtime` | Prepared Node.js; requires a validated `true` or `false` in `TABGRAD_VALIDATION_RUNTIME`; reports required/not-applicable, not test success |
| Record browser CI applicability | `node scripts/validation-scope.mjs --report browser` | Prepared Node.js; requires a validated `true` or `false` in `TABGRAD_VALIDATION_BROWSER`; reports required/not-applicable, not test success |
| Generate bounded native tensor expectations | `.venv/bin/python scripts/generate_tensor_oracle.py` | Authorized, prepared PyTorch oracle; writes the registered JSON fixture, with one intra-operation and one inter-operation thread |
| Verify native tensor fixture freshness | `.venv/bin/python scripts/generate_tensor_oracle.py --check` | The same prepared native oracle; compares exact fixture bytes without rewriting or installing anything |
| Measure fixed-owner CPU SGD | `node scripts/measure-sgd.mjs` after `npm run build` | Prepared Node/Pyodide; sequential scalar/SIMD and managed Python windows at lengths 32/4096/65536 and steps 16/64/128; ignored `test-results/sgd-resources.json`, separate logical/Wasm/host measurements |
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
| Qualify direct JavaScript WebGPU execution | `npm run test:webgpu` | An existing `dist/` build, installed Chrome with an available WebGPU adapter, process-launch permission and a loopback port; `TABGRAD_BROWSER` can select another installed browser; unavailable GPU is a failure, not a silent skip |
| Build and qualify WebGPU from source | `npm run test:webgpu:from-source` | Prepared build environment plus the WebGPU qualification requirements above; rebuilds `dist/` before testing |
| Qualify managed Python WebGPU | `npm run test:python:webgpu` | Matching `dist/` and pinned Pyodide assets, an installed real-WebGPU browser, process and loopback permissions; isolated hosting and sequential profiles cover ordinary observation without JSPI, numerical transport, attachment and revocation |
| Build and qualify managed Python WebGPU from source | `npm run test:python:webgpu:from-source` | Prepared build environment plus managed GPU qualification requirements; rebuilds all matching artifacts before testing |
| Build and test one or both browsers from source | `npm run test:browser:from-source` | Prepared build environment, installed browsers, and a loopback port; rebuilds `dist/`, then honors `TABGRAD_BROWSER` or tests Chrome followed by Firefox when it is unset |
| Measure bounded runtime and artifact costs | `npm run measure` | Prepared build and browser environments; rebuilds `dist/` and writes an ignored report under `test-results/` |
| Calibrate or measure GPU resource growth | `npm run measure:webgpu -- pilot` or `npm run measure:webgpu -- measure` | A freshly built `dist/`, real WebGPU browser and loopback permission; the [measurement reference](reference/webgpu-measurements.md) defines adequacy, raw reports and resource caps |
| Calibrate or compare managed Python and direct GPU boundaries | `npm run measure:python:webgpu -- pilot`, `measure` or `diagnose` | Fresh matching distribution and local Pyodide, one real-WebGPU browser and isolated loopback hosting; the [specific measurement reference](reference/python-webgpu-measurements.md) separates the adequacy gate, uninstrumented matrix and inclusive diagnostic, with counters and safety caps |
| Compare Python and direct JavaScript boundary costs | `npm run measure:python` | Prepared build and browser environments plus an isolated baseline distribution; rebuilds current `dist/` and writes timestamped ignored reports under `test-results/`; workloads, baseline variables and limits are defined in [the command reference](reference/python-boundary-measurements.md) |
| Remove the browser distribution | `npm run clean` | Deletes only the ignored `dist/` directory |
| Update the JavaScript lock after an authorized dependency change | `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` | Node.js 22.12.0, npm 11.1.0, and registry access; rewrites only `package-lock.json` plus npm cache state |
| Update the Rust lock after an authorized dependency change | `cargo generate-lockfile` | Rust and Cargo 1.98.1 plus registry access if a dependency is introduced; rewrites `Cargo.lock` |
| Format maintained Rust files | `cargo fmt --all` | Rustfmt from toolchain 1.98.1; rewrites maintained Rust source |
| Prepare the publication proof verifier | `.venv/bin/python scripts/prepare_provenance_client.py "$RUNNER_TEMP/tabgrad-provenance-client"` | Explicit isolated setup; same hash-pinned optional gh client as the producer, outside build/consumer inputs. |
| Prepare isolated publication tools or genuine fixtures | `.venv/bin/python scripts/prepare_publication_client.py "$RUNNER_TEMP/tabgrad-publication-client"` | Separate setup authority; exact hash-pinned official originals and owned new directory; no execution, account or publication. Fixtures use public reads only. |
| Prepare isolated publication tools or genuine fixtures | `.venv/bin/python scripts/prepare_publication_client.py --fixtures "$RUNNER_TEMP/tabgrad-publication-fixtures"` | Separate setup authority; exact hash-pinned official originals and owned new directory; no execution, account or publication. Fixtures use public reads only. |
| Qualify actual publication clients | `node scripts/qualify-publication-client.mjs "$RUNNER_TEMP/tabgrad-publication-client" "$TABGRAD_CLIENT_SHA256" "$RUNNER_TEMP/tabgrad-publication-fixtures"` | Identified prepared client and genuine pinned public originals; local disposable endpoints and fake credentials, plus explicit public TUF reads. No real provider identity, npm publication or signatures. |
| Run the separately admitted publication role | `node scripts/release-publication.mjs admit "$RUNNER_TEMP/tabgrad-publication"` | Reviewed source, explicit closed plan and enrolled private policy; protected approval and current API observations; permissions separated by role. No ordinary test or implicit publication authority; see [the procedure](reference/release-publication.md). |
| Run the separately admitted publication role | `node scripts/release-publication.mjs bootstrap "$RUNNER_TEMP/tabgrad-publication"` | Reviewed source, explicit closed plan and enrolled private policy; protected approval and current API observations; permissions separated by role. No ordinary test or implicit publication authority; see [the procedure](reference/release-publication.md). |
| Run the separately admitted publication role | `node scripts/release-publication.mjs complete "$RUNNER_TEMP/tabgrad-publication"` | Reviewed source, explicit closed plan and enrolled private policy; protected approval and current API observations; permissions separated by role. No ordinary test or implicit publication authority; see [the procedure](reference/release-publication.md). |
| Run the separately admitted publication role | `node scripts/release-publication.mjs consume "$RUNNER_TEMP/tabgrad-publication"` | Reviewed source, explicit closed plan and enrolled private policy; protected approval and current API observations; permissions separated by role. No ordinary test or implicit publication authority; see [the procedure](reference/release-publication.md). |
| Run the separately admitted publication role | `node scripts/release-publication.mjs npm "$RUNNER_TEMP/tabgrad-publication"` | Reviewed source, explicit closed plan and enrolled private policy; protected approval and current API observations; permissions separated by role. No ordinary test or implicit publication authority; see [the procedure](reference/release-publication.md). |
| Run the separately admitted publication role | `node scripts/release-publication.mjs observe "$RUNNER_TEMP/tabgrad-publication"` | Reviewed source, explicit closed plan and enrolled private policy; protected approval and current API observations; permissions separated by role. No ordinary test or implicit publication authority; see [the procedure](reference/release-publication.md). |
| Run the separately admitted publication role | `node scripts/release-publication.mjs precheck "$RUNNER_TEMP/tabgrad-publication"` | Reviewed source, explicit closed plan and enrolled private policy; protected approval and current API observations; permissions separated by role. No ordinary test or implicit publication authority; see [the procedure](reference/release-publication.md). |

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
suite, and then tests that same distribution in both real browsers. The
from-source commands intentionally rebuild so isolated continuous-integration
jobs do not depend on an artifact produced elsewhere. No test installs or
updates a dependency.

`test:webgpu` is an additional real-device qualification command, not an
implicit part of the CPU/Pyodide browser matrix. That matrix does not guarantee
a usable hardware adapter. GPU changes need an explicit successful WebGPU
run with its browser, operating system, adapter, features, limits and fallback
status recorded. Node lifecycle doubles exercise controlled failures but do
not replace this physical qualification.

`test:python:webgpu` separately qualifies the interpreter-worker connection.
It uses the same installed real-WebGPU browser selection as `test:webgpu`,
serves locked local Pyodide under effective cross-origin isolation, and removes
JSPI capabilities before loading it. Profiles run one at a time: ordinary
Python output and the numerical corpus, revocation while a real producer
acknowledgement is held by a test-only gate, and rejected attachment placement
or retired connections. Additional profiles cover deliberate device destruction,
worker failure and host-reported interpreter termination. The gate follows
actual queue completion and delays acknowledgement, not real GPU arithmetic.
The tests distinguish wakeup, joined cleanup and unknown physical completion.
Small correctness cases and the bounded 65,536-element
repetition check establish contracts, not quantitative speed, heap or VRAM
growth. No interpreter, package or browser is downloaded by this command.

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

`npm run package` defaults to ignored `build/browser-package/`. Supply another
new output directory with `npm run package -- path/to/new-output`. Preparation
never overwrites existing output. It rebuilds from the clean current commit,
preserves the source name/version/private flag, and writes the matched static
tree at `package/dist/`, one npm tarball and a SHA-256 file/archive inventory at
`candidate.json`. It removes its owned partial output on failure. Remove only
that candidate directory when finished. Use the
[package reference](reference/browser-package.md) for artifact installation;
choosing a public release version, publisher and destination remains governed
by [releases](releases.md), separately from candidate preparation.

Candidate browser checks use disposable directories outside the checkout.
Supply paired `--tarball` and `--expected` options to check an admitted retained
archive without rebuilding or repacking it; omit both for clean-source
preparation. Alternatively supply `--registry-plan` and `--expected` for explicitly
authorized anonymous registry reads and named installation from checked cached
bytes. Operational access is separate from local fixture controls. The
[qualification reference](reference/package-qualification.md) owns the input schema, admitted archive format, profiles and report fields.
They copy only their registered application fixtures and locally prepared
Pyodide files, consume the actual installed tarball, and serve every application
module from that external tree. The existing browser harness still owns process,
profile, loopback-server and diagnostic cleanup. Successful GPU output records
the actual adapter/features/limits and requires joined normal drain; it is not
a timing, memory-growth, model-scale or broader hardware claim. These commands
remove their disposable application/candidate directories even after failure.
The Node driver emits one JSON report that distinguishes requested coverage
from validated observations and preserves bounded failures without private
input paths. A source label or matching sidecar does not authenticate a
producer or authorize executing its code; admission remains with the
[release policy](releases.md).

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
