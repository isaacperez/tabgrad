# CPU backward and persistent gradients

This reference defines first-order backward and gradient associations for
contiguous CPU float32 addition, multiplication, total sum, shape-only views
and supported copy history. The [gradient-state architecture](../architecture/cpu-gradient-state.md)
owns identity, retention, progress and cycle responsibilities; the
[compatibility record](../compatibility.md#cpu-backward-evidence) bounds native correspondence.

## Python calls

```python
import torch
x = torch.tensor([2., 3.], dtype=torch.float32, requires_grad=True)
(x * x).sum().backward()
assert x.grad.tolist() == [4., 6.]
gradient = x.grad
(x * x).sum().backward()
assert x.grad is gradient
assert gradient.tolist() == [8., 12.]
x.grad = None
assert gradient.tolist() == [8., 12.]
```

`Tensor.backward(gradient=None, retain_graph=None, create_graph=False, inputs=None)`
returns `None`. Omitted inputs select used true leaves. Explicit inputs accept
a tensor, a nonempty iterable or an exact dictionary's values. Repeated targets
are deduplicated, disconnected tracked targets are ignored, and untracked
targets reject. A selected nonleaf installs persistent retention during metadata
setup, including when a later target fails validation.

Global seed-shape or invalid-output-history rejection happens before retention
setup; a later malformed/untracked input can leave earlier nonleaves retained.

An omitted seed supplies one only when the output contains exactly one element,
at any rank. Explicit seeds accept a tensor or a one-element sequence containing
a tensor or `None`; tensor shapes must match exactly, including empty dimensions.
Tracked seeds are valid. False boolean and integer mode forms are accepted;
`retain_graph=None` is also accepted. Enabled retained or higher-order modes
are explicitly unsupported. Invalid Python bindings retain their native error
class; exact native wording is not promised.

Every tensor has an initially absent `.grad`. Assignment accepts `None` or a
same-session tensor with matching metadata. It preserves the exact assigned
object, tracking and history. Assignment to the identical owner rejects;
assignment to a distinct view of its storage is valid. Assignment alone does
not install nonleaf retention. Reading an absent unretained nonleaf gradient
emits `UserWarning`; reading a retained or assigned slot does not.

## JavaScript calls

```typescript
tensor.backward(gradient?: Tensor, options?: {
  inputs?: readonly Tensor[];
  retainGraph?: boolean;
  createGraph?: boolean;
}): void
tensor.grad: Tensor | null
```

Options are an actual object, inputs an actual nonempty array, and modes actual
booleans. Unknown options and malformed handles reject; enabled modes report
`UNSUPPORTED_GRADIENT`. Shape, connectivity and state transitions use the same
runtime as Python. Repeated reads return the same open handle. Closing an
exposure retires that lease; a later slot read can reacquire an independently
closeable exposure. Weak canonical lookup does not keep unused tensors alive.

Leaf accumulation updates the existing gradient identity and numerical alias
family without recording new history. Clearing leaves old exposures and aliases
valid. Numerical zero through `noGrad` and `copy_` keeps the gradient identity.
Nonleaf retention instead replaces a populated slot with `old + incoming`,
leaving the old gradient unchanged. Already retained nonleaves also receive
contributions during [functional differentiation](functional-gradients.md),
including an input cutoff; functional calls do not automatically populate leaves.

## Acquisition, failures and lifetime

Initial leaf acquisition conditionally shares or clones the incoming gradient.
The condition depends on incoming tensor identity ownership and dense layout,
not merely numerical storage or operation name. View-derived seeds can share
the caller's numerical family; direct caller-held seeds, expanded sum seeds and
contributions with other incoming consumers can require independent clones.
Cloning preserves captured float32 bits, including signed zero and exceptional
values. Ordinary first-order gradients are untracked; assigned tracked gradients
retain their existing history.

Each ready node receives its gradient before recipe validation. Backward also
executes and validates an explicitly selected nonleaf recipe when numerical
ancestor contributions are pruned. Functional input cutoffs keep their narrower
traversal behavior. Successful earlier recipes remain consumed and committed
gradients survive later semantic errors. Retrying can accumulate again or
encounter consumed history. Leaf endpoints have ready priority over recipes;
recipes use creation priority subject to dependency readiness.

Acquisition, replacement and accumulation are mandatory ordered effects.
Clearing or closing does not cancel accepted effects. Affected observations,
managed Python completion and session close join relevant work. Captured
controls preserve root, seed, traversed history and previous writer failures
independently of numerical aliasing. Physical write failure terminally prevents
new writes. Finite capacity is checked before backward consumes history or
partially admits planned effects; exhaustion reports `RESOURCE_EXHAUSTED`.
Owner admission can use a smaller conservative reservation for closed CPU
execution; uncertain or externally modified dispatch retains the original
reservation. The [history component](../components/derivative-history.md#costs-and-extension-boundary)
describes that bounded refinement. Byte and pending-effect limits remain
independent.

Live history strongly owns leaf accumulator identities and weakly refers to
retained nonleaf destinations. Views strongly own base identities. Unreachable
association cycles are collected by the runtime. Explicit JavaScript close and
actual Python wrapper collection release exposures; physical work retains
independent numerical/control pins until it drains. Session close attempts
independent cleanup even when a release fails.

The collector coalesces scheduled passes. Each pass traces the live root graph
and scans the identity registry. Persistent associations can cause repeated
scans; plain inference without them schedules no traversal. Live ownership
depends on identities, edge occurrences, payload backings, retained aliases and
pending work, rather than completed call count. Internal tests count these
occurrences; public diagnostics retain their established shape. Logical counters
establish no timing or total process-memory guarantee.

GPU gradients, optimizers, public retention hooks, higher-order graphs, JVP,
broader dtypes/layouts and general broadcasting remain outside this boundary.
