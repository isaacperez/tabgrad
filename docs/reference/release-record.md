# Release record tooling

This is the data and command reference for `scripts/release-record.mjs` and
`release-record-data.mjs`. The [release policy](../releases.md#record-intent-and-observations-durably)
owns authorization, protection, recovery and the separation of actors. These
tools record observations; they neither publish nor decide that publication is
authorized. Local Git controls do not qualify real credentials or protection.

## Keep the control repository separate

Use an explicitly selected control branch outside the library source, build,
consumer and signing inputs. Supply its location and trusted enrollment through
private configuration, never through checked-in deployment data. Each command
uses an owned temporary bare Git repository without checkout, templates, hooks,
global/system Git configuration, replacements or recursive submodules. It reads
only the selected reference. The installed Git executable and explicit
authentication helpers are trusted tooling inputs.

The private JSON configuration has exactly these fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `1` |
| `location` | Explicit absolute local repository path or `https://` URL without embedded username/password; no remote alias or directory default |
| `ref` | Dedicated `refs/heads/` name containing lowercase letters/digits and single hyphens; `main` and `master` are refused |
| `protocol` | Exactly `file` or `https`; Git is restricted to this transport |
| `root` | Independently enrolled 40-character SHA-1 Git commit; `null` only for explicit enrollment |
| `writerPolicy` | SHA-256 of the retained **effective** writer-authority/protection record; initially the enrollment policy |
| `evidence` | Object mapping SHA-256 identities to retained original files; relative paths resolve against this configuration |

The location evidence is the exact canonical encoding of
`{location, ref, protocol}`. Its SHA-256 is the root event's `location`.
Changing that binding or the enrolled root fails. A different writer policy
requires the explicit versioned handoff below; configuration alone cannot
substitute one.
This binds supplied configuration bytes; it does not authenticate an endpoint,
resolve malicious redirection or establish effective branch protection.

Git receives a small system environment allowlist and an owned empty home, not
ambient Git/SSH/npm settings, agents, proxies or Node preload options. File
transport receives no publishing tokens or authentication helper. HTTPS requires
an explicit absolute `GIT_ASKPASS` helper; only that path and an explicitly
supplied `GITHUB_TOKEN` are additionally forwarded. Interactive terminal prompts
are disabled. SSH is unsupported. The recorder does not choose a default helper
or recover by changing credentials. The selected helper is trusted code: its
own credential sources and behavior must be qualified separately. Environment
selection tests are not evidence of actual HTTPS authentication or enforcement.

Before operational enrollment, reconcile preceding effects, authorize the
root/location and writer, and qualify actual permissions/protection. Enrollment
requires an absent reference and retained location, writer-policy and
prior-effects evidence. Keep the returned root identity in separately admitted
configuration only after inspecting the confirmed result. An uncertain attempt
requires inspection/reconciliation, never another automatic enrollment/reset.

## Prepare and inspect bounded public data

Ordinary event inputs have exactly `{schemaVersion: 1, event}`; the explicit
`handoff` input uses `schemaVersion: 2`. Encode using the
exported `canonicalBytes`: sorted object keys, unchanged array order, UTF-8 JSON
and one final newline. Noncanonical bytes, duplicate keys, malformed UTF-8 and
unknown fields/versions fail. An input or stored frame is at most 65,536 bytes;
this is a format limit, not a performance or whole-history memory guarantee.

Events contain only fixed enums, canonical UTC instants
(`YYYY-MM-DDTHH:mm:ss.sssZ`), digest identifiers and their declared lists/objects.
They have no free-text, URL, path, account, credential or executable field.
Digest identifiers can still disclose identifying metadata: inspect the entire
input and its meaning under the publication policy. Schema validation or the
`inspect` command is not human approval or producer authentication.

Every event has `type` and `at`, plus the fields below. Digest identifier fields
are lowercase 64-character SHA-256 strings; the recovery decision separately
names its 40-character Git identities. `operation` and `call` are unique
opaque identifiers; they are never reused. Other digests identify exact retained
documents. Evidence is streamed and checked before a write or successful read;
missing/changed originals fail. Only admitted event data, including the inline
public recovery decision, enters new Git objects; separately retained originals
are not copied wholesale. A matching digest proves bytes, not their authority
or truth.

| Type | Additional fields and meaning |
| --- | --- |
| `enroll` | `location`, `writerPolicy`, `priorEffects`: admitted binding, writer policy and preceding-effects reconciliation |
| `open` | `operation`, `plan`, `candidate`, `authority`, `owner`, `window: {start, deadline}`, `effects`: admitted plan and ordered nonempty unique list of exact intended-call document identities |
| `intent` | `operation`, `call`, `effect`: new call attempt bound to one admitted effect |
| `observe` | `operation`, `call`, `outcome`, `basis`, `evidence`: identified observation of that call |
| `close` | `operation`, `result`, `evidence`: completed or abandoned operation, with retained evidence |
| `handoff` | `decision`, `approval`: frozen administrative decision and retained authenticated-approval attribution digest; only through the recovery command |

The plan identity is SHA-256 of the canonical `planBytes(openEvent)` encoding:
`{schemaVersion: 1, operation, candidate, authority, owner, window, effects}`.
Changing any binding without a different plan is rejected. `candidate` refers
to retained candidate evidence, not necessarily an archive's own hash; the
publisher's admission verifies the actual archive, source, proofs and claims.
`authority`, `owner`, each intended-call document and observation/closure evidence
must retain verifiable originals. This recorder checks their byte identities;
the separately trusted actor must validate their actual meaning and authority.

## Replay preserves uncertainty

Only one operation may be active. Opening requires the preceding operation to
be closed or explicitly retired, with no blocking unresolved call anywhere in
history. An intent starts `unknown` and blocks by default. No next call or
closure is admitted while any blocking unresolved call remains.
An intent must fall within its operation's window, and the writer's current
clock must still be within that window; backdating cannot renew it. Observations
and closure may follow the deadline. Event instants never go backwards.

Observation outcomes are `unknown`, `verified-effect` or `verified-no-effect`;
bases are `call`, `destination` or `reconciliation`. Destination presence may
record only `unknown`. Contrary verified outcomes produce `conflict`; only an
explicit reconciliation can resolve that conflict. New unknown observations
remain unresolved. Observations of older, closed operations remain admissible
and can block current/future work; their original closure stays historical
evidence, not a substitute for the current unresolved-call state.

A verified effect cannot receive another intent. A verified no-effect can
permit a distinct call under the still-valid plan/window. Older retry
observations do not erase a separately verified successful call. `completed`
requires every planned effect to have a verified successful call. `abandoned`
may preserve partial successes, but neither closure accepts unresolved calls.
Neither result grants permission to reuse a registry version or retry effects.

Each commit contains exactly one regular `checkpoint.json`: schema version,
one event and a small derived checkpoint (sequence, event digest, active
operation and unresolved/conflict counts). Legacy frames/checkpoints stay
version 1 byte-for-byte. The handoff and every subsequent stored frame use
version 2, adding `blockingUnresolvedCalls` and `effectiveWriterPolicy` to the
checkpoint. Total unresolved calls still include retired UNKNOWNs. The reader
derives both counts, each operation's `writerPolicyAtAdmission` and retirement,
each call's actual `intentCommit`, and the effective policy from complete
history. `intentCommit` is reader-derived Git identity, not a caller field. It rejects premature version 2,
downgrades and checkpoint substitutions. Incompatible version-1 readers reject
the handoff; do not send them the new history as if it were compatible.
The root is parentless; every later
commit has exactly its preceding commit as parent. The reader replays complete
history from the pinned root, checks every frame/checkpoint and retains call
and operation identities. It does not trust only the latest checkpoint, merge
rival histories or accept shallow/missing history as clean state.

Replay retains metadata proportional to history and hashes retained evidence
documents once per distinct identity per invocation. These are control documents,
not implicit artifact or tensor inputs; no evidence is executed. Each invocation
traverses history, so a sequence of appends repeats prefix inspection. There is
no pruning, cached trusted replay, permanent-retention, timing or universal memory
claim. Operational use must keep that history/evidence workload in scope.

## Run explicit commands

After preparing and personally inspecting the exact canonical input:

```console
node scripts/release-record.mjs inspect --input public-input.json
node scripts/release-record.mjs enroll --config private-config.json --expected-head absent --input public-input.json --inspected INPUT_SHA256
node scripts/release-record.mjs read --config private-config.json --expected-head KNOWN_HEAD
node scripts/release-record.mjs append --config private-config.json --expected-head KNOWN_HEAD --input public-input.json --inspected INPUT_SHA256
```

These symbolic paths/identities are inputs, not operational configuration.
`--inspected` binds the supplied bytes to inspection; it does not confer
authority. `KNOWN_HEAD` is a required separately retained/observed full commit
identity. A different current head fails, including a rewind below that pin.
An unobserved administrative rewrite cannot be detected from an older root
alone. Keep required observation pins/history under qualified control.

New objects use fixed public recorder author/committer names/address, the
event's UTC instant, fixed message and the admitted frame; those Git identity
fields are not authenticated actors or independent time attestations.
Input, plan, original evidence, time and replay checks precede authored objects,
including objects whose subsequent reference update fails. The recorder writes
no recursive journal intent for its own Git call. Its own authority is the
separately enrolled writer policy and current caller authorization.

The Git client sends an explicit expected-old-head lease for only that branch,
and creates only a child of the observed head (or the explicit parentless root).
It never requests a history rewrite or relies on a tracking-ref heuristic. See
[Git's explicit lease semantics](https://git-scm.com/docs/git-push).
Local controls exercise the selected Git protocol; GitHub API fast-forward/blob
preconditions are not substituted for it. Actual server/protection and writer
enforcement still require separately authorized qualification. A successful
reference update is not a global publication mutex or exactly-once guarantee.

The recorder reads back the identified head and validates its record before
returning `confirmed`. A failed client exit with verified matching readback is
reported with that exit, not discarded. Failed/mismatched readback returns
`WRITE_UNCONFIRMED` with attempted commit/prior head and client result when
available. Inspect actual history before continuing; do not automatically retry.

Commands emit one public-safe JSON result, exit zero on success and nonzero on
failure. `read` reports `observed`, never publication approval. Errors expose
bounded codes/receipts rather than private configuration, original contents,
paths or raw Git stderr. Ordinary completion/failure removes only its owned
temporary Git directory. Abrupt process/host termination can prevent cleanup;
inspect remote state and identify any owned leftover separately. No receipt or
free runner slot proves that a canceled writer did not commit.

The imported tooling API retains underlying process/system failures in the
error's `cause` for private diagnosis. Do not publish that object or raw stack;
the CLI deliberately emits only the bounded result above. The transport has a
finite per-command timeout, not a guarantee of server-side cancellation.

## Apply an explicit administrative recovery

`scripts/release-record-recovery.mjs` owns exceptional preparation/application;
the ordinary publisher never retires an operation automatically. Generic
`release-record.mjs append` refuses `handoff`: an input claiming approval is
insufficient. The imported protocol accepts an authentication callback only
from its separately trusted controller, not as a public authorization claim.

The canonical decision has exactly these fields:

| Field | Binding |
| --- | --- |
| `schemaVersion` | `1` |
| `root`, `expectedHead` | Exact 40-character Git identities |
| `prefixSha256`, `sequence` | Complete replay prefix: start with SHA256 of canonical `{schemaVersion:1}`, then hash canonical `{previous: PREFIX, event}` for each event |
| `operation`, `candidate` | Exact expired operation and candidate identities |
| `calls` | Nonempty call-sorted unique `{call, intentSha256, observationSha256}` list covering **all** its unknown calls; an unobserved intent cannot be retired |
| `previousWriterPolicy`, `nextWriterPolicy` | Exact prior and prospective authority identities |
| `window` | New canonical `{start, deadline}`, beginning after the old operation expires |
| `evidence` | Nonempty unique list of retained, inspected public-safe document digests supporting recovery |
| `risk` | Exactly `late-shared-effects` |

Use `prepareRecoveryDecision` on the complete reader result to construct these
bytes; preparation below checks them against the actual current prefix again.
No self-asserted field authenticates its evidence. An operation containing a
conflict fails; a changed prefix or full observation needs another decision.

The prospective policy is a closed canonical document:
`{schemaVersion:2, kind:"release-recorder-role", location, writer,
mainRulesSha256, recordRulesSha256, bypassAllowed:false, writerExcludedFrom,
sourceAdmission}`. `location` is the existing location identity; `writer` is
`qualified-publication-record-role`, `writerExcludedFrom` is exactly
`["build","consumer","npm","signing"]`, and `sourceAdmission` is
`exact-qualified-approved-recipe`. The two rules hashes identify the canonical
parsed active GitHub ruleset responses with no bypass actors. Exact recipe
admission stays in each run's private policy/qualification, outside this stable
role descriptor. Qualification of real enforcement is still required.

Separately inspect/admit a **private canonical profile** and its SHA-256. Its
closed fields are `schemaVersion:1`, `repository`, numeric-string `repositoryId`,
`ownerId`, `issue`, `maintainer:{id,ownerSha256}`, `sourceRevision`, exact
`nodeVersion`/`nodeSha256`, `configSha256` (canonical configuration),
`nextWriterPolicy`, `rules:{main,record}` (numeric-string ruleset IDs),
`qualification:{sha256,expiresAt}`, and the exact decision `window`. The owner
must match the retired admission. The finite qualification original and admitted
profile are trusted inputs under the release policy, not facts proven by a
local hash. They cannot install/extend their own grant. Keep configuration paths
absolute in this command. The CLI requires its exact clean maintained checkout,
current GitHub main/source, active rulesets, repository IDs, qualification bytes
and window. It never changes settings or credentials.

With the existing qualified Git writer/helper and explicit `GH_TOKEN` available
only to the maintainer controller, run:

```console
node scripts/release-record-recovery.mjs prepare --profile PRIVATE_PROFILE --profile-sha256 PROFILE_SHA256 --config PRIVATE_CONFIG --decision DECISION --decision-sha256 DECISION_SHA256 --qualification PRIVATE_QUALIFICATION --output NEW_PRIVATE_PREPARATION
```

Inspect the prepared decision and exact approval text:
`tabgrad-release-recovery DECISION_SHA256 ROOT/EXPECTED_HEAD`. The designated
maintainer posts precisely that text to the admitted issue within the new
window. Issue/repository selection and credential use require their operational
authorization; preparation is not approval. Use the numeric comment ID only as
a locator:

```console
node scripts/release-record-recovery.mjs apply --profile PRIVATE_PROFILE --profile-sha256 PROFILE_SHA256 --config PRIVATE_CONFIG --decision DECISION --decision-sha256 DECISION_SHA256 --qualification PRIVATE_QUALIFICATION --output NEW_PRIVATE_APPLICATION --comment COMMENT_ID
```

The existing bounded fixed-origin GET transport checks the actual comment's
repository/issue, exact body, stable author ID, current admin/maintain permission
and timestamps. Source/protections/qualification/time are checked again around
authenticated reads; approval is rechecked before object creation and before
the leased update. A changed/denied/missing response fails closed. This is not
an atomic snapshot or a signature of the maintainer; it retains the trusted
controller and service assumptions. It does not revive the old CI run.

Each attempt claims a new private output directory; an existing one is refused.
It conserves the exact profile and qualification plus authenticated **parsed**
provider responses and approval body in `private/`, never claiming raw HTTP
preservation. Only canonical decision/enum/digest attribution documents go in
`public-evidence/`. The holder binds decision/profile/comment/actor/permission
digests, source and observation/expiry instants; it cannot authenticate itself.
Keep private originals available independently; never copy the whole output into
public history. Inspect new public originals before any later public transfer.

On confirmed readback, retain `receipt.json` and adopt `next-config.json` with
the same root and the new effective policy, including all old/new evidence paths.
Combine only inspected hash-named public originals for the next history handoff.
On failure, preserve `failure.json` and any attempted/prior heads. A push may
already have committed, including when local receipt/config conservation fails.
If even the failure file cannot be written, the bounded CLI failure still emits
the known receipt with `conservationFailed:true`; retain it independently.
Inspect the actual head and originals before another action; never automatically
retry, enroll or reset. The command issues no npm/GitHub distribution effects.

Replay retires the operation/candidate and its uncertain effect identities,
clearing only that operation's active slot. Its UNKNOWNs remain visible.
Repeated identical accepted observations remain nonblocking; a later changed
unknown observation (even with the same evidence), conflict or fresh intent
blocks. A different release still uses the ordinary current approval, unused
version and destination checks. Accepted risk is limited to the exact frozen
facts, not future shared-channel drift or a general waiver.

## Qualify the remaining operational boundary

Before publication relies on this record, qualify the actual enrolled writer,
repository/ref/environment protections and bypasses, identity/authority checks,
complete retained history/original evidence, actual transport/readback and
publisher integration under the release policy. Keep write authority away from
build/consumer/signing code and npm identity. A saved setting, author string,
schema result, local fixture or this tooling's merge establishes none of those
real-service properties. Missing required qualification keeps admission closed.
