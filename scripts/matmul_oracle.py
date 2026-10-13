"""Native 2D matrix call/history observations for the maintained tensor oracle."""

from typing import cast

COMMON = """
import warnings
def tensor(data, tracked=False):
    return torch.tensor(data, dtype=torch.float32, requires_grad=tracked)
def state(value):
    return None if value is None else {'shape': list(value.shape), 'values': value.tolist(), 'tracking': value.requires_grad}
def attempt(call):
    with warnings.catch_warnings(record=True) as seen:
        warnings.simplefilter('always')
        try:
            result = call()
            if result is NotImplemented: report = {'not_implemented': True}
            elif isinstance(result, torch.Tensor): report = {'tensor': state(result), 'same_a': result is a, 'same_b': result is b}
            else: report = {'none': result is None}
        except Exception as error:
            report = {'error': type(error).__name__}
        report['warnings'] = [type(w.message).__name__ for w in seen]
        return report
"""
BASE = """
a = tensor([[1.,2.,3.],[4.,5.,6.]])
b = tensor([[7.,8.],[9.,10.],[11.,12.]])
seed = tensor([[1.,2.],[3.,4.]])
"""


def sources() -> list[tuple[str, str]]:
    """Sources run unchanged against native and packaged Python presentations."""
    cases: list[tuple[str, str]] = []
    forms = (
        "torch.matmul(a,b)", "torch.matmul(a,other=b)",
        "torch.matmul(input=a,other=b)", "torch.matmul(a,b,out=None)",
        "a.matmul(b)", "a.matmul(other=b)", "a @ b", "a.__matmul__(other=b)",
        "torch.Tensor.matmul(a,b)", "torch.Tensor.__matmul__(a,b)",
        "b.__rmatmul__(a)", "a.__rmatmul__(other=b)",
    )
    invalid = (
        "torch.matmul()", "torch.matmul(a)", "torch.matmul(a,b,a)",
        "torch.matmul(a,b,alpha=1)", "torch.matmul(a,b,other=b)",
        "torch.matmul(a,b,input=a)", "torch.matmul(a,1)", "torch.matmul(1,b)",
        "torch.matmul(a,b,out=1)", "a.matmul()", "a.matmul(b,out=None)",
        "a.matmul(tensor2=b)", "a.matmul(b,b)", "a.matmul(b,other=b)",
        "torch.Tensor.matmul(None,b)", "a.__matmul__(1)", "a.__rmatmul__(1)",
        "a @ 1", "1 @ a", "a.__matmul__(b,out=None)", "a.__rmatmul__(b,out=None)",
        "a.__matmul__()", "a.__matmul__(b,b)", "a.__matmul__(b,other=b)",
    )
    for expression in (*forms, *invalid):
        cases.append(("binding:" + expression, COMMON + BASE + f"report = attempt(lambda: {expression})\n"))
    cases.append(("operator-assignment", COMMON + BASE + """
old = a
a @= b
report = {'result': state(a), 'old': state(old), 'same': a is old}
"""))
    for m, k, n in ((0, 3, 2), (2, 0, 4), (2, 3, 0), (0, 0, 4), (3, 0, 0), (0, 2, 0), (0, 0, 0), (1, 1, 1), (3, 2, 5)):
        cases.append((f"geometry:{m}/{k}/{n}", COMMON + f"""
a = tensor([1.] * {m*k}, True).view({m},{k})
b = tensor([2.] * {k*n}, True).view({k},{n})
y = a @ b
seed = tensor([1.] * {m*n}).view({m},{n})
ga, gb = torch.autograd.grad(y, (a,b), grad_outputs=seed)
report = {{'output': state(y), 'gradients': [state(ga), state(gb)]}}
"""))
    for left, right in (("tensor(2.)", "b"), ("a", "tensor(2.)"), ("a", "tensor([[1.,2.],[3.,4.]])"),
                        ("tensor([]).view(0,3)", "tensor([]).view(4,0)")):
        cases.append((f"shape:{left}/{right}", COMMON + BASE + f"report = attempt(lambda: {left} @ {right})\n"))
    for position in (0, 1):
        for mutate in ("a", "b", "y"):
            for both in (False, True):
                cases.append((f"save:{position}/{mutate}/{both}", COMMON + f"""
a = tensor([[1.,2.,3.],[4.,5.,6.]], {both or position == 0})
b = tensor([[7.,8.],[9.,10.],[11.,12.]], {both or position == 1})
y = a @ b
seed = tensor([[1.,2.],[3.,4.]])
with torch.no_grad(): {mutate}.copy_({mutate})
target = a if {position} == 0 else b
report = attempt(lambda: torch.autograd.grad(y, (target,), grad_outputs=seed)[0])
"""))
    for tracked_b in (False, True):
        for mutate in ("none", "a", "b"):
            mutation = "pass" if mutate == "none" else f"with torch.no_grad(): {mutate}.copy_({mutate})"
            cases.append((f"no-grad-view:{tracked_b}/{mutate}", COMMON + f"""
a = tensor([[1.,2.],[3.,4.]], True)
b = tensor([[5.,6.],[7.,8.]], {tracked_b})
with torch.no_grad(): v = a.view(2,2)
y = v @ b
{mutation}
call = attempt(lambda: y.sum().backward())
report = {{'call': call, 'tracking': y.requires_grad, 'a': state(a.grad), 'b': state(b.grad)}}
"""))
    cases.append(("repeated-target-and-operands", COMMON + """
a = tensor([[1.,2.],[3.,4.]], True)
b = a
seed = tensor([[1.,2.],[3.,4.]])
y = a @ a
ga, gb = torch.autograd.grad(y, (a,a), grad_outputs=seed)
report = {'same': ga is gb, 'gradient': state(ga), 'leaf_none': a.grad is None}
"""))
    cases.append(("persistent-accumulation-reset", COMMON + """
a = tensor([[1.,2.],[3.,4.]], True)
b = tensor([[5.,6.],[7.,8.]])
(a @ b).sum().backward()
g = a.grad
first = state(g)
(a @ b).sum().backward()
second = state(g)
same = a.grad is g
optimizer = torch.optim.SGD([a], lr=0.125)
optimizer.zero_grad(set_to_none=False)
reset_same = a.grad is g
zero = state(g)
(a @ b).sum().backward()
report = {'first': first, 'second': second, 'same': same, 'reset_same': reset_same, 'zero': zero, 'after': state(g)}
"""))
    cases.append(("per-node-partial-progress", COMMON + """
a = tensor([[2.]], True); b = tensor([[3.]], True)
good_a = tensor([[5.]], True); good_b = tensor([[7.]], True)
bad = a @ b
with torch.no_grad(): a.copy_(a)
good = good_a @ good_b
root = bad.sum() + good.sum()
first = attempt(lambda: root.backward())
report = {'first': first, 'a': state(a.grad), 'b': state(b.grad), 'good_a': state(good_a.grad), 'good_b': state(good_b.grad),
          'retry': attempt(lambda: root.backward())}
"""))
    return cases


def matmul_cases(oracle: object) -> list[dict[str, object]]:
    cases: list[dict[str, object]] = []
    for name, source in sources():
        namespace: dict[str, object] = {"torch": oracle}
        exec(source, namespace)
        cases.append({"name": name, "source": source, "expected": cast(dict[str, object], namespace["report"])})
    return cases
