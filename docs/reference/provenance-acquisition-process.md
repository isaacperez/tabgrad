# Acquisition coordination across local processes

This **internal experimental** adapter starts separate Node supervisor and
watchdog actors and connects their own record files to the existing
[control protocol](provenance-acquisition-control.md). It runs no acquisition
client. Its domain is trusted local actors, ordinary owned files, Node IPC and
observations of the two direct children. It does not qualify an operational
Linux laboratory, process-tree containment or release admission. The
[release policy](../releases.md) owns authority for operational effects.

## Responsibilities

`scripts/provenance-acquisition-process.mjs` owns launch, transport routing,
public-session admission, direct-child observation and collection.
`provenance-acquisition-process-actor.mjs` is the explicit child entry and owns
its local peer watch and shutdown. `provenance-acquisition-process-protocol.mjs`
owns the closed wire profile. Importing these modules launches nothing.

The shared `provenance-acquisition-actor.mjs` applies one actor's control
transitions and owned effects. Both the same-process session and process actors
use it; neither duplicates ending generation or action execution. The
[record I/O owner](provenance-acquisition-record.md#file-io-api-and-failure-behavior)
owns native openings, positional transfers, confirmed prefixes and file closes.

The parent is a trusted common transport and lifecycle dependency. Heartbeats
pass through it; each actor evaluates received peer observations independently.
This is process separation, not an independent physical containment route if
the parent, kernel or host stops. Actors run under the launching user's identity;
assigned paths/capabilities do not isolate a hostile same-user process from the
filesystem. No cgroup, Docker, systemd, network filter or operating-system
resource guard is installed or probed.

An explicit optional [host binding](provenance-acquisition-host.md) supplies
already prepared Linux group identities and direct per-actor routes. It does
not configure a host, launch a client/guard or qualify physical containment.
Without that binding the process-only domain below is unchanged.

## Creation and file delivery

`await createAcquisitionProcessSession(input, {forkActor?})` requires exactly:

| Input | Meaning |
| --- | --- |
| `root`, `destinations` | Existing acquisition-record owned-root and four-file identity contract |
| `header` | Closed v1 header, copied through its exact encoding |
| `supervisorContext`, `watchdogContext` | Independent control expectations; roles must match, operation/T0/deadline must agree |
| `timing` | Explicit local observation and cleanup intervals below |
| `host` (optional) | Closed prepared host profile with matching operation/origin and no longer observation horizon |

Context T0 is an explicit `process.hrtime.bigint()` origin no later than creation.
It must also match the header when checked by each actor. Header digest/profile
expectations are not learned from received bytes. Caller mutation after creation
does not change the frozen inputs. These clock readings and caller UTC values
are observations, not admitted native-clock/UTC correlation.

Creation validates inputs and opens all four distinct effective files before
any child launch or data write, then closes those preparer handles. Failure
rejects without launching. `start()` hands S only header/progress/S-ending paths
and expectations, and W only its ending path and own expectations. The
role-scoped I/O opener rechecks each assigned native opening; no other role's
writer is returned. Owned-directory assumptions still apply across the handoff;
there is no atomic namespace protection against a hostile host.

The default launcher uses the fixed actor module and prepared `process.execPath`,
empty `execArgv`, explicit empty `env`, no shell and ignored stdin/stdout/stderr,
with Node's JSON IPC channel. Node supplies its channel plumbing; caller
credentials, `NODE_OPTIONS`, PATH and other ambient configuration are not passed
through. `forkActor(role, entry, options)` is a trusted test seam returning a
ChildProcess-style owned handle with send/message/error/exit/close semantics.
It is not a configurable production launcher or an untrusted plugin.

## Session calls

| Call | Behavior |
| --- | --- |
| `start()` | Once: adopt both child handles and observe their native spawn events, initialize each actor, have S write/read its header, have W validate the original bytes, then deliver W's receipt correlated to S's readiness action. Resolves to snapshot, including failure state. |
| `supervisor.append(input)` | Same six closed progress fields as the local session. One public operation at a time; S supplies sequence and elapsed time. Resolves to snapshot. |
| `stop(role, code?)` | Immediately excludes admission, preserves the first parent-observed failure, notifies actors and begins once-only cleanup. Default `controller`. |
| `finish({observedUtc})` | One idempotent promise. Excludes new work, joins or accounts for admitted effects, requests actor endings/closes, observes children and collects confirmed prefixes. |
| `snapshot()` | Current bounded reports/child observations; no file reads and no implicit clock sample. |

Wrong/concurrent public calls revoke and reject with a closed diagnostic.
Start/append are unavailable after finish. Stop rejects after the final result.
A failed start, unexpected child/channel loss, deadline, protocol fault or failed
RPC automatically begins cleanup; automatic cleanup uses an explicitly
unqualified system UTC observation. Calling finish afterward retrieves that same
promise, rather than replacing its timestamp or retrying effects.

Stop is not queued behind a pending RPC or file operation. A child revokes its
control immediately and joins its own admitted I/O before writing an ending.
Cancelling a parent waiter does not cancel that I/O. At most one cancelled
request identity per child remains to account for a late reply; such a reply
cannot reopen admission. No ambiguous write, launch or message effect is retried.

## Local watch and wait profile

`timing` has exactly five positive integer millisecond fields, each within Node's
signed 32-bit timer range:

- `heartbeatMs < peerTimeoutMs`: send observations/check the peer and bound a
  command wait. Gaps in pulse IDs are permitted; repeated/regressive IDs are not.
- `termAfterMs < killAfterMs < closeWaitMs`: offsets from the first cleanup
  request for TERM, KILL and the final local wait observation.

These are explicit protocol/test limits, not measured sensitivity or physical
termination guarantees. Each actor uses elapsed hrtime from the supplied T0;
invalid/regressive/expired control observations revoke. The parent also checks
the same admission deadline. Neither origin nor admission deadline is renewed.
The separate cleanup wait cannot extend admission; JavaScript timers or a
bounded Promise wait cannot guarantee kernel progress or physical shutdown.

S and W retain their first local failure independently. W's ending can record a
last received peer observation or loss of the expected pulse; if no pulse was
ever observed, loss has no invented observation timestamp. It never reports
planned peer end or confirmed containment from an IPC result. All client,
validation, physical-closure and custody fields remain unknown/not started.

The parent signals only its owned child handles, at most once per scheduled
signal, and stops signalling a child after an observed native exit. Signal API
success is not termination. Native `exit` and final `close` observations are
kept separately; exit alone cannot satisfy the final transport wait. A missing
close event remains unconfirmed even if exit was observed. Parent-channel loss
makes an actor close its own files, but can prevent delivery of its final receipt.

## Wire profile and acknowledgements

Messages are JSON **strings** on Node IPC, bounded to 64 KiB before application
JSON parsing. Header base64 represents at most 32 KiB of original bytes; root
is at most 4096 UTF-8 bytes and each of at most three assigned names is at most
1024 bytes. The complete escaped message must also fit the total wire limit;
per-field maxima do not guarantee that every combination fits. These are
experimental wire limits, not filesystem limits.
Node has already decoded its IPC envelope at this boundary: this is not a
native allocation limit or protection from an arbitrary hostile child.

The exact envelope has `version: 1`, `kind`, `actor`, `operationId`, decimal
uint64 string `id`, and `payload`. The decoder accepts the encoder's JSON
representation, rejecting duplicate fields, whitespace/escape substitutions,
extensions and malformed values. Contexts, assigned destinations, timing,
progress, reports and causes each have a closed shape/domain. Header base64
must decode to the bounded v1 record; original header bytes are never re-encoded
to invent a matching identity.

| Kind | Correlation and payload |
| --- | --- |
| `request` | Sequential nonreused command ID for the addressed actor; `{command, data}`. Commands: init, S prepare, W verify, S ready/append, finish. |
| `reply` | Exact pending/cancelled ID, actor, operation and command; `{command, ok, report, header}`. Native PID must match the adopted child. Header is present only for S prepare. |
| `pulse` | Independent increasing pulse ID and `{atNs}`; parent forwards the original checked message to the other actor. Only observational pulses may be dropped under backpressure. |
| `stop`, `fault` | ID zero and closed `{code}`; never permission to reopen. |
| `closed` | ID zero and `{report}`; once-only unsolicited file-close receipt after actor failure, distinct from a command reply. |

Send callbacks establish local transport progress, not peer work. Readiness
requires the actual checked command replies and W's correlated receipt. Reports
carry only bounded control metadata, native PID and the actor's own writer
snapshots. Regressing time/action IDs/prefix length, changed same-length digest,
cleared uncertainty/first failure, wrong native PID or stale replies revoke.
There is one outstanding command and one in-flight routed pulse per child, no
command queue or retained event transcript. This is structural reasoning,
not a quantitative memory or latency result.

## Results and incomplete outcomes

Snapshots contain `children`, `actors`, `firstFailure`, `mayStart`, `collection`,
and `externalClosure`, `clockAdmission`, `releaseAdmission` (all three always
`unqualified`). `mayStart` describes last explicit observations, not a current
lease or authority to launch an acquisition client. The parent first failure
is its first observation, not an invented ordering of all actors' causes.

Each child observation contains native `pid`, state (`not_started`, `starting`, `running`,
`closed`, `unconfirmed`), `spawnObserved`, `exitObserved`, `exitCode`, `signal`, first parent error,
separate channel error, `finishAck`, `finalReceipt` and signal-request flags.
Actor reports contain PID, gate/phase/stage/action/time, first local failure,
`localClosed` and own writer snapshots. They do not authenticate external truth.
When explicitly bound, actor reports also contain the closed `host` observation;
local file receipt and native/global closure still have separate meanings.

Finish adds `parts` with original confirmed bytes and uncertainty. Collection
requires a stopped child and a confirmed owner-close receipt for complete range
claims. Otherwise it keeps the last acknowledged prefix unknown/uncertain;
bytes beyond that prefix are not discovered from padding, syntax or file size.
An unconfirmed child is not read (`OWNER_UNCONFIRMED`). Reads use existing
identity checks and compare exact bytes to the reported prefix digest
(`PREFIX_MISMATCH`); failed collection gives `COLLECTION_FAILED`. No substitute
file or rebuilt record is used. Association failure is
`RECORD_ASSOCIATION_FAILED`. Complete JSONL still establishes no external closure.

Closed process diagnostics are `PROCESS_INPUT`, `PROCESS_PROTOCOL`,
`PROCESS_CHANNEL`, `PROCESS_STOPPED`, with existing control/record error domains
for input and file validation. Reports never include native error text, paths,
stacks or inherited configuration. Caller-owned returned bytes still require
the publication-content check before any later external transmission.

## Verification domain

The [focused command](../development.md#configured-commands) uses actual finite
local actors/files, synthetic records and controlled loss/late-message/cleanup
cases. A suspended owned peer tests the liveness path; it is not a resource,
scheduling-sensitivity or Linux containment pilot. A child-handle double checks
unconfirmed cleanup without creating an unowned process. The tests qualify no
physical resource budget, admitted clock, storage reservation/durability,
independent containment path, operational CI/trust acquisition or signing.
MJS contracts are documented/tested and are not statically checked by the
runtime TypeScript compilation.

The standard API semantics are described in the pinned
[Node child-process manual](https://nodejs.org/download/release/v22.12.0/docs/api/child_process.html).
