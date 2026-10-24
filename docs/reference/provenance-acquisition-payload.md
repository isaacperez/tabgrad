# Experimental raw acquisition payload writer

This retained internal experiment writes already supplied binary bytes to two
existing identified regular-file reservations. It neither reads nor interprets
Docker frames, FIFO data, text, process control or producer proofs. Imports do
no I/O. The [release policy](../releases.md) governs authority and qualification;
a complete local prefix does not admit its origin, physical closure or signing.

## Input and file ownership

`await openAcquisitionPayload(input, {clock?, transfer?})` takes exactly
`{root, destinations, t0MonotonicNs, deadlineNs}`. `destinations` has exactly
`stdout` and `stderr`, each `{name, identity: {dev, ino}}`. Names are basenames;
identities and times are canonical uint64 decimal strings, with nonzero inode
and positive elapsed deadline. Root is a canonical absolute owned directory.
Inputs and transfer functions are copied before asynchronous opening.

`ACQUISITION_PAYLOAD_LIMITS` fixes capacities at **1 MiB stdout** and
**256 KiB stderr**. The existing file-premises owner checks regular files,
single links, exact capacities, independent supplied identities, no-follow
opening without create/truncate/append, distinct effective destinations, and
the root again after opening. Failed opening disposes every adopted handle and
reports cleanup counts. Held handles survive pathname replacement. The caller
owns initial emptiness, namespace stability, permissions, allocation and
separation from other evidence/inputs. This pair-local check does not admit a
larger set of destinations or physical reservation.

## Raw writes and independent channels

`write(role, buffer)` borrows one **stable Buffer until settlement**. It writes
the exact bytes, even when they resemble a Docker header. The caller awaits
each call on a given role and must not mutate borrowed bytes. Another write
or `finish` on that busy role rejects with `CAPTURE_BUSY`; no call is queued.
The other role can progress independently. One failure or stop excludes new
work on both roles; already admitted transfers retain their eventual effects.

An entire supplied chunk must fit that role's remaining allowance or it is
rejected before any of its bytes are submitted. This writer does not read an
extra byte, clip an excessive input or infer how much an upstream producer
emitted. A reader applying a different acquisition overflow policy must submit
only its allowed prefix and retain its separate overflow result.

Known short writes continue at the next confirmed position in the same Buffer.
Zero progress, invalid extent or thrown transfer permanently stops the pair.
Counts/hash cover only reported successful extents; unknown effects remain
unknown and are never replayed, scanned for zeros or converted into completion.
No original file is truncated to recover length.

`finish(role)` declares only that the caller has finished supplying that role.
It is idempotent while the pair remains pending or complete. Both role finishes
are needed for `state: complete`; either can finish while the other is busy.
Writes to an individually finished role reject with `CAPTURE_STOPPED` without
preventing the other role from completing. Empty roles and empty chunks are
valid. A finish is not observed FIFO EOF, process exit or proof of absent writers.

## Clock, evidence and closure

The default clock is `process.hrtime.bigint()`. One monotonic history covers
both roles and the original origin/cutoff. Checks occur before/after opening,
on call admission and dispatch, and before/after each awaited write. Invalid,
regressive or expired samples permanently stop work. A late known write extent
is recorded before checking permission again; it cannot restore success or
renew the cutoff. Native I/O may stall; this is no external deadline guarantee.

`snapshot()` is frozen and performs no clock/file read. It reports:

- `state` (`pending`, `complete`, `incomplete`, `limit`), `firstError`, `lastAtNs`;
- `channels.stdout`/`.stderr`: `submittedBytes`, `confirmedBytes`, confirmed-prefix
  `sha256`, `uncertain`, `firstError`, `closeError`;
- per-role `busy` and `complete`, total in-flight `ioPending`, and `ioClosed`
  (`open`, `pending`, `closed`, `unknown`).

Submitted bytes are admitted chunk lengths, including a chunk whose transfer
later fails. They exclude rejected chunks and any upstream unread/unsubmitted
data. A finished-role flag records the caller's declaration; after a later
failure it does not establish successful data or closure. Confirmed-prefix
hashes are incremental, without file rereads.

`stop()` synchronously excludes new work. `close()` also stops, returns the
same promise repeatedly, joins all borrowed-input work, and attempts both
closes once. A late extent stays visible; a separate close failure cannot erase
it or replace the first cause. Closing before both finishes is incomplete;
failed close makes even previously complete data incomplete with closure
unknown. Pending native work can leave the returned promise pending.
`externalClosure`, `clockAdmission`, `releaseAdmission` remain `unqualified`.

The existing `CAPTURE_*`/`FILE_*` diagnostics and `OPEN_FAILED`, `WRITE_FAILED`,
`WRITE_EXTENT_UNKNOWN`, `WRITE_NO_PROGRESS`, `CLOSE_FAILED` are shared with
[binary capture](provenance-acquisition-capture.md). Native messages/paths are
not copied into diagnostics. Optional trusted finite ports use
`transfer.write(handle, buffer, offset, length, position)` and optional
`transfer.close(handle)`. They are test seams, not plug-ins or alternate
admitted filesystems.

## Shared owner and verification domain

The raw adapter and Docker decoder use the same private file/lifetime owner
through the cross-module `openAcquisitionPayloadStore` seam. Its `check`,
`fail`, `remaining`, `append`, `finish`, `stop`, `close`, `snapshot`, `complete`
and `state` operations are for those trusted adapters only. They do not form
another independently callable writer API: adapters validate roles/Buffers,
enforce allowance and call serialization, and pass **all** borrowed-input work
to close, including decode work that has not reached a file await. The store
owns clock history, confirmed transfers, hashes, failures and handles. Docker
keeps its declared-frame precheck, serial `CAPTURE_BUSY`, framing progress and
original meaning of `receivedBytes`; it does not copy payloads into invented
frames for raw writing.

The [local capture composition](provenance-acquisition-capture-attempt.md) uses
internal `createAcquisitionPayloadStore`, `createAcquisitionPayload` and
`createAcquisitionCapture` seams after its complete file admission. These
perform no opening; the caller transfers the identified handles exactly once.
The original open entries retain the fixed stdout/stderr layout. The only
other internal layout is the fixed control890 destination, using the same
transfer/hash/cleanup implementation without Docker framing or JSONL encoding.
These trusted seams are not public configurable writer factories.

Each pair store retains two digest/counter states (the control store one);
adapters borrow at most one chunk
per independent channel, and Docker retains its eight-byte header. There is
no chunk history, frame-sized allocation, read-ahead or payload copy introduced
by this extraction. Returned snapshots copy bounded metadata/digest state.
These are structural facts, not measured RSS, latency or allocation guarantees
for Node, the caller, filesystem or kernel.

Tests use ordinary owned files, independent literal bytes and finite transfer/
clock controls. Payload size, partition, role and repetitions vary separately;
counters check exact transferred ranges without asserting temporal performance.
Tests cover identity, limits, partial/unknown effects, independent progress,
shared-clock failure, stop and failed/late closure. They qualify no physical
FIFO, Docker, host, resource reserve, clock, trust, custody or signature. MJS
contracts are documented/tested, outside the runtime TypeScript compiler;
the experiment does not change distributed library behavior or require
production TDD.
