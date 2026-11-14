"""Native controls for pointwise shapes and receiving-gradient identities."""

from math import prod
from typing import cast


def broadcast_cases(oracle: object) -> list[dict[str, object]]:
    shapes: list[tuple[list[int], list[int]]] = [
        ([], [2, 3]),
        ([2, 1], [3]),
        ([1, 3], [2, 1]),
        ([2, 1, 3], [1, 4, 1]),
        ([1, 2], [2]),
        ([1, 1], []),
        ([0, 3], [1, 3]),
        ([2, 0, 3], [3]),
        ([1, 1, 1, 1, 2, 1], [3]),
        ([2, 1, 3, 1], [1, 4, 1, 2]),
        *[
            ([1, length], [2, 1])
            for length in (3, 4, 5, 63, 64, 65, 127, 128, 129, 257)
        ],
    ]
    cases: list[dict[str, object]] = []
    for operation in ("add", "mul"):
        for index, (left_shape, right_shape) in enumerate(shapes):
            left = [float(position % 5 + 1) for position in range(prod(left_shape))]
            right = [float(position % 3 + 1) for position in range(prod(right_shape))]
            for negative_zero in (False, True) if index in (0, 4, 5) else (False,):
                source = f"""
import struct, math
a = torch.tensor({left!r}, dtype=torch.float32, requires_grad=True).view({left_shape!r})
b = torch.tensor({right!r}, dtype=torch.float32, requires_grad=True).view({right_shape!r})
y = getattr(a, {operation!r})(b)
seed_values = [-0.0 if {negative_zero!r} else ((i % 3 + 1) * 0.5) for i in range(math.prod(list(y.shape)))]
seed = torch.tensor(seed_values, dtype=torch.float32).view(list(y.shape))
ga, gb = torch.autograd.grad(y, (a, b), grad_outputs=seed)
def state(value):
    return {{'shape': list(value.shape), 'bits': [struct.unpack('<I', struct.pack('<f', v))[0] for v in value.view(-1).tolist()], 'tracking': value.requires_grad}}
report = {{'output': state(y), 'left': state(ga), 'right': state(gb), 'sameSeed': [ga is seed, gb is seed], 'sameEachOther': ga is gb}}
"""
                namespace: dict[str, object] = {"torch": oracle}
                exec(source, namespace)
                cases.append(
                    {
                        "name": f"{operation}:{index}:negative-zero={negative_zero}",
                        "operation": operation,
                        "leftShape": left_shape,
                        "rightShape": right_shape,
                        "left": left,
                        "right": right,
                        "negativeZeroSeed": negative_zero,
                        "source": source,
                        "expected": cast(dict[str, object], namespace["report"]),
                    }
                )
    return cases


def broadcast_composition_cases(oracle: object) -> list[dict[str, object]]:
    sources: dict[str, str] = {}
    for repetitions, rate in ((1, 0.125), (4, 0.0), (8, 0.0)):
        sources[f"training:{repetitions}"] = f"""
x = torch.tensor([[1., 2.], [3., 4.]], dtype=torch.float32)
w = torch.tensor([[1., 0.], [0., 1.]], dtype=torch.float32, requires_grad=True)
b = torch.tensor([0.5, -0.5], dtype=torch.float32, requires_grad=True)
alias = b.view(1, 2)
optimizer = torch.optim.SGD([w, b], lr={rate})
for _ in range({repetitions}):
    optimizer.zero_grad()
    prediction = x.matmul(w) + b
    loss = (prediction * prediction).sum()
    loss.backward()
    optimizer.step()
report = {{'w': w.view(-1).tolist(), 'b': b.tolist(), 'alias': alias.view(-1).tolist(), 'wg': w.grad.view(-1).tolist(), 'bg': b.grad.tolist()}}
"""
    sources["partial-version"] = """
x = torch.tensor([[1., 2., 3.], [4., 5., 6.]], dtype=torch.float32, requires_grad=True)
b = torch.tensor([1., 2., 3.], dtype=torch.float32, requires_grad=True)
out = (x * x + b).sum()
with torch.no_grad():
    x.copy_(torch.tensor([[2., 3., 4.], [5., 6., 7.]], dtype=torch.float32))
try:
    out.backward()
except RuntimeError:
    failed = True
else:
    failed = False
report = {'failed': failed, 'x': x.grad is None, 'bias': b.grad.tolist()}
"""
    sources["captured-seed"] = """
x = torch.tensor([[2.], [3.]], dtype=torch.float32, requires_grad=True)
b = torch.tensor([[4., 5., 6.]], dtype=torch.float32, requires_grad=True)
out = x * b
seed = torch.tensor([[1., 1., 1.], [1., 1., 1.]], dtype=torch.float32)
gx, gb, repeated = torch.autograd.grad(out, (x, b, b), grad_outputs=seed)
with torch.no_grad():
    seed.copy_(torch.tensor([[0., 0., 0.], [0., 0., 0.]], dtype=torch.float32))
    b.copy_(torch.tensor([[9., 9., 9.]], dtype=torch.float32))
report = {'output': out.view(-1).tolist(), 'x': gx.view(-1).tolist(), 'bias': gb.view(-1).tolist(), 'repeat': repeated.view(-1).tolist()}
"""
    cases: list[dict[str, object]] = []
    for name, source in sources.items():
        namespace: dict[str, object] = {"torch": oracle}
        exec(source, namespace)
        cases.append({"name": name, "source": source, "expected": namespace["report"]})
    return cases
