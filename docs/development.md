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

Ruff reads `ruff.toml`. The formatter and linter cover the maintained Python
files under `scripts/` and `tests/`. The formatting command is the only command
in this group that rewrites source; verification and continuous integration use
the two read-only check commands.

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
