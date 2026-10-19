# Acquisition control record

This is an **internal experimental** contract for a local acquisition control
record. It is neither a public release record nor a producer-proof format.
The [release policy](../releases.md) governs release authority and trust.
These modules do not acquire trust, execute a client, authenticate observations,
sign, publish, or decide whether an operation may start or a result may be used.

## Owners and representation

`scripts/provenance-acquisition-record.mjs` owns encoding, decoding and structural
association. `scripts/provenance-acquisition-record-io.mjs` owns effective file
identity, positional transfers and bounded reads. Both are import-only modules
without import-time effects or environment configuration. They are outside
the browser distribution and do not depend on the offline provenance client.

There are four independent files, totaling 1 MiB:

| Role | Capacity, including LF | Writer |
| --- | --- | --- |
| `header` | 32 KiB | Supervisor, once |
| `progress` | 960 KiB | Supervisor, sequential events |
| `supervisor` | 16 KiB | Supervisor, once |
| `watchdog` | 16 KiB | Watchdog, once |

The header and endings are one compact JSON object followed by LF. Progress
is zero or more such lines; each event is at most 1 KiB including LF. Objects
are flat, with exactly the listed own fields. Values are strings or `null`.
There is no whitespace outside strings, escaping, nesting, duplicate key,
extension field, free error text, URL or path. Keys are ASCII, at most 32 bytes;
strings are ASCII, at most 64 bytes, without quotes, backslashes or controls.
The field lists are below the profile maxima of 64 header pairs, 96 ending
pairs and 10 event pairs; unused capacity does not authorize new fields.

Order of keys is unrestricted. Encoding preserves the supplied key order;
decoding and association never replace original bytes with a re-encoding.
`acquisitionSha256(bytes)` hashes precisely the supplied bytes. Padding in a
reserved file is not record data and is never included in its data hash.

## Scalar types

| Type | Representation |
| --- | --- |
| Token | 32 lowercase hexadecimal characters; operation and opaque authorization reference |
| Hash | 64 lowercase hexadecimal characters, SHA256 of retained original evidence |
| Uint | Decimal string, `0` or no leading zero, at most 20 digits and at most 18446744073709551615 |
| UTC | Calendar-valid `YYYY-MM-DDTHH:mm:ss.sssZ`, years 0000–9999 |
| Closure | `confirmed`, `unconfirmed`, `unknown` |
| Verdict | `passed`, `failed`, `unknown` |

`null` is distinct from zero, success and observed absence. Nullable fields
below require the field to be present. References identify bytes; they do not
authenticate them or instruct the module to fetch them. `authorizationRef`
is an opaque token, never a private plan or its hash, and is not proof of authority.

`atNs` and fields ending in `AtNs` are elapsed nanoseconds from the same admitted
T0. `t0MonotonicNs` is the origin reading. The caller owns actual clock
correlation and observation. UTC expiry/deadline summaries must conservatively
project more precise originals toward the past; the module validates the date,
not that derivation, current validity or timeliness of a later handoff.

## Header

All fields are required:

| Fields | Type or fixed value |
| --- | --- |
| `recordType`, `state` | `acq_header_v1`, `pending` |
| `operationId`, `authorizationRef` | Token |
| `profileSha256`, `recipeSha256`, `inputEvidenceSha256`, `toolEvidenceSha256` | Hash |
| `priorStateMode`, `priorStateSha256` | `initial` with null, or `continuation` with Hash |
| `declaredLimitsSha256`, `clockEvidenceSha256` | Hash |
| `t0MonotonicNs` | Uint |
| `startedUtc`, `deadlineUtc` | UTC |

The header remains pending. It contains neither its own hash nor future
results. Declared limits are not evidence that resource controls are effective.

## Progress events

Exactly ten fields: `recordType` = `acq_event_v1`, `operationId` (Token),
`sequence` (Uint starting at 1), `atNs` (Uint), `phase`, `kind`, `subject`,
`code`, `reference` (nullable Hash), `value` (nullable Uint).

`phase` is `setup`, `acquire`, `observe`, `validate`, `freeze` or `close`.
`subject` is `operation`, `client`, `validator`, `group`, `network`, `storage`,
`stdout`, `stderr`, `supervisor`, `watchdog` or `custody`.

| Kind | Codes |
| --- | --- |
| `transition` | `begun`, `completed`, `failed` |
| `gate` | `permitted`, `denied`, `unknown` |
| `identity` | `observed`, `mismatch`, `unavailable` |
| `capture` | `confirmed`, `complete`, `lost`, `limit` |
| `resource` | `sample`, `limit`, `unavailable` |
| `deadline` | `checked`, `expired`, `shortened`, `unavailable` |
| `validation` | `passed`, `failed`, `unknown` |
| `containment` | `requested`, `observed`, `unconfirmed` |
| `liveness` | `observed`, `planned_end`, `lost`, `unknown` |
| `custody` | `checked`, `failed`, `unknown` |

`permitted`, `passed` and `checked` require a reference. The caller must also
retain pertinent external evidence for any other decision that depends on it;
the format cannot determine that dependency. No event authenticates its reference.
Sequences are contiguous and event elapsed times nondecreasing. Observed
over-limit counters remain representable; a diagnostic is not rejected merely
because the operation exceeded a declared resource budget.

## Endings

Common fields, all required:

| Fields | Type or vocabulary |
| --- | --- |
| `recordType` | `acq_supervisor_end_v1` or `acq_watchdog_end_v1`, matching role |
| `operationId`, `headerSha256` | Token, nullable Hash of exact confirmed header data |
| `atNs`, `observedUtc`, `phaseReached` | Uint, UTC, event phase vocabulary |
| `stopCode` | `normal`, `preflight`, `client`, `capture`, `validation`, `resource`, `storage`, `deadline`, `observer`, `controller`, `lifecycle`, `custody`, `protocol`, `unknown` |
| `firstStopAtNs`, `observationEvidenceSha256` | Nullable Uint, nullable Hash |

`firstStopAtNs` is null for `normal` or `unknown`; a known cause may have an
unknown time. A known elapsed observation cannot exceed the ending's `atNs`.
There is no fabricated global ordering between the two writers. A null header
hash permits a diagnostic before a header was established, never a complete
associated representation.

The supervisor adds the following required fields:

| Fields | Type or vocabulary |
| --- | --- |
| `clientState` | `not_started`, `running`, `exited`, `unknown` |
| `clientExitCode`, `clientSignal` | Nullable Uint; both null for not_started/running; do not derive a signal from an exit code |
| `stdoutState`, `stderrState` | `complete`, `incomplete`, `unknown` |
| `stdoutReceivedBytes`, `stdoutConfirmedBytes`, `stderrReceivedBytes`, `stderrConfirmedBytes` | Nullable Uint, payload bytes excluding transport framing |
| `stdoutSha256`, `stderrSha256` | Nullable Hash of a stable known confirmed prefix |
| `progressState` | `complete`, `incomplete`, `limit`, `unknown` |
| `progressConfirmedBytes`, `progressSha256` | Nullable Uint, nullable Hash |
| `preflightState`, `guardsState` | Verdict |
| `preflightEvidenceSha256`, `guardsEvidenceSha256` | Nullable Hash; required for passed |
| `validationState`, `validationEvidenceSha256` | `not_run` or Verdict; nullable Hash, required for passed |
| `inputWritersState`, `lifecycleState`, `caseClosureState`, `helperClosureState` | Closure |
| `resultEvidenceSha256`, `applicableExpiryUtc` | Nullable Hash, nullable UTC |
| `payloadCustodyState`, `payloadCustodyEvidenceSha256` | `checked`, `failed`, `unknown`; nullable Hash, required for checked |

Known confirmed payload counts cannot exceed known received counts. Complete
capture requires equal known counts and a hash. Any channel/progress hash
requires a known confirmed length. Complete progress requires length and hash.
A known prefix hash during an incomplete capture does not establish completeness.

The watchdog adds only `peerState` (`alive`, `planned_end`, `lost`, `unknown`),
`peerObservedAtNs` (nullable Uint), `containmentState` (`not_needed`, `requested`,
`observed`, `unconfirmed`), `containmentAtNs` (nullable Uint), `caseEmptyState`,
`lifecycleState` and `helperClosureState` (Closure). Known elapsed times cannot
exceed its `atNs`; `not_needed` has null containment time. Containment time is
the request observation, not physical termination time. Planned end or no need
for containment requires externally observed normal closure; the format does
not implement that protocol. An empty group alone does not establish lifecycle
closure. The watchdog cannot copy the supervisor's validation/capture truth.

## Data module API

`encodeAcquisitionRecord(role, record)` returns a Buffer after validation of an
own-data plain object (including a null prototype); accessors, symbols and extra
fields are rejected. `decodeAcquisitionRecord(role, bytes)` validates a bounded
Buffer and returns a null-prototype object. Neither coerces Uint strings to
JavaScript numbers.

`inspectAcquisitionRecord(parts)` receives role entries `{bytes, state,
uncertain}`. State is `pending`, `complete`, `incomplete`, `limit` or `unknown`;
`uncertain` is boolean. Missing parts and unconfirmed trailing lines remain
incomplete. Complete lines in an uncertain part can be decoded for diagnosis
but do not establish completeness. Invalid complete lines throw a format error.

The result `{formatComplete, records}` associates operation IDs, exact header
hashes, event order and reported progress length/hash when complete progress
bytes are available. An unavailable read is not treated as contradictory full
progress. Each role's records are
an array. A complete part must contain whole lines and exactly one header or
ending; complete progress may be empty. The result is representation status,
not trust admission: even two normal endings, valid references and complete
files cannot prove observations, current authority, effective guards, physical
process closure, successful validation or custody of future bytes.

## File I/O API and failure behavior

`openAcquisitionRecord({root, destinations, transfer?})` receives a canonical
absolute owned directory and exactly four role entries. Each destination is
`{name, identity: {dev, ino}}`: a basename and expected native identity as
decimal strings. `acquisitionFileIdentity(bigintStat)` obtains that identity
from a prepared file's stat. The preparer owns initial emptiness and allocation.
Do not reuse a reservation containing another operation's history.

Opening uses no-follow, non-append, non-truncating flags, checks regular type,
one hardlink, exact logical capacity, expected effective identity and distinct
identities of **all four** destinations before handing out any writer. The root
is checked before and after opening. Unknown identity, an alias, link or mismatch
rejects the set before data transfer and closes every owned handle. This is a
boundary within an owned directory, not isolation from a hostile filesystem
mutating its namespace concurrently. Logical size, zeros and `truncate` are
not proof of physical allocation, durability, quota enforcement or free space.

The result has `writers.header`, `.progress`, `.supervisor`, `.watchdog`, each
with `write(record)`, `snapshot()` and asynchronous `close()`. Only progress has
a usable `finish()` operation, marking the explicitly finished event stream.
Hand each external actor only its own writer. `close()` on the set waits for
owned outstanding writes and closes all handles; it does not declare an
unfinished progress stream complete. Closing is idempotent and does not
establish an externally enforced shutdown deadline.

The set also has `readHeader()`, usable once after the header write completes
without uncertainty. It reads the known confirmed length on that **same open
FileHandle**, checks regular type, one link, capacity and identity before and
after reading, and never reopens by pathname. Length is checked before buffer
allocation. Known short reads advance within this range; failure is not retried
as another header read. Result is `{bytes, confirmedBytes, readBytes, state,
uncertain, readError}`. Invalid timing/concurrent use rejects with
`WRITER_STOPPED`, missing read support with `READ_RANGE`; admitted I/O failures
return unknown state and their known read prefix. Writing snapshots are not
rewritten to disguise a read failure. The read and identity checks are owned
pending operations, so close waits for them and excludes new operations.
The header writer also exposes this method; other roles reject it.

This readback establishes neither durability nor an independent watchdog
opening. The [local coordination interface](provenance-acquisition-control.md)
uses it without changing the JSONL representation or external trust domain.

Writes are sequential per role; concurrent writes/finish are rejected. Header
and ending writers stop after one emission. Known short writes finish the same
range; digest and offset advance only by confirmed bytes. Zero advance, thrown
I/O, impossible/unknown extent or a full part stops that writer permanently.
No later event, overwrite, reopen/retry or use of another role's reserve occurs.
A thrown transfer may have changed disk bytes beyond the confirmed prefix;
those bytes remain on disk with uncertainty preserved, not invented as data.

Snapshots contain `role`, `state`, `confirmedBytes`, `uncertain`, `firstError`,
`closeError` and `sha256`. The digest covers the confirmed prefix only, maintained
incrementally without repeated whole-prefix reads/copies. Lengths are bounded
local offsets, distinct from Uint diagnostic counters. An error preserves the
first cause; a separate nullable `closeError` preserves a close failure without
replacing an earlier write failure.

`readAcquisitionPart({root, role, destination, range, transfer?})` consumes an
explicit range `{confirmedBytes, state, uncertain}` after its writer has stopped.
The count must be a safe integer within that role's capacity or null for unknown.
It is checked **before** allocation/opening. Unknown length reads no bytes and
cannot have complete state. This reader checks identity again; neither file size
nor a search for zeros/valid JSON determines a data length. Results contain
`bytes`, `state`, `uncertain`, `confirmedBytes`, `readBytes`, `readError` and
cleanup counts. Short successful reads continue within the same bounded range;
zero/error/unknown extent preserves the known read prefix with unknown state.
Caller-supplied range metadata is not authenticated and cannot prove closure.

`transfer` is a trusted test seam for the FileHandle-style `read` or `write`
operation, not an untrusted plugin or alternative filesystem. Opening/type/
identity checks remain real. The applicable operation must return its confirmed
`bytesRead`/`bytesWritten`. In normal use omit the seam to use Node's transfers.

Failures use `AcquisitionRecordError` with a closed `code`/message:
`INVALID_RECORD`, `PART_LIMIT`, `OPERATION_MISMATCH`, `EVENT_ORDER`,
`HEADER_MISMATCH`, `PROGRESS_MISMATCH`, `FILE_ROOT`, `FILE_DESTINATION`,
`FILE_IDENTITY`, `FILE_ALIAS`, `OPEN_FAILED`, `WRITER_STOPPED`, `WRITE_FAILED`,
`WRITE_EXTENT_UNKNOWN`, `WRITE_NO_PROGRESS`, `CLOSE_FAILED`, `READ_RANGE`,
`READ_FAILED`, `READ_EXTENT_UNKNOWN`, `READ_INCOMPLETE`. Read transfer failures
are result diagnostics; invalid ranges/identity throw. Failed opens and reads
that throw include `{openedHandles, closedHandles}` in `cleanup`; failed close
attempts remain visible as unequal counts. Native error messages/paths/stacks
are not copied into diagnostics.

## Verification domain

The [focused development command](../development.md#configured-commands) checks
actual local files with synthetic data, independent literal vectors, short/
failed transfers, aliases, distinct reserves and bounded readback. Its logical
I/O counters vary event count and allowed payload independently; they do not
measure execution time, peak memory or resistance to physical storage failure.
These tests do not qualify a Linux acquisition laboratory, clock correlation,
external process supervision, trust material, custody, real signing or release
admission. Such a consumer requires its own admitted inputs and effective
controls; record-format validity cannot supply them.
