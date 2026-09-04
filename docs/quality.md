# Code quality, tests, and repository checks

This document defines the engineering standard for all maintained Tabgrad code
and how the project selects, runs, and interprets tests and other repository
checks. It applies regardless of whether a person or coding agent writes the
code. Generated output is assessed through its registered source, generator,
and reproduction procedure rather than treated as an independently maintained
implementation. Code is acceptable only when another contributor can
understand its responsibilities, verify its behavior, and change it without
depending on hidden assumptions. A passing command is useful evidence only
when it examines the relevant final state and can detect the failure it is
intended to prevent.

## Quality is part of the change

A change includes the implementation, tests, documentation, compatibility
record, configuration, and generated results needed to leave the repository
consistent. A contributor must not postpone one of these parts merely because
the source code is already working locally.

Use the commands registered in [`development.md`](development.md). Tool
configuration and continuous integration determine the exact commands. This
document determines which kinds of evidence are needed and how their results
are interpreted.

## Use established language conventions

Source, tests, examples, and build code must pass the formatter, linter, type
checker, compiler, and other applicable tools configured by the repository.
Do not suppress a valid diagnostic, weaken a rule, or add an exclusion merely
to make a change pass. When an exception is necessary, keep it as narrow as
the tool permits and explain the technical reason where a maintainer will find
it.

Python code uses [PEP 8](https://peps.python.org/pep-0008/) as its baseline for
ordinary style and naming and [PEP 257](https://peps.python.org/pep-0257/) as
its baseline for public docstrings. Repository configuration and documented
Tabgrad conventions are the exact mechanical authority and may define a
deliberate local exception. A PyTorch-compatible public name or signature
follows the compatibility contract even when it differs from ordinary
internal Python style. JavaScript and TypeScript use `camelCase` for variables
and functions, `PascalCase` for classes and types, and the module and formatting
conventions encoded by the repository configuration. Public compatibility
interfaces keep the names required by their documented contract. WGSL and
configuration code use the terminology and conventions of their language and
the surrounding Tabgrad module.

Use English for identifiers, comments, docstrings, error messages, and public
technical documentation. Choose names that state the domain meaning rather
than the implementation mechanism. Avoid unexplained abbreviations, generic
containers such as `utils` or `manager`, and names whose meaning depends on a
conversation outside the repository.

Comments explain a reason, invariant, constraint, ownership rule, numerical
derivation, or non-obvious consequence that the code cannot express. They must
not paraphrase the next statement. Public modules, types, functions, and
methods document their purpose, inputs, result, observable side effects,
errors, and restrictions when those facts are part of their contract. Change
or remove documentation when the corresponding behavior changes.

## Resolve the design before writing code

Before implementing non-trivial behavior, state the observed problem, the
relevant assumptions, the invariant the result must preserve, realistic
interpretations, and the evidence that will demonstrate success. Inspect the
existing producers, consumers, tests, interfaces, and shared abstractions that
can answer those questions. Do not substitute a guess for information that is
available from the repository or an authoritative source.

Present materially different interpretations or designs and their tradeoffs
before choosing among them. Identify the simplest approach that is
structurally correct and say when a requested approach adds complexity without
a demonstrated benefit. Obtain a user decision before code when the choice
would change accepted scope, public behavior, compatibility, architecture,
security, privacy, a material performance tradeoff, or an important
dependency. A decision already established by an approved issue or
architecture record does not need to be requested again.

Walk the proposed design through the successful, boundary, empty, malformed,
and failure cases that the affected domain makes relevant. Include interactions
with callers and downstream consumers when the change can alter them. This is
a bounded analysis of plausible cases, not a demand to imagine every possible
input or inspect the whole repository.

## Give each unit one clear responsibility

A module owns one cohesive area of behavior. A function or method performs one
operation at one level of abstraction. Its inputs, result, side effects, and
failure behavior must be visible from its interface or contract. Separate
parsing, validation, policy, storage, execution, and presentation when they
change for different reasons; do not split them mechanically when doing so
would only scatter one indivisible operation.

Do not use line count as a design rule. A unit is too large when a precise name
cannot describe its responsibility, its branches represent unrelated policy,
its state cannot be reasoned about locally, or meaningful behavior cannot be
tested without exercising unrelated work.

Do not declare a helper with an independent domain responsibility, reusable
rule, failure policy, or testing purpose inside another function or method.
Put that helper at module scope or on the type that owns it. A callback or
closure may remain local when an API requires a callable, its behavior belongs
only to that call, and keeping it beside the call makes data and control flow
clearer. Locality does not justify hiding reusable policy, several processing
stages, complex branching or error handling, or behavior that needs
independent tests; extract those responsibilities. A closure requires an
architectural decision only when its captured ownership or lifetime changes a
lasting architectural boundary, not merely because it captures local state.

Keep state ownership and mutation explicit. Do not hide a device transfer,
fallback, cache mutation, global dependency, synchronization point, or other
observable work behind an interface whose name and contract imply a simple
local operation.

## Build abstractions from real invariants

An abstraction is justified when it gives one owner to a real invariant,
contract, lifecycle, or axis of variation. When several operations share the
same behavior and differ only in defined parameters or strategies, encode the
shared rule once and make the differences explicit. Do not copy a complete
implementation for each variation when those copies must remain aligned.

Before adding an abstraction, identify what knowledge it centralizes, which
callers need it, how the variations differ, and how its contract can be
tested. Prefer an established language or project mechanism over a custom
framework. The abstraction must make control flow, data movement, errors, and
performance costs at least as understandable as the code it replaces.

Similar syntax is not sufficient evidence of shared behavior. Separate code
may be correct when responsibilities, lifecycles, compatibility requirements,
or rates of change differ. Conversely, duplicated knowledge can exist inside
one function when the same rule appears in several branches. Do not introduce
a generic interface, optional flags, plugin mechanism, or configuration point
for a hypothetical variation. Single-use code does not justify an abstraction
merely because reuse might occur; it may still deserve a named unit when that
unit isolates a real responsibility or invariant.

Do not optimize for the fewest textual lines. Remove unnecessary code, but do
not compress distinct decisions into an opaque expression or an interface that
hides their costs. A short implementation that multiplies special cases is
worse than a clear shared rule with explicit variations.

## Correct causes instead of symptoms

A bug fix begins by reproducing the symptom when practical and stating the
violated invariant. Trace the value or state through the layer that fails, its
producer, and the preceding boundaries. Correct the highest layer that can own
the invariant and prevent the invalid state. Change the failing layer only
when no earlier owner can express the rule correctly.

Do not accept a condition keyed only to the observed example, a silent
fallback, a swallowed error, a duplicated special-case branch, or an optional
flag added for one caller as a complete solution. A regression test must cover
the class of behavior defined by the invariant, including a nearby case that
would expose an example-specific correction when that distinction is
meaningful.

A numerical threshold must come from a documented semantic, physical,
compatibility, or format boundary. A value chosen because it separates the
examples at hand is not a valid discriminator. When no reliable signal exists,
report the gap and define the investigation needed to find one instead of
embedding a convenient constant.

Permanent code must not contain a knowingly temporary workaround that hides a
known cause. An urgent mitigation is separate, explicitly authorized work. It
must preserve the original failure evidence, state what risk it reduces, name
its removal condition, and leave the underlying defect open; it must not be
presented as the completed correction.

When the cause belongs to an external system, preserve and expose the external
failure faithfully unless Tabgrad's documented boundary owns validation,
translation, or recovery. Do not fabricate valid-looking data or success to
keep a pipeline moving.

## Preserve scope and remove consequences

Every changed line must contribute to the issue's expected result, its tests,
documentation, or the minimum refactor needed to implement it safely. Match
the established style outside the affected code and keep unrelated cleanup,
renaming, reformatting, optimization, and refactoring out of the change.

Remove imports, exports, helpers, constants, branches, types, tests, comments,
documentation, and configuration that the change itself makes obsolete. Do
not remove pre-existing material merely because it appears unused; first
establish its callers, generated relationships, public exposure, and
compatibility purpose.

Code, comments, and normative documentation describe the resulting design and
behavior. They do not narrate what an earlier implementation did or leave a
`TODO` in place of work required by the issue. Historical information belongs
in the issue, pull request, changelog, release record, or accepted decision
whose purpose is to preserve that history.

## Design for performance and require evidence

Performance is part of design when the affected path controls execution,
scheduling, kernels, storage, memory, transfers, graph processing, package
loading, or another material resource. Keep data movement, allocation,
conversion, synchronization, repeated computation, retained state, and
dispatch overhead visible when choosing an abstraction. Avoid work whose
result is not needed, but do not sacrifice correctness or clarity for a
hypothetical speedup.

A change that claims a performance improvement or can materially affect a hot
path must use comparable measurements under [`performance.md`](performance.md).
A change with no plausible performance effect records why measurement does
not apply. Passing functional tests does not prove a performance claim, and a
microbenchmark does not justify a broader conclusion than its workload.

An abstraction used on a hot path must make its cost inspectable and must not
silently add device transfers, materialization, repeated dispatch, allocation,
or synchronization. Prefer the clearest design until measurement identifies a
material cost. When evidence supports a more complex implementation, preserve
the simpler behavior in correctness tests and document the measured tradeoff.

## Select checks from the affected risks

Begin with the files and observable behavior changed. Map every issue
completion condition and every material risk to one or more checks. Run both
focused checks that diagnose the changed behavior and the broader configured
checks that detect regressions elsewhere.

The following categories apply when the change can affect them:

| Change | Required evidence |
| --- | --- |
| Observable behavior | A test that fails for the missing or incorrect behavior, important failure cases, and the relevant wider suite. |
| Bug fix | A reproduction and a regression test that would fail before the correction. |
| Public API or compatibility | Reference behavior, supported signatures and errors, compatibility tests, and an updated compatibility record. |
| CPU or WebGPU execution | Backend-specific tests and cross-backend comparison where both backends claim support. |
| Python, JavaScript, Pyodide, or browser integration | Tests at every changed boundary and a representative supported browser environment. |
| Documentation or examples | Link checks, inspection against authoritative behavior, and execution of examples when they contain runnable behavior. |
| Build or developer tooling | A clean setup or build path and checks for the configuration or command that changed. |
| Dependency or third-party code | Installation and build evidence, license and origin review, security assessment, and artifact-size effects when material. |
| Generated file | Reproduction from its declared source and a clean diff after regeneration. |
| Performance-sensitive behavior | Comparable measurements following [`performance.md`](performance.md). |
| Release or migration behavior | Package, installation, upgrade, rollback, and release-note checks that apply to the affected artifact. |

This table is not a demand to run every category for every change. A category
that does not apply needs a reason derived from the diff and issue, not an
unexplained statement.

## Write meaningful tests

Test observable results rather than the implementation's private sequence of
calls. A useful test should fail when the promised behavior is absent or
incorrect and should produce a failure message that helps locate the problem.

Cover representative successful behavior, important boundaries, and failure
behavior. For tensor operations, relevant dimensions can include values,
shapes, data types, broadcasting, devices, gradients, repeated differentiation,
errors, non-contiguous views, empty inputs, and backend agreement. Apply only
the dimensions the operation can affect.

Keep tests deterministic under their documented conditions. Control random
seeds when randomness is not the subject of the test. Do not conceal
nondeterminism with broad tolerances or retries. A justified platform or
capability skip must state the condition it detects; an unexpected skip or
zero discovered tests is not a pass.

Mocks may isolate an external boundary, but they cannot replace a test of the
real integration whose behavior the project claims. Snapshots may make large
structured output reviewable, but they must not replace assertions for
important semantics.

## Compare with a valid reference

Use the CPU backend as the internal reference for WebGPU only for behavior the
CPU implementation has itself established correctly. Use the official
PyTorch runtime as a development oracle for a documented compatibility claim,
not as a runtime dependency and not as proof that Tabgrad chose the correct
scope.

Record the reference version, inputs, environment, tolerances, and known
differences. When a test derives expected output by repeating the same logic as
the implementation, it is not an independent reference.

## Preserve valid checks

Do not delete, weaken, skip, quarantine, widen a tolerance, suppress a warning,
or add an exclusion solely to make a change pass. A legitimate change to a
check must explain which earlier assumption became invalid and provide equally
strong or stronger protection for the behavior that remains supported.

Treat formatter, linter, type checker, compiler, test runner, link checker,
generated-file checker, package build, and security scanner failures as real
findings. Determine whether a failure was caused by the change, existed at the
base revision, or came from the environment. A pre-existing or environmental
failure does not become a pass.

## Review code quality without speculative redesign

Review every changed line of maintained code and enough surrounding code to
understand its contract and consequences. Confirm that the change follows the
sections above rather than judging quality from formatting or test results
alone. In particular, look for:

- an assumption that evidence or an accepted decision does not support;
- a solution that reacts to one example instead of enforcing the real
  invariant at its owner;
- variations implemented as copies or accumulating branches when one shared
  rule would be clearer;
- an abstraction that hides behavior, couples unrelated responsibilities, or
  prepares for hypothetical needs;
- an independently responsible helper nested inside another function or a
  callback or closure whose complexity no longer belongs at its call site;
- dead code, stale documentation, or unused elements created by the change;
- control flow, state ownership, failure behavior, names, comments, or public
  contracts that a new contributor cannot understand locally; and
- an avoidable cost on an affected hot path or a performance assertion that
  lacks comparable evidence.

Include a refactor in an implementation only when it is needed to complete the
issue safely, remains focused, and preserved behavior is covered by tests. A
broader refactor, cleanup, or technical-debt correction needs independently
verifiable tracked work. Use `tabgrad-maintenance` to establish evidence before
creating such work.

A quality problem introduced or materially worsened by the change is a
required correction. A pre-existing concern that does not block or undermine
the result remains separate work. Do not block work for a personal style
preference, an unrelated cleanup, or an optimization that neither measurement
nor a known hot-path cost supports.

## Run checks against one exact state

Record the base, target commit or complete working-tree identity, command,
working directory, relevant environment, and result. Do not combine a test
from one state with documentation or source from another and call the combined
result verified.

Do not run stateful checks concurrently when they share output directories,
caches, ports, browsers, devices, or external services. Inspect the working
tree after commands that can generate files. Any edit that can affect earlier
evidence makes that evidence stale.

## Interpret results honestly

Use these outcomes:

- A check passes when it completes successfully, examines the intended state,
  discovers the expected work, and has no unexplained warning, skip, retry, or
  leaked output.
- A check fails when it demonstrates an incorrect result.
- A check is incomplete when its command, environment, input, expected
  artifact, or reliable result is unavailable.

Record every failed attempt even when a retry passes. Investigate variability
instead of calling it success. Do not substitute a convenient manual check for
a missing configured check. A carefully described manual inspection can be
evidence for what it actually observes, while the automation gap remains
visible.

`tabgrad-verify` combines the applicable evidence into the final verification
result. Independent review remains a separate judgment about correctness,
scope, consequences, and maintainability.
