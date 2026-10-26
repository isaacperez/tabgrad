# Experimental acquisition container activation

This internal retained experiment owns one explicit Docker ContainerStart under
borrowed permission. It creates no container, image, group, files, trust material
or controls. Import and construction perform no I/O or clock observation. Native
use requires separately admitted infrastructure and authority under the
[release policy](../releases.md#qualify-mechanisms-before-claiming-readiness).
Local tests use finite Unix peers and trusted request doubles, not Docker.

## Responsibility and admission

[Startup](provenance-acquisition-startup.md) requires an initially empty,
unfrozen case before arming its controls. An already active container inside
that case cannot simply be assumed to meet this premise. A separate Start
phase preserves that initial check: an admitted composition arms controls,
activates the prepared stopped container, independently observes its placement,
then permits [Exec](provenance-acquisition-exec.md). HTTP success alone never
grants that next permission. The existing acquisition coordinator does not
compose this activation entry or supply its physical observer.

Keeping init outside the case and directing Exec to a configured destination
is a different conditional alternative: it requires demonstrating the effective
destination, absence of fallback escape and independent init retirement. The
explicit activation boundary instead owns Start's request, late effects and
uncertainty without weakening startup or moving observation into HTTP. These
constraints and the alternatives are recorded in [research314](https://github.com/isaacperez/tabgrad/issues/314).
Neither direction establishes a working native topology from local fixtures.

The examined [Moby start implementation](https://github.com/moby/moby/blob/b26fb77d3e7b01f9d21b89539c1ab428f5ca431f/daemon/start.go)
uses WithoutCancel for task creation/start. Closing HTTP does not prove native
cancellation. A204 can also result without a new start during a race; it does
not establish birth, running state or placement. A previously empty sample
cannot settle a possible later birth. The caller retains containment and
global retirement; this adapter sends no kill, stop, remove or retry.

## Input and borrowed gate

`createAcquisitionActivation(input, {gate, request?})` is synchronous. It
copies ordinary input data before validating/selecting the gate callbacks and
binds each callback to its original receiver. Later input/method replacement
cannot redirect the attempt. Accessors, symbols, extra fields and exotic input
prototypes reject. The optional Node request factory is a trusted test seam,
not an operational plugin. There is no independent clock port.

Input has exactly six fields:

| Field | Domain |
| --- | --- |
| `context` | `{operationId,t0MonotonicNs,deadlineNs,root}`: lowercase32hex identity, decimal uint64 origin and positive operation duration at most180,000,000,000ns, canonical absolute root |
| `socket` | `{path,identity:{dev,ino}}`: canonical absolute Unix path, independent decimal uint64 native identifiers and nonzero inode |
| `containerId` | Full lowercase64hex ID of an independently admitted prepared stopped container |
| `preparedContainerSha256` | Lowercase64hex reference to separately retained preparation evidence; syntax does not authenticate that evidence or current configuration/state |
| `pollMs` | Integer1..5000; a declared polling interval, not demonstrated scheduling sensitivity |
| `limits` | Exactly `{headerBytes}`: positive safe integer within Node's maximum Buffer length, passed to its response-header limit |

The gate has exactly `{context,check,appendIntent,revoke}` as ordinary own data
fields. Its context must match every input context field exactly. `check()`
synchronously checks current permission and returns the operation owner's
accepted monotonic `bigint`. The adapter rejects type, pre-origin or regressive
samples and expiration when `now - T0 >= deadlineNs`; it takes no second clock
or process allowance. `appendIntent(event)` awaits the real supervisor ACK.
`revoke(code)` synchronously notifies the upper owner without gaining authority
over startup finish, files, observation or global closure.

Before a request, the path must still be a real nonsymlink Unix socket with the
expected identity. Stable owned namespaces and daemon/preparer trust remain
external premises; lstat does not resist privileged replacement before connect.
Preparation evidence must not reference the activation-intent hash itself.

## Intent and fixed HTTP protocol

The only request is `POST /v1.56/containers/<containerId>/start`, with zero body
bytes, logical Host docker, Content-Length0, Connection close and no agent,
authorization, query, checkpoint, negotiation, redirect or retry.

The intention is SHA256 of compact UTF8 JSON without an appended newline, in
this field order: `{operationId,containerId,preparedContainerSha256,method,path,bodySha256}`.
The last field is SHA256 of zero bytes. The acknowledged event is
`{phase:"setup",kind:"transition",subject:"group",code:"begun",reference:intentSha256,value:null}`.
The existing supervisor supplies sequence/timing. This is not client-begun,
does not change client state, and proves neither Start nor evidence authenticity.
Permission is checked before intention, after ACK, around the socket check and
at response/await boundaries; polling also observes it while ACK/HTTP is pending.

Only a complete, nonupgraded HTTP1.1 response204 with observed end and zero
delivered body bytes completes the protocol. Content-Length and
Transfer-Encoding on204, upgrades, compressed encoding, contradictory/duplicate
framing and incompatible connection mode reject. Content-Type is not parsed
as JSON or required. A304 fails the prepared-stopped premise; no status triggers
an automatic retry. An unexpected delivered body rejects without accumulating
its payload; daemon error bodies do not enter program stdout or diagnostics.

[RFC9110](https://httpwg.org/specs/rfc9110.html#field.content-length) and
[RFC9112](https://httpwg.org/specs/rfc9112.html#message.body.length) define204's
bodyless framing. The [selected Node HTTP API](https://nodejs.org/download/release/v22.12.0/docs/api/http.html)
owns parsing and header bounds. This profile checks Node's delivered response,
not every trailing wire byte that its parser may not expose as body data.

## Lifecycle and observations

`run()` publishes one promise before borrowed callbacks, settles on completion
or revocation and never replays work. It may settle with `workPending` when an
ACK or I/O remains unresolved. A late ACK can update observations but cannot
send Start after revocation. `stop()` is synchronous/idempotent: retain the first
cause, notify the owner before aborting HTTP, then settle the local stop path.
After completed protocol it only requests local cleanup and preserves that fact.

`join()` passively waits for currently known HTTP object close events; it may
remain pending and never waits for a borrowed ACK or disposes controls/files.
A late response can introduce new uncertainty after an earlier join. The shared
HTTP owner adopts returned requests even after reentrant stop or listener
failure, prevents subsequent end, and requests disposal at most once per object.
Failed disposal remains distinct from unobserved closure. IncomingMessage.close
means message completion in Node, not proof of native socket or daemon closure.

`snapshot()` is passive/frozen, without I/O or a clock read. It contains exactly:

- `context`, `containerId`, `preparedContainerSha256`, `intentSha256`;
- `intentState` (`not_requested`, `pending`, `acknowledged`, `failed`), describing
  local ACK observations, and `requestState` (`not_requested`, `attempted`,
  `response_observed`), describing local transport observations;
- first observed `statusCode` or null, `observedBodyBytes`, `lastAtNs` (last
  accepted elapsed sample as decimal text or null);
- `revoked`, `protocolComplete`, `effectState`, `workPending`, `firstFailure`,
  `revocationError`, `cleanupError`, `transportClosed`, `transport`;
- `externalClosure`, `clockAdmission`, `releaseAdmission`, always `unqualified`.

`protocolComplete` reports the observed protocol only, not native state or
permission for Exec. `effectState` changes from `not_requested` to `unknown`
before invoking the request factory and remains unknown even with204 or a
throw. Late observations never erase revocation/first failure or restore success.
Old snapshots never change. `transport` is null before a transaction; afterward
it preserves responseObserved, requestClosed, streamEnded, streamClosed,
abortRequested and cleanupError. `transportClosed` only combines these known
object events, not physical termination or future-response settlement.

Closed diagnostics are `ACTIVATION_INPUT`, `ACTIVATION_GATE`,
`ACTIVATION_CLOCK`, `ACTIVATION_DEADLINE`, `ACTIVATION_IDENTITY`,
`ACTIVATION_HTTP`, `ACTIVATION_PROTOCOL`, `ACTIVATION_STOPPED` and
`ACTIVATION_CLEANUP`. Native text, paths and stacks are not diagnostics.
Returned context/evidence references still require inspection before publication.

The internal shared HTTP transaction owns lifetime only. Fixed callers select
their diagnostic family; activation additionally retains first response status,
while Exec preserves its previous property reads and snapshot fields. Each
protocol owns its own response policy. There is no general Docker client.
Response ownership precedes status observation. If that observation throws,
the response remains visible/owned, disposal is requested and the HTTP failure
stays categorical; a failed status read supplies no invented status or closure.

`npm run test:unit` discovers the activation/shared-transaction tests alongside
existing Exec/acquisition consumers. Literal wire peers, finite borrowed-clock,
ACK, revocation and close failures exercise these contracts. MJS is dynamically
tested/documented outside the runtime TypeScript checker. These checks establish
no native host, topology, clock, containment, trust, signing or release admission,
and no performance or physical resource bound.
