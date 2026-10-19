# Local acquisition coordination

This **internal experimental** interface composes separate supervisor and
watchdog control states with the [acquisition record](provenance-acquisition-record.md).
Its domain is logical coordination in one Node process and owned ordinary-file
I/O. A permission returned here is a local protocol decision, not authorization
to execute a client, acquire trust, sign, upload or publish. The
[release policy](../releases.md) owns operational authority.

`scripts/provenance-acquisition-control.mjs` owns control decisions and pending
action correlation. `scripts/provenance-acquisition-control-session.mjs` owns
local assembly, effects and collection. They do not import a client, discover
configuration, inspect the environment, start processes or perform import-time
work. There is no timer, IPC, cgroup observer or physical independence between
the actors. The synchronous clock and file-transfer seam are trusted internal
ports, not user plugins.

## Control state and inputs

`createAcquisitionControl(context)` returns a frozen state for one actor.
Exactly these own-data fields are required:

| Field | Domain |
| --- | --- |
| `role` | `supervisor` or `watchdog` |
| `operationId` | Acquisition Token |
| `expectedHeaderSha256`, `profileSha256` | Acquisition Hash |
| `t0MonotonicNs` | Acquisition Uint |
| `deadlineNs` | Nonzero Acquisition Uint; elapsed from the same T0 |

The preparer supplies each actor's expectations independently. They are copied
and frozen; receiving a header never establishes its own expected identity.
The record owner exports `isAcquisitionToken`, `isAcquisitionHash`,
`isAcquisitionUint` and `isAcquisitionUtc` so both contracts use one scalar
definition. Hashes identify bytes and do not authenticate the sender.

State retains context, `gate` (`pending`, `ready`, `revoked`), control `phase`
(`setup`, `observe`, `close`), header `stage`, the next action ID, at most one
pending action, last elapsed reading, first local failure and progress/ending/
close flags. It retains no event history or payload buffers. Callers pass the
state returned by this module, not a reconstructed or externally supplied state.

`advanceAcquisitionControl(state, event)` returns `{state, actions}` with zero
or one action. It performs no I/O. Each event has exactly these common fields:
`kind`, `actor`, `operationId`, `phase`, `actionId`, `atNs`, plus the fields below.
Unknown keys, accessors, symbols and wrong ownership are rejected as protocol
failure. `atNs` is an elapsed Uint; null or an invalid/regressive reading revokes
the gate with unknown failure time. A reading equal to the deadline is within
the bound; a greater reading revokes. No transition renews the origin or bound.

| Kind | Additional fields and correlation |
| --- | --- |
| `request` | `effect`; action ID must be the next sequential Uint for that actor, starting at 1; phase must match the effect |
| `complete` | `ok` boolean, nullable `code`, `bytes`, `peer`; ID and phase must match the exact pending action |
| `stop` | `code`; ID is null and phase is the actor's current phase |
| `tick` | No additional fields; ID is null and phase is current |

Failure codes are `protocol`, `clock`, `deadline`, `storage`, `observer`,
`controller`, `peer`. A successful completion has null code. A failed completion
has an allowed code and null bytes/peer. Successful `read_header` and
`verify_header` completions carry a bounded Buffer in `bytes`; other completions
have null bytes. Only `peer_ready` carries a peer receipt, with exactly
`{actor: "watchdog", operationId, phase: "setup", actionId, headerSha256}`.
Its ID refers to the supervisor's pending readiness action. Other completions
have null peer. These are internal objects, not a serialized message profile.

`ACQUISITION_CONTROL_PHASES` is the single effect-to-phase map:

| Phase | Effects and owner |
| --- | --- |
| `setup` | Supervisor `write_header` → `read_header` → `peer_ready`; watchdog `verify_header` |
| `observe` | Supervisor `write_progress`, after readiness |
| `close` | Supervisor `finish_progress`; each actor `write_ending`, `close_writer` |

Actions contain exactly `actor`, `operationId`, `phase`, `actionId`, `kind`.
Their IDs are never reused. Concurrent requests, duplicate/stale completions,
wrong phases and role violations revoke the gate. First failure belongs to
each actor separately as `{code, atNs}`; there is no invented global failure
ordering. Revocation is irreversible. A late completion may account for cleanup
but cannot restore readiness. Closing cannot return to setup or observation.
Cleanup remains possible without a readable clock; emitting an ending requires
a usable timestamp. Action-counter exhaustion stops the protocol.

The watchdog decodes the exact header bytes and checks their original hash,
operation, profile and T0 against its own context. The supervisor also checks
its readback before requesting readiness. Delivery of those bytes in memory is
neither an independently opened file nor an authenticated channel.

## Local session

`await createAcquisitionControlSession({root, destinations, header,
supervisorContext, watchdogContext, clock, transfer?})` validates the contexts
and copies the header before opening files. Both context roles must match their
named inputs. It opens and validates all four distinct destinations using the
record I/O owner before writing any data. On success the session owns those
writers and callers must finish it. Failed opening uses the record owner's
cleanup contract. There is no implicit finalizer or external shutdown guard.

`root` and `destinations` have the record I/O contract. The synchronous `clock()`
returns an elapsed Uint string from the context's admitted T0; it is called at
control boundaries. Exceptions become unreadable observations. This interface
does not qualify that clock or correlate it to native clocks or UTC.
`transfer`, when present, is the existing trusted FileHandle read/write seam.
Collection uses actual native reads, not that fault-injection seam.

The session exposes:

| Interface | Result and effects |
| --- | --- |
| `start()` | Once: write header, read it on S's retained opening, validate on W, deliver W's readiness to S; resolves to snapshot |
| `supervisor.append(input)` | Write one progress event; input has exactly `phase`, `kind`, `subject`, `code`, `reference`, `value`; session supplies operation, sequence and elapsed time |
| `stop(role, code?)` | Synchronously revoke the named actor, default cause `controller`, and notify the logical peer; never awaits outstanding I/O |
| `finish({observedUtc})` | One idempotent promise: join owned work, finish progress, attempt each ending once, close each actor's owned writers, then collect confirmed prefixes |
| `snapshot()` | Return current bounded control/I/O metadata without new I/O or a clock reading |

`start` and append work are serialized. Concurrent requests revoke and reject
with `SESSION_STOPPED`; they are not queued for eventual repeated effects.
Finish immediately excludes further admission, waits for admitted work and is
not cancellation of that work. No timeout is presented as proof of its death.
After finish, start/append/stop reject without changing the final state.

Append validates closed own-data input before accessing values. The existing
record codec validates the event domain; caller assertions still need their
own evidence. Session-generated endings report no client start and leave
external observations, custody and validation unknown. W never infers planned
peer termination, unnecessary containment or physical closure from S's logical
finish. An unreadable clock leaves an ending absent rather than fabricating
its time. `observedUtc` is a valid UTC supplied by the caller, which owns its
actual correlation. Later failures do not rewrite already emitted endings.

I/O failures revoke with `storage`; invalid record content with `protocol`.
Native messages, stacks, paths and thrown clock details are not diagnostics.
The first local failure is preserved while the writing snapshots retain their
own first/close errors. No ambiguous effect is retried. A failed S ending does
not consume W's reserve. A close failure remains unconfirmed and is not retried
as implicit recovery; the session's result cannot establish physical cleanup.

## Results and evidence domain

Snapshots contain:

- `actors`: separate frozen control states;
- `writes`: original per-role writing snapshots;
- `headerReadback`: nullable length/state/error metadata, separate from writing;
- `mayStart`: both gates ready, no pending action and no finish requested;
- `localClose`: per-actor confirmation of successful owned file-close APIs;
- `collection`: null until collection, then `{formatComplete, formatError}`;
- `externalClosure` and `releaseAdmission`: always `unqualified`.

`mayStart` describes the last explicit logical observations, not a continuously
checked lease or permission to launch a real operation. In particular, reading
a snapshot does not observe elapsed time or enforce the deadline.

Finish also returns `parts`, with original confirmed prefixes and uncertainty
from the record reader. Collection/open failure yields an unknown part with
`COLLECTION_FAILED`, without substituting another file or recovering lengths
from padding. Structural association failure yields
`RECORD_ASSOCIATION_FAILED`; a complete format still establishes no operational
admission. Returned bytes are caller-owned evidence, not authenticated data.

Creation/input errors use closed `CONTROL_CONTEXT` or `SESSION_INPUT` codes;
record opening retains its documented errors. Ordinary control failures are
returned as revoked states. The JavaScript contracts are documented and tested,
not statically checked by the TypeScript runtime compilation.

The focused checks use independent expectations, synthetic clocks and actual
ordinary temporary files. Counters vary event count, allowed payload and
transfer width independently. They check exact transferred bytes, bounded
state and absence of repeated progress-prefix reads. They measure neither
latency nor memory peaks, and qualify no process isolation, clock, physical
reservation/durability, external containment, real acquisition, signing or CI
environment. The [development registry](../development.md#configured-commands)
owns the reproducible test command.
