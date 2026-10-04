# Persistent CPU tensor copy

Use `destination.copy_(other, non_blocking=False)` in Python or
`destination.copy_(source)` in JavaScript to replace an existing tensor's
numbers while preserving its public identity and whole-storage aliases.
This reference covers same-session, exactly equal-shape contiguous CPU
float32 tensors, including scalar and empty shapes. The
[accepted architecture](../architecture/cpu-tensor-updates.md) owns the design;
[compatibility evidence](../compatibility.md#python-tensor-evidence) bounds the
PyTorch claim.

## Calling forms and values

Python accepts one tensor as positional `other` or `other=`, and an optional
built-in boolean `non_blocking` positionally or by keyword. Both boolean values
have the same CPU behavior. The method returns the identical Python object;
JavaScript likewise returns the identical handle. Native PyTorch 2.14.0's
effective keyword is `other`, although its documentation names `src`.
`src=` is not accepted. Invalid binding and nonboolean options raise `TypeError`.

A copy preserves destination shape, dtype and device. Source float32 bits are
shared without arithmetic rounding, including signed zero, subnormal and
nonfinite values. Later source updates do not change the copied destination.
Every accepted call advances the alias family's version once, including
self-copy, identical values and empty tensors. Version counters are private;
this interface does not expose native `_version`, `is_leaf` or `grad_fn`.

Broadcasting, scalar-number sources, conversion, cross-session copy, arbitrary
strides/offsets and GPU mutation are excluded. These include calls that native
PyTorch accepts; their rejection is a Tabgrad subset limit. Shape/domain
failures raise `RuntimeError` in Python. Invalid handles and unsupported domains
have structured JavaScript errors. Binding, gradient/view guards, domain and
capacity rejection leave the destination version/history and values unchanged
and admit no numerical request. Active leaf/view guards precede shape rejection.

## Recording and derivatives

Within [no-grad](gradient-recording.md), copy preserves the destination's
tracking and derivative identity. A true tracked leaf remains that same leaf.
Its aliases see the new numbers. An already admitted pure operation or
observation keeps its captured old numbers and derivative edges.

Within a managed Python entry:

```python
import torch
parameter = torch.tensor([2., 4.], dtype=torch.float32, requires_grad=True)
alias = parameter.view(1, 2)
gradient = torch.autograd.grad((parameter * parameter).sum(), parameter)[0]
with torch.no_grad():
    assert parameter.copy_(parameter + gradient * torch.tensor([-0.25, -0.25], dtype=torch.float32)) is parameter
assert alias.tolist() == [[1., 2.]]
```

Active copy into a tracked true leaf or a view of that leaf raises
`RuntimeError` (`INPLACE_GRADIENT` in JavaScript). Legal active copy promotes a
plain destination when the source tracks and replaces nonleaf history. The
old destination edge stays connected with exact positive-zero contribution;
the captured source edge receives the incoming gradient. Zero is not obtained
by multiplying a possibly nonfinite seed by zero. Self/overlap follow the same
edge rules.

Ordinary views resolve their current entry against the current base after an
update; already bound outputs retain their old entries. Whole-storage view
copy rebases the base and siblings. A pre-existing child resolves against the
current ultimate base, bypassing its parent's separately rebased entry. A new
child created from that parent after the update binds the parent's current entry.
Its traversed history is consumable once,
even without numeric saves; direct-copy history can be reused. A cutoff at the
output/base can succeed without executing an already consumed ancestor. A
mixed request that needs that ancestor fails before partial differentiation.

Views created in no-grad preserve special creation provenance, including
active child views that have a real entry with absent upstream edges. Active
mutation involving tracking through such a destination fails. After a base
update, resolving a tracked special view's derivative entry fails with
`INPLACE_VIEW`; data and tracking metadata remain readable. No-grad operations
can still read it without resolving an active edge.

Every numeric save of an executed derivative node is version checked, including
plain or pruned input positions. A changed save raises `SAVED_VERSION_MISMATCH`
before seed creation or history consumption. An unsaved old output remains
valid. The [functional gradient reference](functional-gradients.md) owns
first-order options and pruning.

## Deferred progress and errors

Admission captures the predecessor, source snapshot and recording mode. The
same runtime request queue executes the mandatory effect; closing handles or
discarding its return does not cancel it. Publication waits for predecessor,
source and backend generation success even for host-ready, resident, self or
empty copies. JavaScript observations, managed Python entry completion and
session close join this work. Observation returns an independent copy.

Each gradient result also carries the captured root, traversed-history and
explicit-seed outcomes, even when its numbers are a constant zero or a cutoff
seed. Later handle mutation cannot replace that capture. An old successful
output differentiated to its stable leaf is independent of a later write.

A committed write failure makes that version and already admitted ordered
successors fail causally, without replaying the write. Independent valid reads
remain usable. New writes raise `MUTATION_FAILED` without advancing versions;
further writes require a fresh session. A failed-snapshot observation can fail
repeatedly. The causal error responsibility is delivered once through an
observation, managed completion or close, so close does not replay an already
delivered responsibility. Backend failure timing/recovery is Tabgrad's deferred
execution contract, not a claim about native PyTorch scheduling.

Readback and retirement failure do not replace an authoritative publication
outcome. Independent cleanup finishes before reporting release errors. Request
pins remain until physical drain or accounted loss; unknown drain does not
permit allocation reuse. See [runtime observation](../components/runtime-observation.md).

## Resource limits and evidence

A family owns one current numeric pin irrespective of its view count. Captured
reads, derivative saves and pending effects retain independent old snapshots;
control captures contain no numeric predecessor graph. Numeric snapshots retain
only a version counter, never another family's current descriptor. Completed
no-grad updates therefore need not retain one source chain per step.

The session bounds persistent update admission to 1,024 pending copies, 65,536
live owning references and 64 MiB of unique live backing payload. The owner
budget counts numeric/history/control references, requests and undelivered
failures. Control-capturing derivative and downstream admissions reserve count
and byte capacity before changing ownership; derivative planning uses a
conservative bound for temporary contributions. Exhaustion raises
`RESOURCE_EXHAUSTED` without flushing unrelated work. These are finite
implementation capacities, not measured process-memory limits. Active history,
retained saves and undrained requests remain legitimate owners; reserved Wasm
capacity and total browser/interpreter memory are separate quantities.

Maintained `copyCases` generated from pinned PyTorch 2.14.0 cover calling forms,
identity, geometry, values, recording, connected zeros, view provenance,
saved versions and consumption. Packaged Pyodide consumes the same cases in
Node and Chrome/Firefox, including interpreter workers without JSPI and both
CPU variants. Direct scalar/SIMD tests cover bit preservation, snapshots,
mandatory failure progression, finite admission, cleanup and real ownership
at 2/16/64 drained checkpoints. This evidence establishes neither arbitrary
graph constant memory nor a throughput or whole-model performance guarantee.
