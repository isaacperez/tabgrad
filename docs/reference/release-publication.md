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

The aggregate run response can report `queued` while a job executes. That value
alone grants no authority. In that case the controller additionally requires
one authenticated active job for its exact eligible role, run, attempt and
source; missing, ambiguous, foreign or nonactive evidence rejects. The human
controller's eligible job is its live bootstrap relay. This role evidence is
separate from the common client/observer gate context. Control observations
recheck the publication window and operational qualification at decision time,
including after asynchronous reads; conservation retains its separate
existing-call-only time boundary.

| Role | Authority and responsibility |
| --- | --- |
| Precheck | Read actual repository/run/environment and enrolled history metadata before the environment job can be created; no approval or write |
| Admission | Protected environment approval with an exact plan/run comment; verify original producer data/proofs, open the plan and confirm npm intent with Contents-write; no npm identity |
| npm | Contents/Actions/Issues-read and OIDC only; prepare/read registry state, announce readiness, authenticate the late observer and publish the original archive/proof; no standing-token fallback |
| Human bootstrap relay | Read-only reception of attributed readiness and original-call reconciliation; no npm identity |
| Late GitHub observer | Qualified Contents-write view, no npm/OIDC identity or package execution; check current intent/authority/destinations after readiness and emit the bound permission |
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
artifact custody. Verify the late observer's actual sufficient draft view under
its exact recipe/job grant; an arbitrary reader cannot infer absence from an
empty listing or repository permission flags. Denied observations fail closed,
without giving npm Contents-write. Qualify immutable releases before relying on their final freeze.
The first useful npm OIDC publication is a later evidence boundary.

Private configuration consists of separately admitted
`TABGRAD_RELEASE_POLICY_JSON` and its SHA-256, and
`TABGRAD_RELEASE_QUALIFICATION_JSON` matching the policy's operational evidence
hash. These are repository configuration, not dispatch authority. Keep actual
identities, policy originals, authentication and destinations out of issues and
source. Install the three values as repository **secrets**, not configuration
variables. The workflow delivers them only through the environment of each
maintained publication-role command, excluding checkout, setup and transfer
actions. Registering a mask inside that command is too late to protect the
runner's preceding environment header.

Secret masking registers whole values for redaction; do not rely on it to redact
arbitrary nested fields, reformatted JSON, substrings or derived outputs.
Keep command errors and retained results bounded and inspect the actual first
header, subsequent steps and failure logs with synthetic inputs before admitting
private configuration. Source checks alone do not qualify that provider behavior.
GitHub's [per-secret limit](https://docs.github.com/en/actions/reference/security/secrets#limits-for-secrets)
is 48 KB, distinct from the local policy parser's
65,536-byte ceiling. A locally valid document may therefore be too large for
this CI transport; do not split, truncate or substitute its admitted bytes.

The policy parser is closed; it binds repository/owner IDs, exact recipe,
opaque responsible-owner mappings, environment snapshot, finite operational
qualification, optional human-controller binary identity, enrolled Git control
location/root/writer and an identified initial history artifact. Its `history`
fields are `id`, `sha256`, canonical `expiresAt`, `runId`, `revision` and `name`.
The metadata reader checks that artifact's repository, original run/source,
digest, size, expiry and name before transfer. Configuration hashes alone do not
authenticate the party which installed them.

## Prepare the initial history handoff

The first publication needs original evidence before its own recorder can
upload anything. Enrollment still belongs to
[`release-record.mjs`](release-record.md); the separate
`.github/workflows/release-history.yml` only delivers already inspected data.
It neither enrolls a root nor authenticates the evidence's claims.

Select the complete initial originals required by the admitted Git record,
including its location, writer-policy and prior-effects evidence. The directory
contains only SHA256-named `.json` files under the existing history reader.
Inspect **every original for the public artifact audience** before transfer.
Hash filenames and base64 do not hide contents; even location evidence reveals
its URL/reference. Configuration, the private operational policy, credentials
and additional private dossiers stay outside this directory. If a required
original cannot be public, stop: do not omit, redact or replace its bound bytes.

With prepared repository Node, pack that selected directory locally:

```console
node scripts/release-history.mjs prepare ABSOLUTE_ORIGINALS SOURCE_REVISION EXPIRES_AT ABSOLUTE_NEW_OUTPUT
```

`SOURCE_REVISION` is the exact approved main recipe; `EXPIRES_AT` is a finite
canonical UTC deadline. The new owned output contains `history.json` and the
complete REST `dispatch.json`; stdout identifies their packet hash, file count
and request size without printing originals or local paths. This preparation
uses no network or credentials and changes no source or originals. Inspect the
files before authorizing any service use. Keep output outside the originals,
source and distribution; preparation rejects a destination inside its originals.
These local outputs are not committed generated files. The packet is needed to supply the
first runner files; it is not another record or a general evidence bundle.

This finite profile accepts only initial evidence whose **entire serialized
dispatch request** fits 65,535 ASCII characters, including packet encoding,
escaping, names, digest, source, deadline and confirmation. This conservative
count includes more than GitHub's
[aggregate inputs budget](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#providing-inputs);
its five inputs are below the platform's 25-property limit. The history reader's
larger per-file/aggregate bounds do not guarantee dispatch capacity. Oversize
fails locally without output or transfer. There is no splitting, truncation or
redaction; originals remain exact opaque bytes inside the canonical packet.

Actual activation and dispatch require separate operational authorization,
including the exact files, readers, cost, source/deadline and conservation.
Only then set the separately admitted enable variable
`TABGRAD_PUBLICATION_HISTORY_ENABLED` to exactly `true` and submit the inspected
request to the selected repository:

```console
gh api --method POST repos/OWNER/REPOSITORY/actions/workflows/release-history.yml/dispatches --input ABSOLUTE_NEW_OUTPUT/dispatch.json
```

The manual-only workflow checks exact main/source/attempt/confirmation before
checkout, selects the existing controller Node, and rechecks context, deadline,
the complete input budget, packet and original hashes before materialization.
Its sole job has only Contents/Actions-read, no npm, OIDC, signing or Git-write
identity, and a 15-minute job timeout. It does not install a publishing client,
build a candidate or execute received data. An invalid input cannot enable the
subsequent upload. Local output is a new owned directory; failed writes attempt
only its cleanup and report uncertain cleanup separately.

The one upload preserves only the hash-named originals, uses a run/attempt name,
forbids overwrite and requests 90 days. Hosted transfer/SDK behavior is a trusted
boundary; job/deadline checks do not guarantee physical cancellation or remote
completion before that instant. The final read-only `observe` command checks
the upload's actual metadata and writes the six `history` values to stdout and
the job summary: `id`, `sha256`, `expiresAt`, `runId`, `revision`, `name`.
Here `sha256` is the **artifact transport digest**, not the packet hash, and
`expiresAt` comes from the API, never from adding 90 days. `revision` identifies
this artifact-producing recipe, not a candidate chosen later.

Independently retain/check the original artifact metadata, packet and exact
originals before installing those six values in private admitted policy.
Observed metadata supplies no approval. Conserve an independent copy before
effective expiry; temporary Actions retention is not permanent custody. The
artifact remains subject to the publisher's existing metadata, digest and
history admission on receipt. Keep actual settings and authority evidence
outside issues/source.

If upload or metadata readback fails, inspect the same original run and artifact
before another action. Failure can leave an existing or unknown artifact; never
rerun automatically, infer absence or reset the Git root. A late readback can
conserve facts, but cannot authorize another upload. Local checks establish this
source/profile, not actual service protections, queue/approval/HTTPS/draft
visibility/immutable behavior or useful publication; those retain their separate
qualification and approval.

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

For the foreign signed fixture, acquisition bounds the registry API envelope
before parsing and records its observed size/hash and comparison with the
identified baseline. It selects exactly one SLSA-v1 bundle and checks the entire
canonical UTF-8 JSON object against an independently pinned size/hash. Only JSON
key/layout encoding changes: DSSE payload/signature strings, array order and all
bundle fields, including unknown fields, remain identified. Changed, missing or
extra bundle data fails. This fixture rule does not canonicalize or replace the
original proof bytes admitted for an actual Tabgrad publication.

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
The npm role prepares its identified client and registry reads, then announces
readiness and waits while the separate observer checks GitHub. It authenticates
the completed permission and rechecks authority, intent, current client and
expiry before one bounded SDK invocation. A response loss is unknown, not absence or a retry.
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

The consumer and GitHub completion jobs use explicit status conditions: unused
authentication branches may be skipped without skipping these later stages.
Each stage still requires its own prerequisites to succeed and rejects workflow
cancellation. Completion additionally requires successful consumer verification.
The outcome recorder retains its separate failure-conservation condition.
Inspect the actual required jobs and their receipts when assessing delivery;
an aggregate successful run can also contain skipped jobs.

Archive-proof association compares all bundle fields, including unknown fields.
It treats omitted versus explicitly empty signature `keyid` and
`timestampVerificationData.rfc3161Timestamps` as the same Sigstore JSON defaults,
within their existing messages. It preserves nonempty values, message presence,
array order/cardinality and all signed material exactly; it does not round-trip
the bundle through a schema codec. Original file bytes and their admitted hash
remain unchanged, and cryptographic verification remains independent. The
inventory proof has its own verification, not a registry association.

All role commands have the form below; running one locally requires its actual
admitted context, configured permissions and input handoffs. They are not a
substitute for dispatch or permission to improvise credentials:

```console
node scripts/release-publication.mjs precheck ABSOLUTE_OWNED_ROOT
node scripts/release-publication.mjs admit ABSOLUTE_OWNED_ROOT
node scripts/release-publication.mjs npm-prepare ABSOLUTE_OWNED_ROOT
node scripts/release-publication.mjs select-ready ABSOLUTE_OWNED_ROOT
node scripts/release-publication.mjs permit ABSOLUTE_OWNED_ROOT
node scripts/release-publication.mjs select-permission ABSOLUTE_OWNED_ROOT
node scripts/release-publication.mjs npm ABSOLUTE_OWNED_ROOT
node scripts/release-publication.mjs bootstrap-ready ABSOLUTE_OWNED_ROOT
node scripts/release-publication.mjs bootstrap ABSOLUTE_OWNED_ROOT
node scripts/release-publication.mjs observe ABSOLUTE_OWNED_ROOT
node scripts/release-publication.mjs consume ABSOLUTE_OWNED_ROOT
node scripts/release-publication.mjs complete ABSOLUTE_OWNED_ROOT
```

## Readiness and permission handoff

The client or human relay and `observe-ready-publication` start after admission.
The observer is not a dependency preventing the client from preparing. Readiness
is uploaded before the client's `Await observed permission` step; the observer
requires that wait to be active, performs its checks and completes its permission
upload. The client authenticates the completed observer job before dispatch.
Outcome recording still handles failed actors; consumers precede GitHub completion.

The closed canonical UTF-8 packets have `schemaVersion: 1`, `kind` (`ready` or
`permission`), `scope` and a 32-byte hexadecimal session `nonce`. Scope binds the
plan SHA-256, exact execution context, original npm handoff, mode and approved
window. The handoff retains operation, plan, call, effect and record-head identity.
Permission adds only `readySha256`; its bytes are deterministic from the admitted
scope and readiness, not from a caller-provided assertion of successful checks.
The trusted observer emits those bytes only after its checks. The window and
causal order apply; no independent maximum-age or atomic-destination guarantee
is inferred from a diagnostic timestamp.

Admission requires one exact role in at most 100 listed jobs/artifacts. The
upload step's resolved `Readiness SHA256 ...` or `Permission SHA256 ...` name
must have completed successfully in the exact run/attempt/source. Pending names
are awaited; completed invalid, failing or ambiguous names reject. Artifact
metadata must match the independently selected ID/name/digest/context, be live,
fit the 2 MiB gate profile and outlast the window. CI uses the pinned
`download-artifact` with `digest-mismatch: error`, followed by revalidation of
that selection and exactly one regular `ready.json` or `permission.json` member
of at most 65,536 bytes and its separate raw SHA-256. These are admission bounds;
they do not bound the SDK's transient download/extraction before rejection.

The observer and human relay consume the authenticated admission, notes when
needed, and control history; they do not download or execute candidate payloads.
The npm actor still rechecks transported candidate/proof bytes before its call.
Repeated commands reuse only byte-identical staged inputs. Local preparation and
call claims remain for the owned session; moving diagnostic files does not renew
them. An unavailable or repeated claim stays unknown, even if a later wait fails.

The public-safe gate evidence is distinct from private client diagnostics and
controller observations. The receipt binds its retained call/controller original;
inspect and conserve those private originals separately. CI-private diagnostics
have only their VM lifetime unless separately conserved. A destination match
does not replace the actual call result, and a successful local test does not
qualify provider attribution, transfer, permissions or protections.

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

Keep stdin, stdout and stderr attached to the real terminal through both human
launch layers. Redirecting any of them rejects before the publication process
is spawned. npm presents its own supported second-factor prompt or browser
flow; never disable MFA to compensate for a missing terminal. Human publication
uses plain output and disables automatic browser opening, so npm displays its
authentication link immediately without requiring Enter. Give that private link
to the person completing authentication to open themselves; do not put it in
public evidence. Namespace queries and automated publication retain JSON.

The human publication process uses the earlier remaining plan or namespace-reader
deadline, capped only by the process API's maximum timer delay (2147483647ms).
It has no separate two-minute limit. Authentication does not renew either
deadline; cancellation and the finite outer session still apply. This does not
change npm's HTTP request timeout or the automated publisher's process budget.

The human call uses the explicit `human-terminal-exit` confirmation method.
Its private original records the observed status, signal, dispatch and
`outputMode: "inherited-terminal"`; stdout/stderr are `null`, meaning not
captured. A zero exit, no signal and no controller error from that admitted
call produce `PUBLICATION_NPM_HUMAN_PROCESS_SUCCESS`. This is client call
evidence, not a retained JSON response or complete terminal transcript. There
is no automatic capture-byte limit on inherited terminal output. CI keeps its
captured JSON method and output limits. A terminal marker or destination
match alone cannot select human confirmation or settle a failed/unobserved
call. Subsequent exact registry/provenance/consumer verification is still
required before GitHub completion.

After the actual child finishes its qualified namespace reads, the same live
parent creates `public-output/readiness-comment.txt` and waits. The admitted
maintainer, or its separately authorized coordinator, inspects and posts that
exact public-safe file in the approved issue using its GitHub identity:

```text
tabgrad-release-bootstrap-ready PLAN_SHA256 OPERATION RUN_ID/ATTEMPT
{the exact canonical ready packet, including its final newline}
```

Keep the parent and child alive while conveying that file. Never manufacture it
from a previous process or normalize/rebuild its body when posting. The CI relay
checks the actual authenticated maintainer ID, current window and unique comment,
then publishes that readiness and remains waiting for the outcome. The separate
GitHub observer checks current state and completes its bound permission. The
parent authenticates that emission before approving the child; the child
reidentifies its client files and checks the reader/window again before dispatch.
The child receives npm-only authentication, never a GitHub writer token.

The human parent derives the deterministic permission bytes independently from
its admitted scope and live readiness. It compares their exact SHA-256 with the
completed observer upload step and corroborated artifact metadata, retaining
those expected bytes and the provider association in `gate-evidence.json` and
the private controller original. This profile does **not** download or verify
the remote ZIP and does not call those bytes a captured remote original. It is
not a shortcut for signed proofs, trust roots or archives whose originals are
required. The CI client instead transfers and admits the actual permission file.

The human root has the same `data/`, `proofs/`, `verification/`, approved `input/`
and authenticated `admission/admission.json` as the current CI run. Supply the
canonical plan digest through `TABGRAD_PUBLICATION_PLAN_SHA256`; omit the dispatch
JSON environment inputs when reading those local files. The human path has a
local one-use claim, finite approval/reader deadlines, cancellation and observed
child close. The parent owns the child's private working directory and removes
it after close even if the child must be killed. A second invocation at the same
root is refused. Retain that claim for the session lifetime; this is not an
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

The narrow [administrative retirement/policy handoff](release-record.md#apply-an-explicit-administrative-recovery)
can admit forward progress only after exact current maintainer approval. It
preserves historical UNKNOWN and the original grant. Publisher guards use the
complete reader's **blocking** count; historical unresolved totals remain visible.
Old authorities are validated under their operation's admission policy; current
approval must name the effective policy. A retired operation/candidate cannot
continue, and changed unknown observations or new conflicts block again. This
exception does not turn a matching manual delivery into an old CI success.
An authenticated existing-call report can still be conserved after another
call becomes blocking or an operation retires. Conservation binds the original
intent commit, plan, authority, call and effect; it grants no new intent and
does not require the current head to equal that old intent head. The actual
current head remains the recorder's expected-head lease. A substituted intent
commit fails. Preserve contrary facts through the ordinary conflict semantics.

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

## Release an existing public package

Use this path when the package exists and the useful selected next version has
never been used. Ordinary delivery starts by manual dispatch of the existing
workflow; a public GitHub release must not trigger another npm publisher.

1. Select version/channel under the [release policy](../releases.md). Integrate
   metadata, notes, compatibility/support claims and required corrections through
   reviewed main. Do not manufacture a version only to test authentication.
2. Prepare the selected public candidate through the
   [producer](producer-trial.md). Admit actual source/recipe, exact archive and
   inventory, original two proofs, CI corroboration and declared external CPU/GPU
   qualification. Publishing never rebuilds or repacks those bytes.
3. Inspect the complete enrolled record and all retained originals. A free
   concurrency slot or matching destination does not settle an earlier call.
   Apply only explicitly admitted recovery when required. Supply the complete
   current history handoff, including later facts; an old artifact may omit them.
4. Admit current private operational policy/qualification for the reviewed
   recipe, environment, writer, history and finite window. Recheck mutable
   protections, actors and destinations. Copying old files does not renew their
   expiry or approval. Reuse applicable immutable qualification; a new version
   alone does not justify repeating an acquisition laboratory.
5. Construct and independently inspect the ordinary plan with
   `node scripts/prepare-publication-plan.mjs INPUT_DIRECTORY NEW_OUTPUT_DIRECTORY`.
   Use `npm.mode=oidc`, `npm.before.package=existing`, an absent unused version
   and the observed starting channel. Pin producer artifact identities, original
   proofs, qualification, notes, six assets and current source/clients.
6. For the first useful OIDC delivery, coordinate trusted-publisher registration
   with that approved version/window. Bind the exact authorized repository,
   workflow filename and environment, and explicitly permit direct publication
   under the provider's current rules. Respect its documented first-success
   deadline. Keep settings/authentication private. A saved binding, `npm whoami`,
   source tests or human bootstrap do not establish effective OIDC. Use no
   standing-token fallback or dummy publication. See
   [npm's trusted-publisher procedure](https://docs.npmjs.com/trusted-publishers/).
7. Under concrete publication authorization, enable and dispatch the existing
   release-publication workflow with inspected plan/hash, exact notes,
   qualification, receipt issue and confirmation. Review the protected job's
   exact approval comment. CI performs readiness, separate late GitHub permission,
   one identified npm invocation, outcome recording, registry/external consumers,
   then conditional immutable GitHub completion. Supply authenticated physical
   GPU evidence when declared; a hosted fallback is not that evidence.
8. Verify installed version/channel/bytes/provenance, all six downloaded GitHub
   assets, tag/source, type/latest and immutable protection. Conserve complete
   originals before expiry, restore reserved switches to their admitted inert
   state and reconcile work records. Claim first useful OIDC only from its
   successful actual receipt and corresponding completed flow.

A failed, missing or unknown effect retains its original evidence. Inspect the
identified call and destination before continuation; rerunning a job or freeing
its slot grants no retry authority. Follow separately admitted recovery without
resetting history, replacing an archive or extending an expired window.
