# Gradient recording scopes

Use `torch.no_grad()` when a calculation should produce numbers without
recording new reverse-mode history. It does not change existing tensors or
disable explicit differentiation. This reference defines the bounded Python
context and direct JavaScript callback contract over supported CPU float32
arithmetic and whole-storage contiguous views. The
[functional gradient reference](functional-gradients.md) defines the derivative
request itself.

## Python context

```python
import torch

x = torch.tensor([2., 3.], dtype=torch.float32, requires_grad=True)
loss = (x * x).sum()
with torch.no_grad() as entered:
    assert entered is None
    replacement = x * x
    assert not replacement.requires_grad
    factory = torch.tensor(5., dtype=torch.float32, requires_grad=True)
    assert factory.requires_grad
    gradient = torch.autograd.grad(loss, x)[0]
assert replacement.tolist() == [4., 9.]
assert gradient.tolist() == [4., 6.]
assert (x + x).requires_grad
```

The supported call is the zero-argument context constructor `torch.no_grad()`.
Context entry returns `None`; exit restores the captured mode and propagates
exceptions. A context object may be reused sequentially. Each entry replaces
that object's captured previous mode, as in native PyTorch: reentering the
same object inside itself overwrites its first capture. Use separate objects
for ordinary nested contexts.
Entry assigns the capture before disabling recording; a failure of that
assignment leaves the mode intact.

Factories accepting explicit `requires_grad=True` create tracked leaves even
inside the context. Newly admitted addition, multiplication and total sum do
not track while recording is disabled. Existing graphs remain available to
`torch.autograd.grad` under its supported first-order options and consumption
rules. Tracking metadata and context transitions perform no numerical readback
or flush of unrelated lazy work.

## JavaScript callback

```typescript
session.noGrad<Result>(callback: () => PromiseLike<Result>): Promise<Result>
session.noGrad<Result>(callback: () => Result): Result
```

A synchronous callback returns its result directly. A Promise or thenable
callback returns a Promise for its result; the disabled mode lasts until
settlement. Throws and rejections restore the captured mode and preserve their
original error. Invalid callback forms raise `TypeError` before changing mode.
A closed session rejects entry with `CLOSED_SESSION`; completing a scope after
close still restores its captured boolean. The continuation retains the mode
owner while needed for restoration and releases the callback after invocation.

For example, `session.noGrad(() => x.mul(x))` returns an untracked tensor;
`session.noGrad(async () => x.mul(x))` resolves to one. Explicit
`session.tensor(..., { requiresGrad: true })` retains its factory behavior.
Closing returned handles and the session follows the ordinary
[JavaScript lifetime contract](../javascript-api.md).
The callback/Promise interface is Tabgrad's integration surface, rather than a
native PyTorch Promise API.

## One shared mode and captured restoration

Python and JavaScript address the same session's mode. Joined Python asyncio
tasks share it; separate session/interpreter environments have separate owners.
A scope saves the current boolean, disables recording, then restores exactly
that saved boolean. For two overlapping scopes A and B, the observed sequence
can be enabled, disabled after A enters, disabled after B enters, enabled when
A exits, disabled when B exits. Awaiting does not make the mode task-local.
The script host requires tasks to be joined under its
[managed-entry contract](python-host.md).

Managed entry completion or failure does not reset recording. A manually
entered context spanning entries therefore remains disabled until its exit.
Retained old contexts stay attached to their old session after reattachment;
entering one after that session closes fails. Scope bookkeeping retains the
mode owner and captured boolean; callback results and user-held tensors keep
their ordinary lifetimes.

## Tracking and views

An ordinary active view binds its source's derivative entry. A view created in
no-grad preserves the base's advertised tracking, but has no normal derivative
accumulator. A tracked such view can therefore reject as a derivative output
and be unused as an input. Treating it as a plain tensor or a new leaf would
change the observable behavior.

With recording enabled again, arithmetic or a child view of that tracked
special view produces a valid tracked node with absent input edges. A derivative
with respect to that result itself can succeed, while a request for the special
view or original base is disconnected. A mixed operation can still connect to
another input's ordinary history. Scalar, empty and multidimensional shapes
retain the usual [view rules](tensor-view.md); none of these distinctions copies
storage or fabricates an accumulator. Advertised `requires_grad` alone does
not establish that a particular derivative request is valid.

Views of plain and tracked bases, active and disabled child creation and
absent-edge nodes preserve their native provenance. Active children inherit
special no-grad origin independently of their bound entry. CPU
[`copy_`](tensor-copy.md) adds version checks, dirty-view guards and rebasing
under the [persistent update architecture](../architecture/cpu-tensor-updates.md).
No decorator, general grad-mode setter, inference mode,
forward AD, higher-order mode or GPU gradient support is provided.

## Evidence and costs

The maintained generator records context returns/errors, reuse, captured
restoration and joined asyncio overlap from PyTorch 2.14.0 build
`08187d9e0fba026dc8217405802ab5381dc88d90`, with one native intra/inter-op
thread. View fixtures cover plain, leaf, nonleaf and ordinary-view bases with
scalar, empty and matrix geometry, recording values, shapes, advertised
tracking, successful connectivity and exception classes. Real Pyodide and
direct scalar/SIMD runtime tests consume those native expectations. Browser
checks exercise the packaged ordinary CPU paths in Chrome/Firefox, including
controlled absence of JSPI; exact versions belong in verification evidence.
See the [compatibility evidence](../compatibility.md#python-tensor-evidence) and
[fixture register](../generated-files.md#python-tensor-oracle-fixtures).

Mode entry/restoration use constant metadata and do not traverse tensors.
Disabled arithmetic admits ordinary numerical work without a derivative node
or saved operands. Special views need their ordinary value/storage owner and
advertised tracking; active results retain only the derivative edges and saves
that actually exist. Lifetime tests separately check release and callback
retention. These structural facts do not establish total memory usage or an
inference-speed improvement; quantitative claims follow the
[performance policy](../performance.md).
