"""Native basic SGD observations for maintained language/browser conformance."""

from typing import cast

COMMON = """
import struct, warnings
if '_inspect_version' not in globals():
    def _inspect_version(value): return value._version
def tensor(data, tracked=True):
    return torch.tensor(data, dtype=torch.float32, requires_grad=tracked)
def bits(value):
    if isinstance(value, list):
        return [bits(item) for item in value]
    return 'nan' if value != value else struct.unpack('<I', struct.pack('<f', value))[0]
def state(value):
    return None if value is None else {'bits': bits(value.tolist()), 'shape': list(value.shape), 'tracking': value.requires_grad, 'version': _inspect_version(value)}
def attempt(call):
    try:
        call()
        return 'ok'
    except Exception as error:
        return type(error).__name__
"""


def sources() -> list[tuple[str, str, str]]:
    cases: list[tuple[str, str, str]] = []
    for midpoint in (2**62 + 2**38, 2**63 - 2**38):
        for offset in (-1, 0, 1):
            cases.append(
                (
                    f"integer-rounding-{midpoint + offset}",
                    COMMON
                    + f"""
p = tensor([0.]); p.grad = tensor([1.], False)
torch.optim.SGD([p], lr={midpoint + offset}).step()
report = {{'parameter': state(p)}}
""",
                    "integer",
                )
            )
    for disabled in (False, True):
        cases.append(
            (
                f"reset-special-view-{disabled}",
                COMMON
                + f"""
p = tensor([2.]); q = tensor([4.]); x = tensor([3.]); first = tensor([7.], False)
with torch.no_grad(): g = x.view(1)
p.grad = first; q.grad = g; optimizer = torch.optim.SGD([p, q])
if {disabled}:
    with torch.no_grad(): error = attempt(lambda: optimizer.zero_grad(False))
else: error = attempt(lambda: optimizer.zero_grad(False))
report = {{'error': error, 'first': state(first), 'gradient': state(g), 'associated': q.grad is g}}
""",
                "reset",
            )
        )
    for name, data, shape in (
        ("scalar", "2.", "()"),
        ("singleton", "[[[2.]]]", "(1, 1, 1)"),
        ("matrix", "[[1., 2.], [3., 4.]]", "(4,)"),
        ("empty", "[[], []]", "(0,)"),
    ):
        cases.append(
            (
                f"training-{name}",
                COMMON
                + f"""
p = tensor({data})
alias = p.view({shape})
optimizer = torch.optim.SGD([p], lr=0.125)
trace = []
for index in range(6):
    optimizer.zero_grad(set_to_none=index % 2 == 0)
    loss = p.mul(p).add(p).sum()
    loss.backward()
    gradient = p.grad
    returned = optimizer.step()
    trace.append([state(p), state(alias), state(gradient), p.grad is gradient, returned is None, len(optimizer.state)])
    with torch.no_grad():
        p.copy_(p)
report = {{'trace': trace}}
""",
                "training",
            )
        )
    cases.append(
        (
            "groups-and-occurrences",
            COMMON
            + """
p = tensor([2.]); q = tensor([4.], False)
p.grad = tensor([3.], False); q.grad = tensor([5.], False)
first = {'params': (p, p), 'lr': 0.5, 'tag': 'inert'}
empty = {'params': [], 'lr': -7.}
last = {'params': [q], 'lr': -0.25}
with warnings.catch_warnings(record=True) as recorded:
    warnings.simplefilter('always')
    optimizer = torch.optim.SGD([first, empty, last])
old_gradient = p.grad
returned = optimizer.step()
first['lr'] = 0.
optimizer.step()
report = {'p': state(p), 'q': state(q), 'same_group': optimizer.param_groups[0] is first,
    'same_param': first['params'][0] is p, 'same_gradient': p.grad is old_gradient,
    'warnings': [warning.category.__name__ for warning in recorded], 'state': len(optimizer.state), 'return': returned is None}
""",
            "groups",
        )
    )
    cases.append(
        (
            "crossed-alias-progress",
            COMMON
            + """
p = tensor([2.]); q = tensor([4.])
p.grad = q; q.grad = p
optimizer = torch.optim.SGD([p, q], lr=0.5)
optimizer.step()
report = {'p': state(p), 'q': state(q), 'p_grad': p.grad is q, 'q_grad': q.grad is p}
""",
            "alias",
        )
    )
    for lr in (
        "0.1",
        "True",
        "0.",
        "float('inf')",
        "float('nan')",
        "2**63",
        "2**63+1",
        "1e39",
        "None",
        "'invalid'",
    ):
        for name, data, gradient in (
            ("absent", "[1.]", "None"),
            ("present", "[50.29061508178711]", "tensor([502.9061279296875], False)"),
            ("empty", "[]", "tensor([], False)"),
        ):
            cases.append(
                (
                    f"coefficient-{name}-{lr}",
                    COMMON
                    + f"""
p = tensor({data}); p.grad = {gradient}
optimizer = torch.optim.SGD([p])
optimizer.param_groups[0]['lr'] = {lr}
error = attempt(optimizer.step)
report = {{'error': error, 'parameter': state(p), 'gradient': state(p.grad)}}
""",
                    "coefficient",
                )
            )
    for value in (
        "True",
        "False",
        "None",
        "0",
        "0.",
        "''",
        "'yes'",
        "-2",
        "float('nan')",
    ):
        cases.append(
            (
                f"reset-truthiness-{value}",
                COMMON
                + f"""
p = tensor([2.]); g = tensor([-0.]); p.grad = g
optimizer = torch.optim.SGD([p])
optimizer.zero_grad({value})
report = {{'gradient': state(g), 'associated': p.grad is g}}
""",
                "reset",
            )
        )
    for name, differentiate in (
        ("reset-detachment-and-alias", "saved.backward()"),
        ("reset-functional-detachment-and-alias", "torch.autograd.grad(saved, x)"),
    ):
        cases.append(
            (
                name,
                COMMON
                + f"""
p = tensor([2.]); x = tensor([3.]); g = x*x; alias = g.view([1]); saved = g*x
p.grad = g
optimizer = torch.optim.SGD([p]); optimizer.zero_grad(False)
error = attempt(lambda: {differentiate})
report = {{'gradient': state(g), 'alias': state(alias), 'associated': p.grad is g, 'error': error}}
""",
                "reset",
            )
        )
    cases.append(
        (
            "reset-view-progress",
            COMMON
            + """
p = tensor([2.]); q = tensor([4.]); x = tensor([3.]); first = tensor([7.], False); bad = (x*x).view([1])
p.grad = first; q.grad = bad
optimizer = torch.optim.SGD([p, q]); error = attempt(lambda: optimizer.zero_grad(False))
report = {'error': error, 'first': state(first), 'bad': state(bad), 'first_same': p.grad is first, 'bad_same': q.grad is bad}
""",
            "reset",
        )
    )
    cases.append(
        (
            "closure-scope-return-and-error",
            COMMON
            + """
p = tensor([2.]); p.grad = tensor([3.], False); optimizer = torch.optim.SGD([p], lr=0.5)
sentinel = object(); calls = []
def closure():
    calls.append((p+p).requires_grad)
    return sentinel
with torch.no_grad():
    same_return = optimizer.step(closure) is sentinel
    restored = not (p+p).requires_grad
class SentinelError(Exception): pass
error = SentinelError('original')
def failing():
    with torch.no_grad():
        p.copy_(tensor([8.], False))
    raise error
try:
    optimizer.step(failing)
except Exception as caught:
    same_error = caught is error
report = {'calls': calls, 'same_return': same_return, 'restored': restored, 'same_error': same_error, 'parameter': state(p)}
""",
            "closure",
        )
    )
    for name, options in (
        ("nesterov", "{'nesterov': None}"),
        ("maximize", "{'maximize': 0}"),
        ("foreach", "{'foreach': 0}"),
        ("fused", "{'fused': 0}"),
        ("differentiable-zero", "{'differentiable': 0}"),
        ("differentiable-none", "{'differentiable': None}"),
    ):
        cases.append(
            (
                f"constructor-false-form-{name}",
                COMMON
                + f"""
p = tensor([2.]); p.grad = tensor([3.], False)
optimizer = torch.optim.SGD([p], **{options})
calls = []
error = attempt(lambda: optimizer.step(lambda: calls.append(1)))
report = {{'error': error, 'calls': calls, 'defaults': {{key: [type(value).__name__, repr(value)] for key, value in optimizer.defaults.items()}}, 'parameter': state(p)}}
""",
                "constructor",
            )
        )
    invalid = {
        "empty": "torch.optim.SGD([])",
        "bare": "torch.optim.SGD(p)",
        "nonleaf": "torch.optim.SGD([p+p])",
        "cross-group": "torch.optim.SGD([{'params':[p]}, {'params':[p]}])",
        "member": "torch.optim.SGD([17])",
        "missing-params": "torch.optim.SGD([{}])",
        "unordered-group": "torch.optim.SGD([{'params':{p}}])",
        "negative-lr": "torch.optim.SGD([p], lr=-1)",
        "negative-momentum-before-unsupported": "torch.optim.SGD([p], momentum=-1, weight_decay=1)",
        "nesterov-before-params": "torch.optim.SGD([], nesterov=True)",
        "nonleaf-before-momentum": "torch.optim.SGD([p+p], momentum=1)",
        "binding": "torch.optim.SGD([p], unknown=True)",
        "reset-binding": "torch.optim.SGD([p]).zero_grad(unknown=True)",
        "step-binding": "torch.optim.SGD([p]).step(unknown=True)",
    }
    for name, expression in invalid.items():
        cases.append(
            (
                f"invalid-{name}",
                COMMON
                + f"p=tensor([2.])\nreport={{'error':attempt(lambda:{expression})}}\n",
                "binding",
            )
        )
    cases.append(
        (
            "retained-nonleaf-registration",
            COMMON
            + """
x = tensor([2.]); p = x+x; p.sum().backward(inputs=[p])
optimizer = torch.optim.SGD([p], lr=0.5); optimizer.step()
report = {'parameter': state(p), 'gradient': state(p.grad)}
""",
            "constructor",
        )
    )
    cases.append(
        (
            "reset-leaf-old-history",
            COMMON
            + """
p = tensor([2.]); g = tensor([3.]); constant = tensor([4.], False)
old = (g*constant).sum(); p.grad = g
optimizer = torch.optim.SGD([p]); optimizer.zero_grad(False)
first = attempt(old.backward); second = attempt(old.backward)
report = {'first': first, 'second': second, 'gradient': state(g), 'old_grad': state(g.grad)}
""",
            "reset",
        )
    )
    cases.append(
        (
            "registered-incoming-gradient-owner",
            COMMON
            + """
p = tensor([2.]); seed = tensor(3., False); optimizer = torch.optim.SGD([p, seed])
p.sum().backward(seed)
gradient = p.grad
with torch.no_grad():
    gradient.copy_(tensor([7.], False))
report = {'seed': state(seed), 'gradient': state(gradient), 'same_gradient': p.grad is gradient}
""",
            "acquisition",
        )
    )
    cases.append(
        (
            "repeated-gradient-reset",
            COMMON
            + """
p = tensor([2.]); q = tensor([4.]); gradient = tensor([-0.]); alias = gradient.view([1])
p.grad = gradient; q.grad = gradient
optimizer = torch.optim.SGD([p, q]); optimizer.zero_grad(False)
report = {'gradient': state(gradient), 'alias': state(alias), 'p_same': p.grad is gradient, 'q_same': q.grad is gradient}
""",
            "reset",
        )
    )
    return cases


def sgd_cases(oracle: object) -> list[dict[str, object]]:
    cases: list[dict[str, object]] = []
    for name, source, kind in sources():
        namespace: dict[str, object] = {"torch": oracle}
        exec(source, namespace)
        cases.append(
            {
                "name": name,
                "kind": kind,
                "source": source,
                "expected": cast("dict[str, object]", namespace["report"]),
            }
        )
    return cases
