# Versions, releases, and migrations

This document defines how Tabgrad turns verified repository work into a public
version and how users are told about changes. A merge is not automatically a
release, and an artifact uploaded from an unverified local tree is not a
Tabgrad release.

## Version public artifacts

Use Semantic Versioning for each public Tabgrad artifact. Use tags of the form
`vMAJOR.MINOR.PATCH` for a repository-wide release. Independently versioned
packages require a documented version mapping and release ownership.

Before `1.0.0`, increment the minor version for a breaking public change and
the patch version for a backward-compatible correction. A backward-compatible
feature may also increment the minor version. From `1.0.0`, follow the ordinary
Semantic Versioning meanings: major for breaking public changes, minor for
backward-compatible features, and patch for backward-compatible fixes.

Do not infer compatibility solely from a version number. Record every
supported interface and difference in [`compatibility.md`](compatibility.md).

## Maintain release notes

[`CHANGELOG.md`](../CHANGELOG.md) records user-visible changes. Keep an
`Unreleased` section and move its entries to a dated version when releasing.
Use the established categories `Added`, `Changed`, `Deprecated`, `Removed`,
`Fixed`, and `Security` when they contain entries.

Write entries from the user's perspective and link the issue or pull request
that provides details. Do not list internal refactoring unless it changes a
user-visible property or is important to contributors who build or integrate
Tabgrad. Describe security corrections without publishing unsafe details.

A breaking or deprecated change must include migration guidance. State the old
behavior, new behavior, affected users, replacement, warning period when one
exists, and action needed to update.

## Prepare a release from a controlled state

Create a release only from an identified commit on the protected default
branch. The release change must establish:

- the exact version and included pull requests;
- compatibility and supported environments for the release;
- updated changelog, migration notes, documentation, and license notices;
- reproducible dependency resolution and generated files;
- passing required checks for the release commit;
- successful creation and inspection of every distributed artifact;
- artifact names, checksums, provenance, and publication destinations;
- known limitations and unresolved security or correctness concerns; and
- the person authorized to publish.

Build artifacts through documented automation from the release commit. Do not
publish an artifact built from a dirty working tree or rebuild different bytes
under an existing version. A failed or ambiguous publication must be inspected
at the destination before retrying.

Tagging, creating a GitHub release, publishing packages, updating a website,
and announcing a release are separate external mutations. Perform only the
actions the current authorization covers.

## Verify installation and migration

Test each supported installation path from the published or release-candidate
artifact, not only from repository source. Exercise a minimal public example
and any backend or browser capability the release claims.

For a migration, test the documented steps from every supported starting
version that materially differs. A migration must be safe to interrupt or must
explain its recovery procedure. Record irreversible effects and backup needs
before release.

## Respond to a problem after release

Preserve evidence and establish affected versions, severity, user impact, and
whether the published artifact differs from its source. For a sensitive
vulnerability, follow [`SECURITY.md`](../SECURITY.md).

Choose among a corrective patch, documented mitigation, withdrawal, or revert
according to user harm and reversibility. Do not delete or replace a published
version silently. A correction receives its own version and release notes.
Mark a release as affected or withdrawn when the distribution service supports
that state and the action is authorized.

After publication, verify the tag, release record, package metadata, checksums,
documentation links, compatibility record, milestone, and issues. Report any
partial or ambiguous external result instead of assuming eventual consistency.
