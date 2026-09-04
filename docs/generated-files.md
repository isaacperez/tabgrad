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

## Verify generated output

Run the registered generator in a controlled environment and compare the
complete result with the committed output. An unexpected diff fails the check.
Do not make CI regenerate and silently accept the changed result.

When generated output is binary, preserve a reproducible checksum and a way to
inspect its meaningful source-level content. Treat generation tools and
downloaded inputs as dependencies under [`dependencies.md`](dependencies.md).
