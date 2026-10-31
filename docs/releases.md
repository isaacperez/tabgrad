# Versions, releases, and migrations

This document defines how Tabgrad turns verified repository work into a public
version and how users are told about changes. A merge is not automatically a
release, and an artifact uploaded from an unverified local tree is not a
Tabgrad release.

The release maintainer owns these rules and the public human procedure.
The maintained [publication procedure](reference/release-publication.md) supplies
the command/role details without replacing the authorization and trust rules here.
Maintain a separate thin agent adaptation that guides contributors through
these primary rules and actual documented tools; it must not create another
policy or grant permission. Human contribution and public-clone use do not
require that adaptation. Its maintainer is responsible for keeping it aligned;
both roles may be held by the same person.

Approved design establishes constraints, not evidence of working commands,
effective service settings or a qualified release. Use
[`development.md`](development.md) for available commands and tool versions,
[`continuous-integration.md`](continuous-integration.md) for configured CI and
permission-registration rules, and the release's own observations for its
installation and support claims.

## Version public artifacts

Use Semantic Versioning for each public Tabgrad artifact. Prefix the complete
release version with `v` for its repository tag, including a pre-release suffix
when applicable. Independently versioned packages require a documented version
mapping and release ownership. The
[browser distribution](architecture/browser-distribution.md#one-public-version-identifies-the-matched-set)
uses one version for its cooperating package and static files, distinct from
private protocols and interpreter admission versions.

Before `1.0.0`, increment the minor version for compatible features or a breaking
public change, and the patch version for a backward-compatible correction. From
`1.0.0`, follow the ordinary Semantic Versioning meanings: major for breaking
public changes, minor for backward-compatible features, and patch for
backward-compatible fixes. Version `1.0.0` commits to stability of the documented
public API; it does not mean complete PyTorch coverage.

Do not infer compatibility solely from a version number. Record supported
interfaces, environments and differences in
[`compatibility.md`](compatibility.md). An internal implementation file does
not become public API because an artifact includes it.

### Admit a useful documented scope

Select a coherent useful scope whose documentation, applicable checks and
qualified artifacts agree. A defect invalidating that scope prevents admission;
an unrelated open issue does not automatically prevent release. Preserve the
documented operation, signature, shape, frontend/backend and environment
boundaries rather than generalizing from one successful example. Device
availability, numerical compatibility, resource use and speed are separate
claims.

A pre-release must meet the quality requirements for its declared scope and use
an explicit preview distribution tag. Becoming an ordinary release changes
public metadata and requires its own identified, qualified artifacts. Moving
an npm distribution tag only selects an already published version; it does not
create or qualify another version. Select npm channels and GitHub release type
and latest designation explicitly; one service's designation does not establish
the other's state.

### Maintain the released boundary

Maintain the default branch and respond to defects and security problems in the
latest ordinary release through corrected releases from protected `main`.
Classify every included change: if `main` has advanced, a correction can require
a minor release and migration guidance. Do not describe that combined change as
a compatible patch merely because its motivating defect is small.

State support transitions, affected and corrected versions, mitigation and
migration in the
[release record](compatibility.md#contents-of-a-release-record). State the status
and replacement of active pre-releases as they are superseded. Follow the
existing deprecation rules and [`SECURITY.md`](../SECURITY.md); there is no
automatic backport branch, LTS commitment or new grace period. Reconsider the
maintenance commitment before adopting `1.0.0`.

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
branch. A separately authorized, reviewed release change must establish:

- the exact version, public package metadata and included pull requests;
- compatibility, maintenance and supported environments for the release;
- updated changelog, migration notes, documentation, and license notices;
- reproducible dependency resolution and generated files;
- passing required checks for the release commit;
- successful creation and inspection of every distributed artifact;
- artifact names, checksums, provenance, and publication destinations;
- known limitations and unresolved security or correctness concerns; and
- the person authorized to publish.

Select the resulting exact commit. A later correction on `main` cannot repair an
older candidate's contents or documentation. Build artifacts through documented
automation from the release commit; never publish from a dirty working tree.
Public name, version and other package metadata belong to that reviewed source,
not to an edit of an already approved archive.

### Preserve the qualified bytes and their producer evidence

Keep the selected source's preparation tools separate from the publishing
client environment. Qualify the actual tools and their interoperability before
relying on them; a version label or an accepted candidate toolchain is not that
evidence. Preparation and consumer execution have no publishing authority.
Record exact client/runtime versions, origin/integrity and action commits in
reviewed configuration under the
[dependency](dependencies.md) and CI rules; floating aliases or unqualified
fallbacks cannot silently select a replacement.
Reuse earlier checks only when their relevant inputs and bounded claims still
apply. The final artifact must receive the installation checks required by its
own claims.

Retain the original archive, matched static content and inventory, source and
recipe identities, tool/run identities and applicable evidence. Qualification,
approval and publication must refer to these same bytes. Do not rebuild, repack
different bytes or edit metadata after approval. A checked exact copy is valid;
lost originals must not be silently reconstructed.

Provenance is an authenticated statement about an artifact's producer, source
and preparation. Its subject is the artifact the statement identifies; a proof
bundle retains the statement and the verification material needed to inspect
its signature and issuer. Producer evidence has two distinct subjects: the
npm-compatible archive with a Package URL identifying its npm name/version and
SHA-512 digest, and the canonical inventory with its SHA-256 digest. Canonical
inventory identity refers to its exact qualified encoding, not merely equivalent
parsed fields. Retain both original proof bundles. The publishing client
consumes the producer's npm-compatible provenance bundle
rather than replacing it with a statement under the publisher's identity.
Checksums establish content identity; they do not by themselves authenticate
the producer.

The producer chain must truthfully bind actual controlled preparation to its
source. OpenID Connect supplies a short-lived identity token for a workflow
execution; its claims assert that execution's source and context. In the selected
default provenance mode, the actual checked-out build commit, statement source
digest and matching OpenID Connect source claims must
agree. Authorize the signer's own recipe separately. Qualify actual bundle
claims, action/client behavior and consumer verification; do not infer them
from an action's name or a matching transport digest. A material mismatch
requires reconsidering the mechanism, not manufacturing a producer claim.

Launch the signing job for the same preparation run only after its unprivileged
qualification gate succeeds. Recheck the final archive and inventory against
the qualified producer outputs before requesting a signing certificate or
sending a signature/attestation. A later check inside an already privileged job
does not replace the gate before launch; permissions are job-scoped.

Verification must check signatures and allowed issuer, repository, source/ref,
reviewed signer recipe, run/attempt and statement type/claims against the plan
and trusted CI evidence. Recompute the complete allowed file set, sizes and
hashes from the retained archive and static payload, rejecting additions,
omissions and mismatched name/version/source pairing. Keep this verification in
release/integration tooling; ordinary tensor execution and browser imports must
not acquire provenance-service requests.

The signer neither runs build/consumer code nor receives npm publishing identity
or GitHub Contents-write authority. Its qualified workflow/environment trust
boundary must exclude the configured npm publisher. A different OpenID Connect
audience alone does not establish that isolation. Register exact permissions
under the CI policy before adding a privileged workflow.

### Conserve identified handoffs

Use two identified temporary Actions outputs: preparation data contains the
original archive, inventory/record and qualification evidence; signing proofs
contain the original bundles. The frozen producer record cannot contain its
own outer artifact ID/transport digest or future proof IDs. A later approval
binds both exact output IDs and transport digests, source/repository,
producer/signer workflows and revisions, run/attempt, payload digests and
effective expiry without rewriting that record. Distinguish the initial
preparation-to-signing handoff from transfers of a signed candidate. Verify
the sender, source, run, artifact identity and applicable authenticated claims
at each boundary; a download checksum alone does not supply those claims. The
initial handoff verifies the frozen data output and qualification before
signing; it cannot require future proof IDs, signatures or publication approval.

Request 90 days of temporary retention, subject to qualification of the effective
policy, quota, access and expiry. This is a requested availability period, not a
waiting period before releasing or proof that the whole period was observed.
Record each output's effective expiry. Approval must have a finite deadline no
later than the earliest artifact/evidence expiry, with applicable checks still
valid at use. A shorter effective period requires an accepted operational
adjustment, not an assumed 90-day guarantee. Deletion can remove outputs sooner.
Treat candidate payloads as downloadable before release by signed-in repository
readers; qualify access and include that public exposure in preparation approval.
Proof records and public metadata can also be visible before a package exists;
those uploads and their exact inspected payloads require their own authority.

After npm verification, retain final assets, proofs and evidence on the release,
qualifying immutable-release protection before relying on it. Preserve the
applicable evidence references before freezing assets. Derive the final static
tree from the verified archive. Neither temporary retention nor final assets
promise permanent storage or recovery after every host/admin action.

## Authorize and coordinate publication

A designated maintainer approves a concrete plan identifying exact source,
candidate, recipe, version/channel, tag association, notes, support claims,
destinations and allowed actions. Keep sensitive destination/account details in
separately authorized private configuration or records. A source-only approval,
merge, passing CI, dispatch or rerun does not authorize publication by itself.

Tagging, signing, uploads, creating a GitHub release, publishing packages,
changing channels or settings, updating a website and announcing a release are
separate external mutations. Perform only the actions the current authorization
covers. Approval may be given by the person initiating dispatch; do not describe
that as independent human approval. Independent technical review remains
required.

Use one approved `workflow_dispatch` entry for ordinary registry publication.
A release event must not start another publisher. Revalidate mutable authority,
source/candidate identities, evidence and known registry/GitHub-completion
blockers before effects. Resolve effective registry, package identity,
channel/dist-tag and visibility, including package/configuration/environment
overrides; any visibility change is an approved effect. Publish only the
identified archive, never a workspace/tree selected by directory defaults.

Before npm, compare actual package/version/channel and GitHub tag/release/draft
state with the plan's expected starting state. Use sufficient authorized
visibility, paginate where necessary and resolve tags to their commits. A
timeout, inaccessible draft or unexplained absence/404 is unknown, not permission
to create. After waiting/approval and immediately before each relevant effect,
revalidate current authority/expiry, handoff identity, expected destination
state and mutable prerequisites; reuse still-applicable immutable evidence.

Keep GitHub draft inspection outside the npm identity. After the client has
prepared its exact inputs and read its registry/namespace state, a separate
qualified GitHub writer role checks current authority, the original intent/head
and the GitHub destination. The client authenticates that observer's permission
for its exact readiness, plan, call, source, run/attempt and window before
dispatch. Repository permission projections, a packet's claimed issuer or an
empty listing from an arbitrary reader do not establish sufficient draft view.
Qualify the writer role's actual view; denied or unknown observations fail closed
without upgrading the npm role or substituting an earlier successful check.

The existing call and record protocol remain unchanged. Bind a packet's canonical
SHA-256 to the exact provider job and its successfully completed upload step;
pending step metadata supplies no completed proof. Corroborate artifact identity
separately and verify transported bytes. Independently held exact expected bytes
may instead be matched to that authenticated emission; distinguish them from
downloaded originals. The human controller conveys its actual child's readiness
through the admitted maintainer-attributed channel, retaining the trust in that
maintainer/controller rather than treating a comment as mechanical proof of
local execution. The [publication reference](reference/release-publication.md)
defines the concrete profiles and evidence.

Claim the owned execution session before waiting or checks can conceal a previous
attempt. An unavailable or repeated session is unknown, including when its
permission disappears, authority is revoked or the window expires. Only a sole
admitted attempt can establish its own failure before dispatch. Preserve that
claim for the session lifetime; copying inputs or losing local state supplies
no distributed exactly-once guarantee. The human parent owns the child's private
working directory and retires it after observing child close, including forced
termination; abrupt loss of the parent or host still needs explicit recovery.

Use one fixed repository-wide concurrency group across versions, channels and
completion/resumption requests, held from admission through final inspection
without release between npm and GitHub jobs. Do not cancel an active publisher
for a newer request. Keep at most one waiting attempt without promising dispatch
order; a larger queue requires an explicit change of this policy.
Replacement of a waiting request does not transfer its approval. Coordinate
human bootstrap and other actors with the same publication window, responsible
owner and deadline. Bound waiting/admission by that finite deadline; the owner
closes an invalid pre-write execution without automatically canceling a
publication that may already have written.

A free runner slot does not settle an earlier remote call. Qualify effective
job/ref/environment/reviewer and bypass enforcement; job labels or saved
configuration do not prove those controls. Restrict both the workflow reference
and the supplied source: environment branch filters apply to the workflow's
`GITHUB_REF`, not an arbitrary source input. Missing required protection stops
admission; do not create an unprotected environment as a fallback.

### Record intent and observations durably

The [release record reference](reference/release-record.md) defines the maintained
data format and recorder/reader commands. Their local protocol controls do not
replace the operational qualification required here.

Use a dedicated protected Git control branch, outside library source, builds
and signing inputs, for a small checkpoint and its commit history. A separate
trusted recorder has early repository Contents-write authority and no npm
credentials or npm publishing identity. Do not treat its credential as
branch-scoped merely because the recorder intends to update one branch.

Enroll the trusted root/location separately: identify the initial trusted
record, its location and the authority allowed to write it. Reconcile effects
preceding enrollment. Confirm canonical intent before distribution effects and
record observations afterward. The record must identify the exact operation and plan,
applicable authority/evidence, responsible window/owner, calls and outcomes well
enough to distinguish completed effects from an unresolved write. Later
completion observations belong here even when release assets are immutable.
Parse the record as bounded-schema data using the approved reader/recipe; never
execute it, check it out into preparation/signing or package it as library input.
Record hashes do not replace authenticated producer evidence.

Keep only inspected public-safe metadata. Inspect Git objects before creation,
including objects whose reference update might fail; unreachable does not mean
private. An opaque approval identifier can replace sensitive values only while
its original verifiable authority is retained and available to the decision
that needs it.

Missing or untrusted roots/history must not cause an automatic reset. A Git
hash, author field or ancestry does not prove producer identity, complete
history or justified closure. GitHub reference-update fast-forward enforcement
and Contents API blob-SHA preconditions do not by themselves provide an
expected-old-head compare-and-swap for the whole reference or a publication
mutex. Do not generalize this limit to every Git primitive. Qualify effective
writer/protection and evidence controls
before using this record to admit publication. Do not claim
resistance to all privileged host/admin changes. The recorder's own writes
have their own authority and readback boundary; do not create recursive intents
for every journal write.

### Admit a forward recovery without erasing uncertainty

An expired call with an unknown outcome normally blocks further publication.
A matching package or a separate successful manual delivery does not establish
the outcome of that original call. Preserve its intent, observations, UNKNOWN
and original writer grant. Do not reset the root, rewrite frames, invent a
successful closure or reuse the expired operation/candidate.

A maintainer may explicitly accept a narrow administrative retirement and
prospective writer-policy handoff. The canonical decision binds the exact
root/head and replay-prefix digest/sequence, operation/candidate, each unknown
call's intent and **complete last observation** digests, old/new writer policies,
finite new administrative window, retained evidence and accepted risk of late
shared effects. An authenticated current maintainer approval must name that
exact document digest. The [recovery command](reference/release-record.md#apply-an-explicit-administrative-recovery)
checks current source, qualification, protections, attribution and prefix before
the existing leased Git append. An approval flag, old run/environment approval
or destination read cannot replace those checks.

Retirement changes the blocking disposition of only those exact unknown
observations; it never changes their outcomes. The retired operation/candidate
and uncertain effect identities cannot be reused. A different useful release
needs its own current plan/window, unused registry version, producer evidence,
approval and destination checks. A new UNKNOWN, conflict or changed unknown
observation becomes blocking, including the same evidence under changed
observation context. Conserve late authenticated facts; retirement is not
permission to ignore them. Genuine causal settlement keeps its ordinary meaning.

Keep the enrollment writer policy as the initial authority epoch. Record the
explicit effective policy for later operations and validate each old authority
under its admission epoch. A stable qualified recorder-role/protection grant
may outlive a recipe revision; each new run must still pin and qualify its exact
current source, tools and authority separately. A policy handoff does not
qualify a new credential, extend an old window or grant unattended publication.

This accepts residual risk: an old provider request could affect shared channel
metadata later. Fresh destination checks detect observed drift but cannot prove
provider quiescence or atomicity across npm and GitHub. Reassess changed facts
under a new explicit decision; never retry an uncertain append automatically.
The maintained command and local Git tests do not perform or qualify a live
migration. Actual service changes/publication retain their concrete authorization.

Keeping the old blanket block would prevent forward progress without stronger
causal evidence. A new root would fragment history; relabeling the call would
assert an unproved result. The append-only disposition preserves that evidence
and admits only the separately accepted risk, at the cost of versioned readers,
policy epochs, retained approval originals and an exceptional administrative step.

### Authenticate each actor

Use restricted CI OpenID Connect identity for ordinary npm publishing, without
a standing write token or silent credential fallback. Qualify the actual trusted
publisher binding and isolation. GitHub completion uses the job's
`GITHUB_TOKEN`; it is not a release-only or journal-only credential. Never expose
write authority to build/consumer code or untrusted pull requests.

When the package does not exist, the designated maintainer first publishes the
real approved archive using interactive authentication and two-factor
authentication. Verify that publication, then continue the approved remaining
CI actions. Do not create a fictitious package version to test publishing.
Human bootstrap does not qualify later CI authentication. Coordinate trusted
publisher setup with its first useful authorized CI publication and the
provider's documented first-success deadline; a settings save is not success.

Human publication preserves the real terminal through the controller and npm
child so that npm owns its MFA interaction. Its identified, archive-bound call
is confirmed by an observed zero process exit without a signal or controller
failure. This deliberately avoids a second terminal transport and transcript
parser; the npm JSON metadata is not an independent server receipt. CI retains
its captured package-specific JSON confirmation. Exact registry, provenance
and consumer checks remain separate and mandatory before GitHub completion.
Nonzero exit, timeout, cancellation or lost observation stays uncertain even
when a later destination read matches. The human terminal output is not
automatically retained or subject to a capture-byte limit; the
[maintained procedure](reference/release-publication.md#first-absent-package-publication)
defines the retained process evidence and its limits.

### Complete npm before making GitHub public

After the approved npm action, install the documented exact package version
from the intended registry in an outside application with an isolated cache.
Check the resolved version, fetched archive identity, installed contents,
integrity, channel and provenance against the approved originals. Also qualify
the supported supplied-archive path with the identified downloaded archive,
sharing consumer assertions and applicable results between the two routes.
A local archive installation alone does not establish the registry path.
Bind the bytes
actually installed, not merely a pathname hashed before and after use. Run the
applicable external consumer profiles against those bytes; rebuilding another
candidate does not verify this publication.

Only after npm verification perform authorized public GitHub completion with
the exact tag/source, release type/latest designation, notes and retained final
assets. Earlier candidate/proof downloads do not authorize an early public
GitHub release. GitHub completion after npm is a recoverable sequence, not an
atomic transaction across services.

## Recover without hiding partial effects

Inspect identified destinations and actual client calls before retrying.
Preserve verified completed effects and continue only authorized remaining
effects. A final error, cancellation or matching destination state does not
prove a known call outcome or absence of effects.

Unknown writes, unresolved retries/in-flight requests and missing required
history/evidence keep admission closed. Inspect and reconcile the previous
operation before starting another; freeing a concurrency slot or rerunning a
workflow does not renew authority or erase uncertainty. Preserve evidence of
failures and contrary observations.

Never newly publish a used or withdrawn version. Verified matching existing
effects may support continuing an approved partial operation without publishing
them again. Conflicting state requires a separately approved repair or release
plan, not replacement of an existing version. Recover lost originals only from
a qualified exact copy under applicable authority.

Cleanup of an understood, owned empty draft asset must be conditional, exact and
verified. Do not broadly clobber another asset or mutate frozen release content.
Channel repair, withdrawal, settings changes and other recovery effects require
their own applicable authority. Missing journal history must not be replaced
with a fabricated clean state.

## Verify installation and migration

Test each supported installation path from the published or release-candidate
artifact, not only from repository source. Exercise a minimal public example
and any backend or browser capability the release claims. Preserve application
hosting, optional Python ownership, explicit device selection and cleanup under
the [distribution contract](architecture/browser-distribution.md).

Versioned documentation and examples must identify the actual package/static
artifact, source and support record they describe and consume. A later document
on `main` cannot establish an older release's behavior. Preserve complete matched
updates/restores; no universal mixed-release detection follows from protocol
versions or asset hashes.

For a migration, test the documented steps from every supported starting
version that materially differs. A migration must be safe to interrupt or must
explain its recovery procedure. Record irreversible effects and backup needs
before release.

### Qualify mechanisms before claiming readiness

Keep three evidence boundaries distinct:

1. Isolated controls observe actual requests, bytes and effects for valid and
   invalid input, stale authority, mismatches, repeated/concurrent/canceled
   attempts and material partial-failure interactions. A model or mocked success
   alone does not prove the client or workflow.
2. Specifically authorized real-service checks qualify actual Git writers,
   tokens, protections, source/proof claims, handoffs and workflow bindings.
   Identify fixtures, actors, permissions, public outputs and cleanup before
   effects; keep operational access and configuration private. Isolated clients
   must not escape to real credentials or services. Exercise actual dispatch,
   approval, global queue and handoff wiring in specifically approved disposable
   fixtures, without invoking an npm publisher or using publishing credentials;
   preserve the differences from production bindings. Configuration inspection
   alone does not supply this workflow evidence.
3. Useful authorized publication and verification establish the corresponding
   real delivery and authentication claims. Human first-package success remains
   different evidence from the first useful CI OpenID Connect success.

Use the actual selected client/action and environment, not only a version name.
Inspect known completion prerequisites before irreversible npm effects, while
retaining recovery for later failures. Preserve original evidence and safe
public derivatives as required by the
[publication policy](../SECURITY.md#publication-confidentiality). A material
feasibility failure returns the affected mechanism to investigation instead of
weakening its invariant. These controls establish no exactly-once, universal
compatibility, timing or resource guarantee.

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

## Design reasons and reconsideration

The [accepted release contract](https://github.com/isaacperez/tabgrad/issues/301#issuecomment-6187206148),
[combined evidence](https://github.com/isaacperez/tabgrad/issues/301#issuecomment-6186493760)
and [independent challenge](https://github.com/isaacperez/tabgrad/issues/301#issuecomment-6186497320)
support these boundaries. The material alternatives have different costs:

- Using public GitHub release publication as the trigger makes GitHub visible
  before registry success. Approved dispatch permits npm verification first,
  at the cost of explicit orchestration and recovery across two services.
- Staged registry publishing adds a promotion step and can create visible state
  or reserve a version. It is not a harmless dry run. Ordinary direct publication
  instead binds the approved exact plan to the restricted publisher.
- A shared upgraded build/publish toolchain is viable, but couples preparation
  changes to authentication needs. Separate qualified clients preserve source
  build inputs while requiring explicit handoff and interoperability evidence.
- Git checkpoint/history keeps the small control record with existing project
  infrastructure. It requires enrolled trust, effective protection and a separate
  writer, and does not provide a transactional lock or administrator-proof
  ledger. Another store remains viable if those qualified controls cannot
  satisfy the required evidence and recovery boundaries.
- Temporary candidate/proof outputs permit inspection before final publication;
  final immutable assets conserve the approved release afterward. This requires
  two checked transfers and accepts early public metadata without promising
  permanent availability.
- A late GitHub observer preserves the required check after client readiness
  while separating npm and GitHub-write authority. It adds coordination and
  retained handoff evidence; an earlier snapshot is simpler but can discover
  changes only after npm. Binding emission through completed job/step metadata
  preserves existing intent/call semantics; anchoring the grant in the record
  would change intent timing and require different custody, while reading logs
  needs its own availability/parser contract. None creates an atomic transaction
  across providers or establishes a temporal advantage. The accepted comparison
  and bounded evidence are recorded in [#355](https://github.com/isaacperez/tabgrad/issues/355).

Reconsider an affected mechanism when its actual client, claims, permissions,
retention or recovery behavior cannot meet this contract, or when a support or
maintenance change materially alters its assumptions. Preserve exact-byte
approval, producer evidence, separated authority and truthful partial results
when comparing alternatives.
