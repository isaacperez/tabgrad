"""Pinned native gradient identity and mutation observations, not runtime code."""

from typing import Protocol

COMMON = """
def filled(shape, value):
    if not shape:
        return value
    return [filled(shape[1:], value) for _ in range(shape[0])]


def identity_report(shape, kind, repetitions):
    def make(value, tracked=True, dims=shape):
        return torch.tensor(filled(dims, value), dtype=torch.float32, requires_grad=tracked)

    x, y = make(2), make(3)
    seed = make(1, False)
    anchors = [x, y, seed]
    if kind == 'direct':
        output, targets = x, [x]
    elif kind == 'add':
        output, targets = x + y, [x, y]
    elif kind == 'repeated-add':
        output, targets = x + x, [x]
    elif kind == 'mul':
        output, targets = x * y, [x, y]
    elif kind == 'equal-mul':
        y = make(2)
        anchors[1] = y
        output, targets = x * y, [x, y]
    elif kind == 'sum':
        output, targets = (x + y).sum(), [x, y]
        seed = make(1, False, ())
        anchors[2] = seed
    elif kind == 'view-same':
        v = x.view(shape)
        anchors.append(v)
        output, targets = v + y, [x, y, v]
    elif kind == 'view-reshape':
        elements = 1
        for size in shape:
            elements *= size
        v = x.view((elements,))
        anchors.append(v)
        output, targets = v, [x, v]
        seed = make(1, False, (elements,))
        anchors[2] = seed
    elif kind == 'retained':
        middle = x + y
        middle.backward(seed, inputs=[middle])
        output, targets = middle + make(4, False), [x, y, middle]
        anchors.append(middle)
    elif kind == 'branched':
        output, targets = (x + y) + x, [x, y]
    elif kind == 'copy':
        destination = make(5, False)
        destination.copy_(x)
        anchors.append(destination)
        output, targets = destination + y, [x, y, destination]
    elif kind == 'separate-calls':
        output, targets = x + y, [x, y]
        other_seed = make(4, False)
        anchors.append(other_seed)
    elif kind == 'seed-view':
        original = seed
        seed = seed.view(shape)
        anchors += [original, seed]
        output, targets = x + y, [x, y]
    else:
        raise ValueError(kind)
    targets *= repetitions
    if kind == 'separate-calls':
        results = (torch.autograd.grad(output, targets, grad_outputs=seed)
                   + torch.autograd.grad(output, targets, grad_outputs=seed)
                   + torch.autograd.grad(output, targets, grad_outputs=other_seed))
    else:
        results = torch.autograd.grad(output, targets, grad_outputs=seed)
    if kind == 'retained':
        anchors.append(middle.grad)
    all_values = list(results) + anchors
    report = {
        'identity': [[a is b for b in all_values] for a in results],
        'shape': [list(a.shape) for a in results],
        'values': [a.tolist() for a in results],
        'tracking': [a.requires_grad for a in results],
    }
    try:
        with torch.no_grad():
            results[0].copy_(make(0, False, tuple(results[0].shape)))
        report['mutationError'] = None
    except Exception as error:
        report['mutationError'] = type(error).__name__
    report['after'] = [a.tolist() for a in all_values]
    return report
"""


def gradient_identity_cases(oracle: object) -> list[dict[str, object]]:
    """Vary shape, derivative role and requested occurrences independently."""
    cases: list[dict[str, object]] = []
    for shape in [(), (0,), (2,), (1, 2), (2, 0)]:
        for kind in (
            "direct",
            "add",
            "repeated-add",
            "mul",
            "equal-mul",
            "sum",
            "view-same",
            "view-reshape",
            "retained",
            "branched",
            "copy",
            "seed-view",
            "separate-calls",
        ):
            for repetitions in (1,) if kind == "separate-calls" else (1, 3):
                namespace: dict[str, object] = {
                    "torch": oracle,
                    "shape": shape,
                    "kind": kind,
                    "repetitions": repetitions,
                }
                exec(
                    COMMON + "\nreport = identity_report(shape, kind, repetitions)",
                    namespace,
                )
                cases.append(
                    {
                        "shape": list(shape),
                        "kind": kind,
                        "repetitions": repetitions,
                        "expected": namespace["report"],
                    }
                )
    return cases


PROVENANCE = """
def filled(shape, value):
    if not shape:
        return value
    return [filled(shape[1:], value) for _ in range(shape[0])]


def copy_owner_case(shape, mode, method):
    n = 1
    for size in shape:
        n *= size
    flat = (n,)
    def make(dims, value, tracked=False):
        return torch.tensor(filled(dims,value),dtype=torch.float32,requires_grad=tracked)
    base = None if mode == 'promote' else make(flat,2,True)
    x = make(flat,4) if base is None else base+base
    view = x.view(shape)
    source = make(shape,5,True)
    seed = make(shape,3)
    if mode == 'no-grad':
        with torch.no_grad():
            view.copy_(source)
    else:
        view.copy_(source)
    if method == 'functional':
        targets = [x] if mode == 'no-grad' else [x,source,source]
        results = list(torch.autograd.grad(view,targets,seed))
    else:
        view.backward(seed)
        results = [value for value in [None if base is None else base.grad, source.grad] if value is not None]
    initial = {'tracking':[x.requires_grad,view.requires_grad], 'sourceSlotPresent':source.grad is not None, 'shapes':[list(g.shape) for g in results], 'versions':[probe_version(g) for g in results]+[probe_version(seed)], 'identity':[[a is b for b in [*results,seed,source]] for a in results], 'values':[g.tolist() for g in results]}
    selected = results[-1]
    with torch.no_grad():
        selected.copy_(make(tuple(selected.shape),0))
    after = {'values':[g.tolist() for g in results], 'seed':seed.tolist(), 'versions':[probe_version(g) for g in results]+[probe_version(seed)]}
    if method == 'backward':
        owner = source if mode != 'no-grad' else base
        assert owner is not None
        old = owner.grad
        owner.backward(seed if mode != 'no-grad' else seed.view(flat))
        after['sameSlotAfterAccumulation'] = old is owner.grad
        after['accumulated'] = owner.grad.tolist()
        after['accumulatedVersion'] = probe_version(owner.grad)
    return {'initial':initial,'after':after}

def view_result_case(shape, dirty):
    n=1
    for size in shape: n*=size
    def filled(dims,value):
        if not dims: return value
        return [filled(dims[1:],value) for _ in range(dims[0])]
    def make(dims,value,tracked=False):
        return torch.tensor(filled(dims,value),dtype=torch.float32,requires_grad=tracked)
    flat=(n,)
    leaf=make(flat,2,True)
    x=leaf+leaf
    view=x.view(shape)
    if dirty:
        with torch.no_grad(): view.copy_(make(shape,5))
    original_seed=make(shape,3)
    gradient=torch.autograd.grad(view,x,original_seed)[0]
    source=make(flat,7,True)
    seed=make(flat,4)
    try:
        gradient.copy_(source)
    except Exception as error:
        return {'phase':'copy','error':type(error).__name__,'tracking':gradient.requires_grad,'version':probe_version(gradient)}
    try:
        result=torch.autograd.grad(gradient,source,seed)[0]
    except Exception as error:
        return {'phase':'grad','error':type(error).__name__,'tracking':gradient.requires_grad,'version':probe_version(gradient)}
    with torch.no_grad(): result.copy_(make(flat,0))
    return {'phase':'returned','tracking':gradient.requires_grad,'version':probe_version(gradient),'identitySeed':result is seed,'result':result.tolist(),'seed':seed.tolist()}
"""


class NativeVersionTensor(Protocol):
    """The only native-oracle member consumed by these controls."""

    @property
    def _version(self) -> int: ...


def native_version(value: NativeVersionTensor) -> int:
    """Read only the pinned native oracle version, not a browser API."""
    # The pinned native counter is deliberately inspected only by development controls.
    return value._version  # pyright: ignore[reportPrivateUsage]


def gradient_provenance_cases(oracle: object) -> list[dict[str, object]]:
    """Record CopySlices clone and modified/unchanged view result classes."""
    cases: list[dict[str, object]] = []
    for shape in ((1, 2), (2, 1), (2, 0)):
        for mode in ("active", "promote", "no-grad"):
            for method in ("functional", "backward"):
                namespace: dict[str, object] = {
                    "torch": oracle,
                    "probe_version": native_version,
                    "shape": shape,
                    "mode": mode,
                    "method": method,
                }
                exec(
                    PROVENANCE + "\nreport = copy_owner_case(shape, mode, method)",
                    namespace,
                )
                cases.append(
                    {
                        "kind": "copy",
                        "shape": list(shape),
                        "mode": mode,
                        "method": method,
                        "expected": namespace["report"],
                    }
                )
        for dirty in (False, True):
            namespace = {
                "torch": oracle,
                "probe_version": native_version,
                "shape": shape,
                "dirty": dirty,
            }
            exec(PROVENANCE + "\nreport = view_result_case(shape, dirty)", namespace)
            cases.append(
                {
                    "kind": "view",
                    "shape": list(shape),
                    "dirty": dirty,
                    "expected": namespace["report"],
                }
            )
    return cases
