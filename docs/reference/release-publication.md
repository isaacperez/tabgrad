# Controlled release publication

This is the maintained command and human procedure for
[`release-publication.mjs`](../../scripts/release-publication.mjs). The
[release policy](../releases.md) owns versioning, authorization, trust,
maintenance and recovery. Source controls do not establish effective service
protections, a qualified live publisher or permission to publish.

## Responsibilities and prerequisites

The manual `.github/workflows/release-publication.yml` recipe is inert unless
its enable variable is exactly `true`. It accepts only protected `main`, the
identified recipe revision and attempt one. The fixed noncanceling publication
concurrency group spans approval, npm, consumer checks and GitHub completion.
A queued slot is not evidence that another actor has stopped: the enrolled
[control record](release-record.md) must also admit every call.

| Role | Authority and responsibility |
| --- | --- |
| Precheck | Read actual repository/run/environment and enrolled history metadata before the environment job can be created; no approval or write |
| Admission | Protected environment approval with an exact plan/run comment; verify original producer data/proofs, open the plan and confirm npm intent with Contents-write; no npm identity |
| npm | Contents/Actions/Issues-read and OIDC only; publish the original archive with its original producer proof using the identified separate client; no standing-token fallback |
| Human bootstrap observer | Read-only wait for the admitted maintainer's explicit original-call reconciliation; no npm identity |
| Outcome recorder | Contents-write, no npm identity; record actual or unknown outcome, including after the original publication deadline |
| Consumers | Read-only registry and external application execution with build/consumer Node/npm; separately supplied physical GPU report when claimed |
| GitHub completion | Contents-write, no npm identity or consumer execution; verify current handoffs/destinations, then conditionally create tag, draft, assets and public release |

No role signs or rebuilds the candidate. The Contents-write token is repository
scoped, not branch scoped. Never execute package or consumer code with that
credential. The npm identity is bound to this reviewed workflow, independently
of the producer workflow; effective provider bindings require qualification.

Before enabling anything, separately authorize and qualify the actual workflow
queue/approval/handoffs in disposable service fixtures, without an npm publisher
or publishing identity. Admit protections, reviewers/bypasses, writer identity,
control root and prior-effects reconciliation, public outputs/readers, cost and
artifact custody. Verify that the read-only npm job can observe required draft
state; lack of visibility fails closed and must not be fixed by giving it
Contents-write. Qualify immutable releases before relying on their final freeze.
The first useful npm OIDC publication is a later evidence boundary.

Private configuration consists of separately admitted
`TABGRAD_RELEASE_POLICY_JSON` and its SHA-256, and
`TABGRAD_RELEASE_QUALIFICATION_JSON` matching the policy's operational evidence
hash. These are repository configuration, not dispatch authority. Keep actual
identities, policy originals, authentication and destinations out of issues and
source. The policy parser is closed; it binds repository/owner IDs, exact recipe,
opaque responsible-owner mappings, environment snapshot, finite operational
qualification, optional human-controller binary identity, enrolled Git control
location/root/writer and an identified initial history artifact. Its `history`
fields are `id`, `sha256`, canonical `expiresAt`, `runId`, `revision` and `name`.
The metadata reader checks that artifact's repository, original run/source,
digest, size, expiry and name before transfer. Configuration hashes alone do not
authenticate the party which installed them.

## Prepare tools and candidate inputs

Build and named-registry consumer pins remain Node22.12.0/npm11.1.0. The
publishing client is separately prepared Node22.23.3/npm12.2.0. Exact archive
pins, inventories and limits live in
[`publication-client-profile.json`](../../scripts/publication-client-profile.json),
not a version-only PATH selection. Explicit setup writes a new private directory,
including Node's original license and the complete npm tree; it executes none
of those tools. Qualification subsequently identifies the complete manifest,
executes actual clients with genuine original proof fixtures, and exercises
local disposable endpoints with fictitious credentials. Its public TUF reads
are explicit; this is not an offline or real-provider qualification.

```console
.venv/bin/python scripts/prepare_publication_client.py NEW_CLIENT_DIRECTORY
.venv/bin/python scripts/prepare_publication_client.py --fixtures NEW_FIXTURE_DIRECTORY
node scripts/qualify-publication-client.mjs ABSOLUTE_CLIENT_DIRECTORY CLIENT_MANIFEST_SHA256 ABSOLUTE_FIXTURE_DIRECTORY
```

These are setup/check commands, never implicit release authorization. The
optional [proof verifier](package-provenance.md) is independently prepared and
identified. Publication input admission verifies both original proofs without
building or executing the candidate; later roles reuse only an authenticated,
exact current-run admission handoff and rehash its transported files.

Use the same useful public candidate prepared and qualified by the
[producer](producer-trial.md). The archive, original canonical inventory,
static tree, CPU consumer report, producer record and both signed bundles must
remain unchanged. Obtain the three identified producer artifacts: preparation,
proofs and verification/corroboration. Retain their API originals and independently
admit source/recipe identities and trust roots. Add the declared physical GPU
qualification outside hosted software-GPU runners. Never relabel a development
or private trial as a public version.

Prepare a local input directory with `draft.json`, `data/` (producer packet),
`proofs/` (the two original proof files), `verification/` (producer verification
outputs) and `input/notes.md`, `input/qualification.json` (CPU and, when declared,
physical GPU report array). Draft construction fills only absent derived hashes;
contrary supplied identities fail. It does not authenticate source or approve:

```console
node scripts/prepare-publication-plan.mjs INPUT_DIRECTORY NEW_OUTPUT_DIRECTORY
```

Inspect the resulting canonical `input/plan.json` and its SHA-256 independently.
The closed ordinary-version profile binds operation/opaque authority/owner,
finite window, candidate source and hashes, original producer signing deadline,
proof hashes, three artifact IDs/digests/expiries, verification client/root/CI
identity, publisher recipe and actual controller/client binary identities,
registry/channel/access/prior state, tag/type/latest/notes, all six assets and
qualification. Unsupported prereleases or transitions require a separate
reviewed profile; this command does not infer them. The publication window must
fit every input's effective validity. Revalidation cannot renew original
signing authority or silently extend an approved publication window.

The six final assets are archive, inventory, archive proof, inventory proof,
producer evidence packet and checksums. The evidence packet preserves ten exact
originals: producer record, original CPU qualification, CI corroboration, trusted
root, verification result, four API originals and combined release qualification.
It excludes role-local paths and private policy/authentication. Decode with
`decodePublicationEvidence` only as data; matching bytes do not authenticate
those observations. The full publication plan and later control observations
are separate retained control-history originals, avoiding a self-referential
asset hash.

## Approve and execute one ordinary publication

The dispatch inputs are canonical `plan_json`, its separately inspected
`plan_sha256`, exact public `notes`, combined `qualification_json`, the approved
public-safe receipt issue number and confirmation `release-publication`.
Inspect the entire input and all intended public files before dispatch. Their
content, provider logs and artifacts become visible to the admitted readers.
The workflow requires separately authorized actual configuration and execution.

Precheck reports the exact environment-review comment in its job summary:

```text
tabgrad-release-approve PLAN_SHA256 OPERATION RUN_ID/ATTEMPT
```

The admitted maintainer reviews those same originals and the selected run,
then approves the protected `tabgrad-npm-publication` environment with exactly
that comment. A different actor, missing protection, changed snapshot, rejected
review, different run/attempt or mismatched plan stops admission. Main and the
workflow source are checked independently. An older candidate with a different
`.github/workflows` tree is refused before npm because completion would need
Workflows-write authority; no automatic permission expansion is attempted.

The recorder transfers only hash-named public-safe originals from the admitted
initial history, confirms the current root/head and records the full plan,
authenticated execution observation and intended npm call. Each subsequent
recorder output preserves available originals for the next identified handoff.
The npm role rechecks authority, intent and destination state immediately before
one bounded SDK invocation; a response loss is unknown, not absence or a retry.
SDK diagnostics remain outside public artifact paths, for the VM lifetime only;
sanitized receipts separately state remote outcome, local success and cleanup.

After a verified npm outcome, the read-only consumer role checks the exact
version/channel, archive, original associated provenance and named installation
in actual external browser applications. Its report identifies the consumed
archive and npm11 consumer profile. A declared physical GPU profile is supplied
through an admitted maintainer comment bound to this plan/run; a hosted fallback
adapter is never physical evidence. Only then may the trusted GitHub role
complete the exact tag, draft, notes and six assets and make the release public.
Final inspection requires the expected latest designation and immutable freeze.
Failure after npm preserves a partial release and never repacks or republishes.

All role commands have the form below; running one locally requires its actual
admitted context, configured permissions and input handoffs. They are not a
substitute for dispatch or permission to improvise credentials:

```console
node scripts/release-publication.mjs precheck ABSOLUTE_OWNED_ROOT
node scripts/release-publication.mjs admit ABSOLUTE_OWNED_ROOT
node scripts/release-publication.mjs npm ABSOLUTE_OWNED_ROOT
node scripts/release-publication.mjs bootstrap ABSOLUTE_OWNED_ROOT
node scripts/release-publication.mjs observe ABSOLUTE_OWNED_ROOT
node scripts/release-publication.mjs consume ABSOLUTE_OWNED_ROOT
node scripts/release-publication.mjs complete ABSOLUTE_OWNED_ROOT
```

## First absent-package publication

A public 404 does not establish authorized package absence. If the approved plan
uses `bootstrap`, the CI run confirms its intent and waits without npm identity.
Use the separately authorized human procedure, on the clean identified recipe
and controller binary with the exact admitted producer files and CI admission
output. Supply `TABGRAD_HUMAN_ADMISSION_SHA256` from its authenticated CI handoff;
the controller corroborates current GitHub authority and the still-active
bootstrap observer. It checks before spawning and again after npm namespace
reads. The child gets explicit npm-only authentication, never GitHub or OIDC
credentials.

Prepare an absolute private regular mode600 npmrc with only the explicit npm
registry token line, through authorized human authentication/2FA. Do not send it
in chat, source or logs. Set `TABGRAD_HUMAN_NPMRC`, the identified client directory
`TABGRAD_PUBLICATION_CLIENT`, and independently admitted `TABGRAD_HUMAN_READER`
plus `TABGRAD_HUMAN_READER_SHA256`. That finite reader profile identifies the
expected npm username/scope and owner role; actual `whoami`, `org ls` and package
metadata reads must agree. It is private configuration, not a hash of public404.
The parent uses an explicit read-only `GH_TOKEN` and the same admitted policy;
its clean source and binary identity are checked. Human tokens are not a CI
fallback. Use an interactive terminal:

```console
node scripts/release-publication.mjs human ABSOLUTE_OWNED_ROOT
```

The human root has the same `data/`, `proofs/`, `verification/`, approved `input/`
and authenticated `admission/admission.json` as the current CI run. Supply the
canonical plan digest through `TABGRAD_PUBLICATION_PLAN_SHA256`; omit the dispatch
JSON environment inputs when reading those local files. The human path has a
local one-use marker, finite approval/reader deadlines, cancellation and observed
child close. A second invocation at the same root is refused. This is not an
exactly-once or remote-cancellation guarantee.

Review the original client result and private diagnostics. An admitted maintainer
then posts only the inspected safe receipt in the approved issue, using:

```text
tabgrad-release-bootstrap PLAN_SHA256 OPERATION RUN_ID/ATTEMPT
{the exact sanitized receipt JSON}
```

The observer checks actual authenticated author ID, window and unique comment,
retains attribution and sends it to the separate recorder. Hashes and destination
presence do not authenticate a call. For declared physical post-publication GPU
checks the equivalent header is `tabgrad-release-gpu-consumers` and the body is
the actual named-registry consumer report. Never post raw configuration or client
stderr. The first human delivery does not validate the later OIDC binding; qualify
that with its first useful separately authorized CI publication, not a dummy.

## Inspect, conserve and recover

Download and verify the completion/partial-outcome artifact and full hash-named
control originals before effective artifact expiry. Retention is requested for
90 days, not a wait before release or a permanent store. Keep independently
controlled originals and head/root observation pins for permanent maintenance.
The six frozen release assets conserve producer evidence; the complete control
history and its later observations have their own custody. A successful Git
append followed by failed artifact conservation can leave missing originals:
stop and reconcile; do not reset the root or fabricate reconstruction.

The outcome recorder can conserve an authenticated existing-call fact after the
publication deadline under current qualified control. That conservation path
cannot create a new distribution intent or renew authority. Missing call reports
remain unknown; unknown/conflicting writes block later admission. Abrupt run
cancellation can prevent that recorder from running; inspect the original run,
record and actual call evidence under separately authorized recovery.

For a known partial completion, explicitly close the original operation as
abandoned only after every call is settled. A new independently approved plan
must name that closure as its continuation, use a new operation/window and
preserve exact completed effects. `npm.mode=observe` requires already proven
npm success and never invokes npm again. Changed/frozen/conflicting destination
content is not overwritten. The existing record commands supply explicit
inspection/append/reconciliation; the publisher does not automatically abandon,
enroll, reset or clean remote content.

For source verification, run the focused `publication-*.test.mjs` controls and
`publication-record.test.mjs`, Python setup controls, actual-client qualification
and all applicable repository/runtime/browser families. Models, local Git writes,
actual client fixture requests, service qualification and useful real publication
are different evidence. No source test establishes live protections, universal
compatibility, exactly-once effects or timing/resource guarantees.
