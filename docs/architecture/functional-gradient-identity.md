# Gradient result identity

A gradient's numbers do not determine which tensor object a caller receives.
Two requested parameters can receive the same incoming gradient, while two
views of the same numbers can require different objects. Confusing those
relationships changes Python `is`, mutation effects, gradient associations
and failure ownership even when every initial numerical value is correct.

This decision specializes [semantic state](semantic-state.md) and
[gradient state](cpu-gradient-state.md) for first-order float32 gradient
results and their Python presentation. It applies across ordinary CPU and
WebGPU execution. Supported operations, layouts and public calls remain the
separate [compatibility claim](../compatibility.md); an architectural contract
alone does not establish implemented support.

## Keep three relationships separate

| Relationship | Meaning and owner |
| --- | --- |
| Incoming gradient equivalence | One native gradient object can be passed to several derivative edges or requested occurrences. The semantic runtime owns this equivalence. |
| Numerical alias family | Tensors can share a current value and mutation version without sharing object identity, tracking or gradient slots. The ordinary value/family owners govern this relationship. |
| Public exposure | A JavaScript occurrence owns a separately closeable lease. Python presents one live wrapper for equivalent gradient results, preserving native object identity. |

For example, the examined native float32 call
`torch.autograd.grad(x + y, (x, y), grad_outputs=seed)` returns the same object
for both results and the explicit seed. A view derivative can produce a
separate object that still aliases the seed's numerical family. Independent
contribution products can produce equal values without equivalent objects.
These are behavioral observations, not instructions to group by values,
parameter names or storage addresses.

The runtime uses its existing incoming semantic token to identify equivalent
gradient occurrences. Reusing that token does not share the occurrences'
JavaScript semantic identities or their `.grad` associations. A frontend must
not merge runtime identities merely to preserve Python presentation.

Each requested occurrence still goes through the required admission and
traversal. Coalescing results cannot deduplicate input validation, reorder
callbacks or remove observable partial progress. Separate calls retain the
identity determined by their own seed and derivative occurrences; equal
values do not make their results equivalent.

## Derivative provenance determines the result class

An ordinary matching-shape pass preserves incoming equivalence. A real view
creates a new object identity while preserving its numerical alias family.
Shape restoration belongs to the derivative/result boundary; preserving an
incoming token cannot justify returning the wrong shape.

Whole-storage copy through a view has a source contribution distinct from its
base contribution and incoming seed. Its source clone owns an independent
dense numerical family, starts at version zero and preserves the source
shape. Independent families can share immutable backing: subsequent writes
replace their own logical values. This does not require another physical
copy, writable GPU storage sharing or a separate derivative executor.

Resolving a dirty ordinary view also differs from differentiating an
unchanged view. Within the examined whole-contiguous domain, its nonempty
base contribution is a no-grad view over a fresh family at version one; an
empty rebased contribution is plain at version one. An unchanged view keeps
its ordinary view provenance, including the no-grad active-copy guard.
Those distinctions govern subsequent supported mutations, acquisition and
version checks. Matching values or versions alone does not establish the
correct result class.

The runtime and derivative recipes own these distinctions. Python conversion
must not encode operation-specific shape, copy or view cases. Numerical
kernels continue to execute ordinary admitted operations.

## Python canonicalization owns an exposure

Python uses weak canonical lookup keyed by incoming equivalence. That lookup
must not become a strong history of previous results, seeds or tensor values.
An existing open wrapper can represent another equivalent occurrence; a
closed host exposure cannot be reused. JavaScript retains independently
closeable occurrences and its existing canonical property-getter behavior.

A Python conversion receives its own lease, including conversion of `.grad`.
Reading an association must not hand that conversion another caller's
borrowed canonical handle to retire. If canonical lookup reuses a wrapper,
conversion retires the newly acquired occurrence. If construction or
retirement fails, all newly owned occurrences receive cleanup attempts and
primary and cleanup failures remain observable. The association and any
caller-held exposure retain their own ownership.

This presentation rule does not replace
[leaf acquisition and nonleaf retention](cpu-gradient-state.md#leaf-accumulation-and-nonleaf-retention-differ).
Those policies determine numerical aliases and persistent associations;
wrapper equivalence is a separate responsibility.

## Preserve additional failures before coalescing

A gradient occurrence can carry root/history writer obligations absent from
the existing wrapper chosen for presentation. Discarding that occurrence
would discard its error. Attaching the extra failure to the original seed
would instead make the seed fail where its own computation remains valid.
When Python must return that same seed object, those conflicting deferred
states cannot both belong to it.

Before reusing an existing wrapper, conversion therefore completes additional
unresolved or failed obligations that would otherwise be lost. It admits the
compact control capture through the ordinary capacity owner, retains it,
progresses the common request queue, preserves the original failure and
retires the capture. The guard does not form a gradient data program,
materialize the gradient or read its payload. Existing successful or already
covered controls do not require this additional completion.

This is a deliberate observable consequence: conversion can wait or fail at
`grad()` or a `.grad` read before returning the equivalent object. The seed
remains independently valid. Direct JavaScript occurrences retain their
independent deferred failure obligations. Common progression can run user
callbacks, so conversion rechecks that the selected canonical exposure is
still open before returning it.

The [managed observation mechanism](python-observation.md) owns synchronous
progress across Python and its selected backend, including operation without
JSPI. This identity contract adds no interpreter-local scheduler, numerical
readback or CPU fallback.

## Costs, alternatives and limits

Requested occurrences still require separate admission and lease retirement.
Capturing and releasing controls costs work proportional to their stored
occurrences: independently owned results can each retain the same controls,
so that work can multiply result count by control count. This is distinct from
the number of unique writers and from numerical payload work. The identity
choice does not promise constant-cost runtime result cleanup or optimize those
shared control representations.

Python call-local equivalence avoids repeating wrapper conversion and the
additional completion guard for one result class. Comparing and retaining
that guard's controls costs work proportional to the controls compared, plus
required queue progression. Capacity admission includes temporary compact
owners as well as the independently retained result controls. Weak lookup
and explicit retirement do not establish RSS, VRAM or a universal lifetime
bound; conditional synchronization does not establish a temporal advantage.

Target-based grouping cannot preserve shared results across distinct targets
or with seeds. Value/storage grouping wrongly conflates separate products
or views. Reusing full runtime identities couples JavaScript slots and
failure state. Reusing only presentation tokens loses additional failures.
Separate incoming equivalence, own conversion leases and completion of lost
obligations preserve the examined relationships through the existing owners.

Mutable scalar expansion follows the separate
[sum-gradient alias contract](sum-gradient-aliases.md). Initial scalar bits,
numerical aliasing and leaf acquisition are independent contracts. Neither correct
identity matrices nor fresh contiguous materialization alone proves their
equivalence. Numerical rounding, broader
layouts, higher-order derivatives, whole models and other adapters also remain
outside this decision. Reconsider its token/provenance rules when an added
operation produces a materially different native equivalence class, and its
completion rule when the ordinary ownership/progress contract changes.

## Evidence

The [accepted research response](https://github.com/isaacperez/tabgrad/issues/277#issuecomment-6145672431)
records the decision and its consequences. The
[reproduction source and results](https://github.com/isaacperez/tabgrad/issues/277#issuecomment-6145584060)
and [independent challenge](https://github.com/isaacperez/tabgrad/issues/277#issuecomment-6145510787)
preserve alternatives, failed candidates and limits. The examined oracle is
PyTorch 2.14 at `08187d9e0fba026dc8217405802ab5381dc88d90`;
[CopySlices](https://raw.githubusercontent.com/pytorch/pytorch/08187d9e0fba026dc8217405802ab5381dc88d90/torch/csrc/autograd/functions/tensor.cpp)
and [as_strided backward](https://raw.githubusercontent.com/pytorch/pytorch/08187d9e0fba026dc8217405802ab5381dc88d90/torch/csrc/autograd/FunctionsManual.cpp)
explain the examined source-clone and rebased-view boundaries.

The bounded CPU and Chrome/Apple GPU controls match all 120 identity classes,
while 114 complete observations match and six scalar-expansion mutation
observations differ. Additional copy/provenance controls cover shape,
versions, acquisition and active-copy guards. Structural failure/retirement
and guard controls do not establish general native equivalence or temporal
performance. The separate
[scalar-expansion alias decision](sum-gradient-aliases.md) is recorded in
[#279](https://github.com/isaacperez/tabgrad/issues/279).
