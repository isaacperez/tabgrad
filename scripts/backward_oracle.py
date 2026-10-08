"""Native CPU backward case sources consumed by the tensor oracle generator."""

from typing import cast

COMMON = """
import warnings

def tensor(data, tracked=True):
    return torch.tensor(data, dtype=torch.float32, requires_grad=tracked)

def state(value):
    return None if value is None else {'values': value.tolist(), 'shape': list(value.shape), 'tracking': value.requires_grad}

def attempt(call):
    try:
        return {'none': call() is None}
    except Exception as error:
        return {'error': type(error).__name__}

"""

BINDINGS = {
    "default": "out.backward()",
    "positional": "out.backward(None, False, False, [x])",
    "integers": "out.backward(None, 0, 0, [x])",
    "tensor": "out.backward(inputs=x)",
    "tuple": "out.backward(inputs=(x,))",
    "dictionary": "out.backward(inputs={'x': x})",
    "generator": "out.backward(inputs=(item for item in [x]))",
    "unused": "out.backward(inputs=[unused])",
    "used-unused": "out.backward(inputs=[x, unused])",
    "repeated": "out.backward(inputs=[x, x])",
    "repeated-nonleaf-leaf": "out.backward(inputs=[mid, mid, x, unused, x])",
    "generator-repeated": "out.backward(inputs=(item for item in [mid, mid, x, unused, x]))",
    "nonleaf": "out.backward(inputs=[mid])",
    "nonleaf-leaf": "out.backward(inputs=[mid, x])",
    "root": "out.backward(inputs=[out])",
    "empty": "out.backward(inputs=[])",
    "empty-dict": "out.backward(inputs={})",
    "untracked": "out.backward(inputs=[plain])",
    "invalid": "out.backward(inputs=[1])",
    "bad-dict": "out.backward(inputs={'x': 1})",
    "string": "out.backward(inputs='x')",
    "bad-gradient": "out.backward(gradient=1)",
    "bad-shape": "out.backward(gradient=plain)",
    "create-none": "out.backward(create_graph=None)",
    "retain-string": "out.backward(retain_graph='false')",
    "unknown-keyword": "out.backward(foo=False)",
    "too-many": "out.backward(None, False, False, [x], 1)",
    "duplicate-gradient": "out.backward(None, gradient=None)",
    "none-sequence": "out.backward([None])",
}

BINDING_SETUP = """
x = tensor([2., 3.])
unused = tensor([4., 5.])
plain = tensor([1., 1.], False)
mid = x*x
out = (mid+x).sum()
"""

BINDING_REPORT = """
report = {'call': call, 'x': state(x.grad), 'unused': state(unused.grad), 'mid': state(mid.grad), 'out': state(out.grad)}
"""

TRANSITIONS = {
    "accumulation-reset": """
x = tensor([2., 3.])
first = (x*x).sum().backward()
g = x.grad
alias = g.view(1, 2)
initial = state(g)
(x*x).sum().backward()
second = state(g)
same = x.grad is g
with torch.no_grad():
    g.copy_(tensor([0., 0.], False))
(x*x).sum().backward()
reset = state(g)
x.grad = None
(x*x).sum().backward()
report = {'none': first is None, 'initial': initial, 'second': second, 'same': same, 'reset': reset, 'new': state(x.grad), 'old': state(g), 'alias': state(alias), 'different': x.grad is not g}
""",
    "assigned-tracked": """
x = tensor([2., 3.])
g = tensor([10., 20.])
x.grad = g
(x*x).sum().backward()
report = {'same': x.grad is g, 'gradient': state(g)}
""",
    "shared-slot": """
x = tensor([2., 3.]); y = tensor([5., 7.]); g = tensor([10., 20.], False)
x.grad = g; y.grad = g
(x+y+y).sum().backward()
report = {'xSame': x.grad is g, 'ySame': y.grad is g, 'gradient': state(g)}
""",
    "assigned-own-view": """
x = tensor([2., 3.]); g = x.view(2); x.grad = g
(x*x).sum().backward()
report = {'same': x.grad is g, 'parameter': state(x), 'gradient': state(g)}
""",
    "nonleaf-replacement": """
x = tensor([2., 3.]); mid=x+x; out=mid.sum()
out.backward(inputs=[mid]); old=mid.grad
out.backward(inputs=[mid])
report = {'different': mid.grad is not old, 'old': state(old), 'new': state(mid.grad), 'leaf': state(x.grad)}
""",
    "functional-retained": """
x=tensor([2., 3.]); mid=x+x; mid.sum().backward(inputs=[mid]); old=mid.grad
returned,=torch.autograd.grad((mid+mid).sum(), x)
report={'different':mid.grad is not old, 'old':state(old), 'new':state(mid.grad), 'returned':state(returned), 'leaf':state(x.grad)}
""",
    "functional-cutoff": """
x=tensor([2., 3.]); mid=x*x; mid.sum().backward(inputs=[mid]); old=mid.grad
with torch.no_grad(): x.copy_(tensor([4., 5.],False))
returned,=torch.autograd.grad(mid.sum(),mid)
report={'different':mid.grad is not old, 'old':state(old), 'new':state(mid.grad), 'returned':state(returned), 'leaf':state(x.grad)}
""",
    "selected-failure": """
x=tensor([2.,3.]); mid=x*x
with torch.no_grad(): x.copy_(tensor([4.,5.],False))
call=attempt(lambda: mid.backward(tensor([1.,1.],False),inputs=[mid]))
report={'call':call,'retained':state(mid.grad),'leaf':state(x.grad)}
""",
    "validation-retention": """
x=tensor([2.,3.]); mid=x+x; out=mid.sum(); plain=tensor([1.,1.],False)
call=attempt(lambda:out.backward(inputs=[mid,plain]))
out.backward()
report={'call':call,'retained':state(mid.grad),'leaf':state(x.grad)}
""",
    "partial-retry": """
x=tensor([2.,3.]);y=tensor([5.,7.]);bad=x*x;good=y+y;out=(bad+good).sum()
with torch.no_grad():x.copy_(tensor([4.,5.],False))
first=attempt(lambda:out.backward());initial=state(y.grad)
second=attempt(lambda:out.backward());later=state(y.grad)
(x+y).sum().backward()
report={'first':first,'initial':initial,'second':second,'later':later,'x':state(x.grad),'y':state(y.grad)}
""",
}


def sources() -> list[tuple[str, str, str]]:
    """Return reproducible sources and one bounded semantic dispatch category."""
    cases = [
        (
            f"binding-{name}",
            COMMON
            + BINDING_SETUP
            + f"call=attempt(lambda: {expression})\n"
            + BINDING_REPORT,
            "binding",
        )
        for name, expression in BINDINGS.items()
    ]
    cases.extend(
        (name, COMMON + source, "transition") for name, source in TRANSITIONS.items()
    )
    for name, data in (
        ("scalar", "2."),
        ("singleton", "[[2.]]"),
        ("matrix", "[[1.,2.],[3.,4.]]"),
        ("empty", "[]"),
    ):
        for tracked in (False, True):
            cases.append(
                (
                    f"shape-{name}-{tracked}",
                    COMMON
                    + f"x=tensor({data});seed=tensor({data},{tracked});out=x*x\ncall=attempt(lambda:out.backward(seed))\nreport={{'call':call,'gradient':state(x.grad),'seed':state(seed)}}\n",
                    "shape",
                )
            )
    for direct in (False, True):
        for tracked in (False, True):
            cases.append(
                (
                    f"seed-alias-{direct}-{tracked}",
                    COMMON
                    + f"x=tensor([2.,3.]);seed=tensor([5.,7.],{tracked});out=x if {direct} else x.view(2)\nout.backward(seed);g=x.grad\nwith torch.no_grad():seed.copy_(tensor([9.,11.],False))\nafter=state(g)\nwith torch.no_grad():g.copy_(tensor([13.,17.],False))\nreport={{'afterSeed':after,'gradient':state(g),'seed':state(seed),'same':x.grad is g}}\n",
                    "seed-alias",
                )
            )
    for kind in (
        "directactive",
        "directnograd",
        "viewactive",
        "viewnograd",
        "viewwrite",
        "viewactiveforced",
    ):
        view = kind.startswith("view")
        mutation = "mid.copy_(y)" if kind == "viewwrite" else "base.copy_(y)"
        if kind.endswith("nograd"):
            mutation = "with torch.no_grad(): " + mutation
        marker = "marker=mid+mid\n" if kind == "viewactiveforced" else ""
        cases.append(
            (
                f"rebase-{kind}",
                COMMON
                + f"x=tensor([2.,3.]);y=tensor([5.,7.]);base=x+x;mid=base.view(2) if {view} else base\nold=(mid+mid).sum();mid.sum().backward(inputs=[mid]);initial=state(mid.grad)\n{mutation}\n{marker}afterCopy=state(mid.grad);oldCall=attempt(lambda:old.backward());afterOld=state(mid.grad)\nfreshCall=attempt(lambda:mid.sum().backward())\nreport={{'initial':initial,'afterCopy':afterCopy,'oldCall':oldCall,'afterOld':afterOld,'freshCall':freshCall,'afterFresh':state(mid.grad),'leaf':state(x.grad),'source':state(y.grad)}}\n",
                "rebase",
            )
        )
    acquisitions = {
        "add": "x+y",
        "repeated": "x+x",
        "triple": "x+x+x",
        "multiply": "x*y",
        "square": "x*x",
        "add-view": "(x+y).view(2)",
        "views-add": "x.view(2)+y.view(2)",
        "sum": "x.sum()",
        "singleton-sum": "x.sum()",
    }
    for name, expression in acquisitions.items():
        for tracked in (False, True):
            singleton = name == "singleton-sum"
            scalar_seed = name in ("sum", "singleton-sum")
            cases.append(
                (
                    f"acquisition-{name}-{tracked}",
                    COMMON
                    + f"x=tensor({'[2.]' if singleton else '[2.,3.]'});y=tensor({'[5.]' if singleton else '[5.,7.]'});seed=tensor({'5.' if scalar_seed else '[5.,7.]'},{tracked});out={expression}\nout.backward(seed);gx=x.grad;gy=y.grad;initialX=state(gx);initialY=state(gy)\nwith torch.no_grad():seed.copy_(tensor({'9.' if scalar_seed else '[9.,9.]'},False))\nafterSeedX=state(gx);afterSeedY=state(gy)\nwith torch.no_grad():gx.copy_(tensor({'[13.]' if singleton else '[13.,13.]'},False))\nreport={{'initialX':initialX,'initialY':initialY,'afterSeedX':afterSeedX,'afterSeedY':afterSeedY,'afterX':state(gx),'afterY':state(gy),'seed':state(seed)}}\n",
                    "acquisition",
                )
            )
    for direct in (False, True):
        for selected in (False, True):
            cases.append(
                (
                    f"special-view-{direct}-{selected}",
                    COMMON
                    + f"x=tensor([2.,3.])\nwith torch.no_grad():v=x.view(2)\nout=v if {direct} else v.sum()\ncall=attempt(lambda:out.backward(tensor([1.,1.],False) if {direct} else None,inputs=[v] if {selected} else None))\nreport={{'call':call,'base':state(x.grad),'view':state(v.grad),'tracking':v.requires_grad}}\n",
                    "special-view",
                )
            )
    setups = {
        "invalid-target": "out.backward(inputs=[mid,1])",
        "repeated-invalid-target": "out.backward(inputs=[mid,mid,1])",
        "seed-shape": "out.backward(tensor([1.,1.],False),inputs=[mid])",
        "create-none": "out.backward(create_graph=None,inputs=[mid])",
        "root-tracking": "plain.backward(tensor(1.,False),inputs=[mid])",
    }
    for name, expression in setups.items():
        cases.append(
            (
                f"setup-{name}",
                COMMON
                + f"x=tensor([2.,3.]);mid=x+x;out=mid.sum()\nwith torch.no_grad():plain=mid.sum()\ncall=attempt(lambda:{expression})\nmid.sum().backward()\nreport={{'call':call,'retained':state(mid.grad),'leaf':state(x.grad)}}\n",
                "setup",
            )
        )
    return cases


def backward_cases(oracle: object) -> list[dict[str, object]]:
    """Collect native observations without distributing an oracle dependency."""
    cases: list[dict[str, object]] = []
    for name, source, kind in sources():
        namespace: dict[str, object] = {"torch": oracle}
        exec(source, namespace)
        cases.append(
            {
                "name": name,
                "kind": kind,
                "source": source,
                "expected": cast(dict[str, object], namespace["report"]),
            }
        )
    return cases
