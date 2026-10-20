# Experimental binary acquisition capture

This retained internal experiment consumes **already supplied** binary stream
chunks and writes two existing identified files. It supplies no Docker client,
HTTP/hijack/socket handling, Exec/container/PID identity, acquisition, physical
reservation or [startup admission](provenance-acquisition-startup.md).
Imports perform no I/O. The [release policy](../releases.md) governs operational
qualification and authority; neither complete framing nor a prefix hash admits
trust, process closure, custody, signing or a release.

## Input and ownership

`await openAcquisitionCapture(input, {clock?, transfer?})` requires the exact
ordinary-data fields below, copied before asynchronous opening:

| Field | Domain |
| --- | --- |
| `root` | Canonical absolute owned directory |
| `destinations` | Exactly `stdout` and `stderr`, each `{name, identity: {dev, ino}}`; basename and independently supplied uint64 decimal native identity, nonzero inode |
| `t0MonotonicNs` | Original monotonic origin, uint64 decimal string |
| `deadlineNs` | Positive elapsed cutoff from that origin, uint64 decimal string; caller supplies its existing applicable phase/operation cutoff |

The caller owns initial emptiness, allocation, permissions, namespace and
separation from control/evidence files. Fixed capacities are **1 MiB stdout**
and **256 KiB stderr**. Shared `provenance-acquisition-file-io.mjs` supplies the
same owned-root, regular-file, single-link, capacity, no-follow/non-append/
non-truncating openings and identity checks used by record I/O. Both destinations
are checked for distinct effective identity before any writer is returned.
Held handles remain the targets if a pathname is replaced. This is an owned
filesystem premise, not isolation from a hostile filesystem or mount manager.
Logical capacity/zeros do not establish physical reservation or the aggregate
64 MiB accounting. No original is truncated to infer or recover data length.

`clock` defaults to `process.hrtime.bigint()`. Original origin/cutoff and
nonregression are checked before/after opening, at decode steps and after
awaited effects. A regressive/invalid clock or expired cutoff permanently stops
capture. There is no renewed origin, arbitrary frame-count limit or claim of
clock authentication/scheduling/physical termination. Native I/O may stall.

## Supplied framing and backpressure

`write(buffer)` borrows a **stable Buffer until its promise settles**; the trusted
producer must await each call and must not mutate that buffer while borrowed.
No call is queued; concurrent `write` or `finish` rejects with `CAPTURE_BUSY`.
The owner retains one input chunk, an eight-byte header and constant channel
metadata/digest states. Producer, transport, kernel and filesystem buffers are
outside that structural claim. No frame-sized allocation or growing transcript
is used. There is no measured RSS or latency claim.

The supported non-TTY/stdin-closed subset of the
[Docker API 1.56 framing specification](https://github.com/moby/moby/blob/b26fb77d3e7b01f9d21b89539c1ab428f5ca431f/api/swagger.yaml)
has eight-byte headers `{type,0,0,0,length_uint32_big_endian}`. Only types
`1` (stdout) and `2` (stderr) are admitted. The API also describes type `0`;
this closed-stdin profile rejects it, all other types and nonzero reserved
bytes. It does not assign unexplored daemon-error semantics to another type or
promise compatibility with every Docker stream. HTTP status, TTY selection,
Content-Type and actual source must be established by a future transport owner.

Header/payload fragments may cross calls; one call may hold several frames.
Declared payload length is checked against its channel's remaining allowance
before any payload write/allocation. Payload bytes are never decoded as text;
framing/diagnostics cannot enter either original channel. Empty frames are
allowed and yield to the event loop, checking the original deadline again:
zero payload does not provide an unlimited lifetime or starve local stop.

## Evidence, failure and closure

`snapshot()` performs no implicit clock/file read and returns frozen metadata:

- `state`: `pending`, `complete`, `incomplete` or `limit`; `firstError` retains
  the first stop/failure. `lastAtNs` is the last accepted elapsed clock sample.
- `channels.stdout`/`.stderr`: `receivedBytes`, `confirmedBytes`, incremental
  confirmed-prefix `sha256`, `uncertain`, `firstError`, `closeError`.
- `headerBytes`, `pendingFrameBytes`: current decoding progress; `busy`,
  `ioPending` and `ioClosed` (`open`, `pending`, `closed`, `unknown`) distinguish
  accepted work, an in-flight transfer and handle closure.

`receivedBytes` counts payload identified and submitted to this decoder's file
writer, excluding framing. It is **not a socket-arrival count** or an estimate
of an unparsed trailing chunk after failure. Confirmed counts/hash advance only
by reported successful positional write extents. Known short writes continue
the same range. Zero progress, invalid extent or thrown write stops permanently;
unknown effects beyond the confirmed prefix remain on disk and are never
replayed, scanned for zeros or invented as confirmed data. Separate close
errors do not replace the first cause or erase known prefix evidence.

`finish()` explicitly declares the supplied stream ended. Partial header or
payload rejects with `CAPTURE_TRUNCATED`; a valid empty stream can complete with
empty hashes. It does not observe transport EOF, client exit, descendants,
helpers or external writers. Those need independent evidence. Later writes
cannot reopen complete/failed capture.

`stop()` synchronously excludes new work without waiting for an admitted write.
`close()` also stops, returns the same promise repeatedly, joins the owned
write and attempts both closes once. Late confirmed effects update their known
extent but cannot restore success or extend the original cutoff. Closing before
`finish` leaves an incomplete result; failed close leaves `ioClosed: unknown`
and incomplete state, including after previously complete framing. Pending I/O
may leave close pending: a local API is not an enforced external deadline.
All reports retain `externalClosure`, `clockAdmission` and `releaseAdmission`
as `unqualified`.

Diagnostics are closed codes: `CAPTURE_INPUT`, `CAPTURE_BUSY`, `CAPTURE_PROTOCOL`,
`CAPTURE_LIMIT`, `CAPTURE_TRUNCATED`, `CAPTURE_STOPPED`, `CAPTURE_CLOCK`,
`CAPTURE_DEADLINE`, existing `FILE_*`/`OPEN_FAILED`, `WRITE_FAILED`,
`WRITE_EXTENT_UNKNOWN`, `WRITE_NO_PROGRESS`, `CLOSE_FAILED`. Native opening
failures retain cleanup counts; native paths/messages are not copied into them.
Optional `transfer.write` uses the FileHandle transfer signature and optional
`transfer.close(handle)` controls closure; these are trusted finite test seams,
not filesystem isolation, user plug-ins or admitted alternate native clients.

## Verification domain

The registered acquisition tests use independent literal binary vectors, actual
ordinary owned files and finite/synthetic transfer/clock controls. They vary
frame count, payload and partition independently, using transfer counters rather
than timing claims. They check first/last bytes, both channels, limits,
fragmentation, cancellation, partial/uncertain effects and separate closure.
They qualify no real Docker transport, Linux host, allocation/quota, physical
deadline, resource sensitivity, custody or signature. MJS is documented/tested,
outside the runtime TypeScript compiler. No production TDD or tensor change is
involved.
