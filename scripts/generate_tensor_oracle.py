"""Generate bounded Python tensor expectations using the installed native oracle."""

from __future__ import annotations

import argparse
import ast
import asyncio
import importlib
import json
import math
import struct
from pathlib import Path
from typing import Protocol, cast

from backward_oracle import backward_cases
from sgd_oracle import sgd_cases

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "js-tests/fixtures/python-tensor-oracle.json"
VERSION = "2.14.0"
REVISION = "08187d9e0fba026dc8217405802ab5381dc88d90"
METADATA = """[list(result.shape), repr(result.shape), type(result.shape).__name__,
repr(result.dtype), isinstance(result.dtype, torch.dtype),
repr(result.device), str(result.device), result.device.type, result.device.index,
isinstance(result.device, torch.device)]"""
INPUTS = (
    ("finite", "[1.25, -2.5, 3, True]", "(0.75, 2.5, -1, False)"),
    ("empty", "[]", "()"),
    ("float32-edges", "[-0.0, 16777217, 1e-45, 1e40]", "[-0.0, 1, 1e-45, -1e40]"),
)
RANK_INPUTS = (
    ("scalar", "2", "True"),
    ("matrix", "[[1, 2], [3, 4]]", "((5, 6), (7, 8))"),
    ("rank-three", "[[[1, 2]], [[3, 4]]]", "(((5, 6),), ((7, 8),))"),
    ("singletons", "[[[2]]]", "(((3,),),)"),
    ("nested-empty", "[[], []]", "((), ())"),
    ("rank-three-empty", "[[[]]]", "(((),),)"),
)
OPERATIONS = ("torch.add(left, right)", "left.add(right)", "left + right")
MUL_OPERATIONS = (
    "left * right",
    "left.mul(right)",
    "left.mul(other=right)",
    "torch.mul(left, right)",
    "torch.mul(left, other=right)",
    "torch.mul(input=left, other=right)",
    "torch.mul(left, right, out=None)",
)
MUL_INPUTS = (
    *INPUTS,
    *RANK_INPUTS,
    ("rounding", "[0.1, -3.1, 1e20, 1e-20, 7]", "[0.2, 0.7, 1e-10, -1e10, -3]"),
    ("signed-zero", "[0., -0., 0., -0.]", "[2., 2., -2., -2.]"),
    ("underflow", "[1e-45, -1e-45, 1.17549435e-38]", "[0.5, 0.5, 0.5]"),
    ("overflow", "[float.fromhex('0x1.fffffep127')] * 2", "[2., -2.]"),
    ("separate-multiply-add", "[1. + 2.**-23] * 5", "[1. - 2.**-23] * 5"),
    (
        "nonfinite",
        "[float('nan'), float('inf'), -float('inf'), 0., -0.]",
        "[1., -2., -3., float('inf'), float('inf')]",
    ),
)
SUM_INPUTS = (
    ("scalar", "3", "exact"),
    ("singleton", "[-5]", "exact"),
    ("matrix", "[[1, -2], [3, 4]]", "exact"),
    ("empty", "[[], []]", "exact"),
    ("negative-zero", "[-0.0, -0.0]", "exact"),
    ("subnormal", "[1e-45, 1e-45, -1e-45]", "exact"),
    ("cancellation", "[1e20, 1, -1e20, 1]", "bounded"),
    ("mixed-magnitudes", "[1e-10, -2.25, 1e4, -1e4, 3.1]", "bounded"),
    ("nan", "[1, float('nan'), 2]", "exact"),
    ("positive-infinity", "[1, float('inf'), 2]", "exact"),
    ("negative-infinity", "[1, -float('inf'), 2]", "exact"),
    ("opposite-infinities", "[float('inf'), -float('inf')]", "exact"),
    ("overflow", "[float.fromhex('0x1.fffffep127')] * 2", "overflow"),
    (
        "overflow-cancellation",
        "[float.fromhex('0x1.fffffep127')] * 2 + [-float.fromhex('0x1.fffffep127')] * 2",
        "overflow",
    ),
    (
        "extreme-alternating",
        "[float.fromhex('0x1.fffffep127'), -float.fromhex('0x1.fffffep127')] * 2",
        "exact",
    ),
    *(
        (f"tail-{n}", f"[(i % 11 - 5) * 0.1 for i in range({n})]", "bounded")
        for n in (3, 4, 5, 127, 128, 129, 255, 256, 257, 1025)
    ),
)
ERRORS = (
    "torch.mul()",
    "torch.mul(left)",
    "torch.mul(left, right, left)",
    "torch.mul(left, right, alpha=1)",
    "torch.mul(left, other=right, input=left)",
    "left.mul(right, out=None)",
    "left.mul(right, other=right)",
    "torch.Tensor.mul(None, left)",
    "torch.mul(left, 'x')",
    "torch.mul(left, torch.tensor([1, 2], dtype=torch.float32))",
    "torch.sum()",
    "torch.sum(1)",
    "torch.sum([1])",
    "torch.Tensor.sum(None)",
    "torch.sum(left, input=left)",
    "torch.sum(left, unknown=True)",
    "left.view()",
    "left.view(True)",
    "left.view(2.0, 2)",
    "left.view(None)",
    "left.view(-2, 2)",
    "left.view(-1, -1)",
    "left.view(3, 2)",
    "torch.tensor([], dtype=torch.float32).view(0, -1)",
    "torch.tensor([], dtype=torch.float32).view(())",
    "torch.tensor([1, 'x'], dtype=torch.float32)",
    "torch.tensor([1j], dtype=torch.float32)",
    "torch.tensor([[1], [2, 3]], dtype=torch.float32)",
    "torch.tensor([1, [2]], dtype=torch.float32)",
    "torch.tensor([[1], 2], dtype=torch.float32)",
    "torch.tensor([10**1000], dtype=torch.float32)",
    "torch.add(left, right, alpha=True)",
    "torch.add(left, 'x')",
    "left.add(right, out=None)",
    "torch.add(left, right, unknown=True)",
    "torch.add(left, torch.tensor([1, 2], dtype=torch.float32))",
    "torch.tensor([], dtype=torch.float32, requires_grad=0)",
    "torch.tensor([], dtype=torch.float32, pin_memory=0)",
    "torch.Size([1.0])",
    "torch.dtype()",
)
VIEW_INPUTS = (
    ("positional", "[1, 2, 3, 4, 5, 6]", "2, 3"),
    ("tuple", "[1, 2, 3, 4]", "(2, 2)"),
    ("list", "[1, 2, 3, 4]", "[2, 2]"),
    ("inferred", "[1, 2, 3, 4, 5, 6]", "-1, 3"),
    ("scalar", "[2]", "()"),
    ("scalar-list", "2", "[]"),
    ("singletons", "2", "1, -1, 1"),
    ("empty", "[]", "2, 0, 3"),
    ("empty-inferred", "[]", "-1, 2"),
)
METADATA_CASES = (
    "[repr(left.shape[:]), repr(left.shape + (3,)), repr(2 * left.shape), left.shape.numel()]",
    "[torch.float32.is_floating_point, torch.float32.is_complex, torch.float32.is_signed]",
    "[torch.device('cpu') == left.device, left.device == 'cpu', left.dtype is torch.float32]",
    "[repr(torch.Size([True, -1])), torch.Size([]).numel()]",
)

GRAD_SETUP = "x = torch.tensor([2., 3.], dtype=torch.float32, requires_grad=True)\n"
GRAD_CASES = (
    (
        "branches-repeated-inputs",
        GRAD_SETUP
        + "y = torch.tensor([5., 7.], dtype=torch.float32, requires_grad=True)\nloss = (x * y + x * x).sum()\nresults = torch.autograd.grad(loss, (x, y, x))",
    ),
    (
        "interior-sum",
        GRAD_SETUP
        + "factor = torch.tensor(3., dtype=torch.float32, requires_grad=True)\nresults = torch.autograd.grad(x.sum() * factor, [x, factor])",
    ),
    (
        "intermediate-and-ancestor",
        GRAD_SETUP
        + "intermediate = x * x\nresults = torch.autograd.grad(intermediate.sum(), (intermediate, x))",
    ),
    (
        "matrix-seed-view",
        GRAD_SETUP
        + "view = x.view(1, 2)\nseed = torch.tensor([[2., 3.]], dtype=torch.float32)\nresults = torch.autograd.grad([view], x, [seed])",
    ),
    (
        "hidden-computed-factor",
        GRAD_SETUP
        + "plain = torch.tensor([5., 7.], dtype=torch.float32)\nfactor = plain * plain\nloss = (x * factor).sum()\ndel plain, factor\nloss.tolist()\nresults = torch.autograd.grad(loss, x)",
    ),
    (
        "empty-input",
        "x = torch.tensor([[], []], dtype=torch.float32, requires_grad=True)\nresults = torch.autograd.grad((x * x).sum(), x)",
    ),
    (
        "scalar",
        "x = torch.tensor(3., dtype=torch.float32, requires_grad=True)\nresults = torch.autograd.grad(x * x, x)",
    ),
    (
        "singleton-rank",
        "x = torch.tensor([[[3.]]], dtype=torch.float32, requires_grad=True)\nresults = torch.autograd.grad(x * x, x)",
    ),
    (
        "self-does-not-consume",
        GRAD_SETUP
        + "square = x * x\nseed = torch.tensor([2., 3.], dtype=torch.float32)\nfirst = torch.autograd.grad(square, square, seed)\nresults = first + torch.autograd.grad(square, x, seed)",
    ),
    (
        "payload-free-repeated",
        GRAD_SETUP
        + "y = (x + x).view(1, 2).sum()\nresults = torch.autograd.grad(y, x) + torch.autograd.grad(y, x)",
    ),
    (
        "consumed-irrelevant-ancestor",
        GRAD_SETUP
        + "middle = x * x\nloss = middle.sum()\ntorch.autograd.grad(loss, x)\nresults = torch.autograd.grad(loss, middle)",
    ),
    (
        "empty-output-explicit-seed",
        "x = torch.tensor([], dtype=torch.float32, requires_grad=True)\nseed = torch.tensor([], dtype=torch.float32)\nresults = torch.autograd.grad(x * x, x, seed)",
    ),
)
GRAD_ERRORS = (
    (GRAD_SETUP, "torch.autograd.grad(x * x, x)"),
    (
        GRAD_SETUP,
        "torch.autograd.grad(x.sum(), torch.tensor([2., 3.], dtype=torch.float32))",
    ),
    (
        GRAD_SETUP,
        "torch.autograd.grad(x.sum(), torch.tensor([2., 3.], dtype=torch.float32, requires_grad=True))",
    ),
    (
        GRAD_SETUP,
        "torch.autograd.grad(x * x, x, torch.tensor([[1., 1.]], dtype=torch.float32))",
    ),
    (
        GRAD_SETUP + "loss = (x * x).sum()\ntorch.autograd.grad(loss, x)\n",
        "torch.autograd.grad(loss, x)",
    ),
)


def gradient_cases(oracle: _OracleModule) -> list[dict[str, object]]:
    """Record native functional results, shape and first-order tracking facts."""
    cases: list[dict[str, object]] = []
    for name, source in GRAD_CASES:
        namespace: dict[str, object] = {"torch": oracle}
        exec(source, namespace)
        expected: object = eval(
            "[[list(value.shape), value.tolist(), value.requires_grad] for value in results]",
            namespace,
        )
        cases.append({"name": name, "source": source, "expected": expected})
    return cases


def gradient_errors(oracle: _OracleModule) -> list[dict[str, str]]:
    """Record supported failure categories without asserting excluded modes."""
    cases: list[dict[str, str]] = []
    for source, expression in GRAD_ERRORS:
        namespace: dict[str, object] = {"torch": oracle}
        exec(source, namespace)
        try:
            eval(expression, namespace)
        except Exception as error:
            cases.append(
                {
                    "source": source,
                    "expression": expression,
                    "type": type(error).__name__,
                }
            )
        else:
            raise AssertionError(f"Expected gradient rejection: {expression}")
    return cases


GRAD_PROGRESS_SETUP = """x = torch.tensor(x_data, dtype=torch.float32, requires_grad=True)
y = torch.tensor(y_data, dtype=torch.float32, requires_grad=True)
shared = x * x if kind == 'shared' else y
if good_first:
    good = shared * shared if good_saved else shared + shared
bad = shared * y if kind == 'shared' else x * y if kind == 'pruned-save' else x * x
if not good_first:
    good = shared * shared if good_saved else shared + shared
if kind in ('view-copy', 'direct-copy'):
    good = y + y
    if kind == 'view-copy':
        good = good.view(tuple(good.shape))
    good.copy_(y)
root = (good + bad if swap_operands else bad + good)
if repeated:
    root = root + good
root = root.sum()
with torch.no_grad():
    changed = y if kind == 'shared' else x
    changed.copy_(torch.tensor(changed.tolist(), dtype=torch.float32))
tensors = {'root': root, 'good': good, 'bad': bad, 'shared': shared, 'x': x, 'y': y}
report = []
for output_name, input_names in calls:
    try:
        result = torch.autograd.grad(tensors[output_name], [tensors[name] for name in input_names],
                                     None if output_name == 'root' else torch.tensor(seed_data, dtype=torch.float32))
        report.append({'values': [value.tolist() for value in result],
                       'shapes': [list(value.shape) for value in result],
                       'tracking': [value.requires_grad for value in result]})
    except RuntimeError as error:
        message = str(error).lower()
        if 'modified' in message:
            category = 'SAVED_VERSION_MISMATCH'
        elif 'second time' in message or 'consumed' in message:
            category = 'CONSUMED_HISTORY'
        else:
            raise
        report.append({'error': category, 'type': type(error).__name__})
"""


def gradient_progress_cases(oracle: _OracleModule) -> list[dict[str, object]]:
    """Freeze partial progress against native CPU, independently of Tabgrad scheduling."""
    cases: list[dict[str, object]] = []
    empty_data: list[list[float]] = [[], []]
    variants: tuple[
        tuple[str, str, bool, bool, bool, bool, object, object, object], ...
    ] = (
        (
            "newer-good",
            "ordinary",
            False,
            True,
            False,
            False,
            [2.0, 3.0],
            [5.0, 7.0],
            [1.0, 1.0],
        ),
        (
            "operand-swap",
            "ordinary",
            False,
            True,
            True,
            False,
            [2.0, 3.0],
            [5.0, 7.0],
            [1.0, 1.0],
        ),
        (
            "older-good",
            "ordinary",
            True,
            True,
            False,
            False,
            [2.0, 3.0],
            [5.0, 7.0],
            [1.0, 1.0],
        ),
        (
            "unsaved-good",
            "ordinary",
            False,
            False,
            False,
            False,
            [2.0, 3.0],
            [5.0, 7.0],
            [1.0, 1.0],
        ),
        (
            "repeated-good",
            "ordinary",
            False,
            True,
            False,
            True,
            [2.0, 3.0],
            [5.0, 7.0],
            [1.0, 1.0],
        ),
        (
            "shared-ready",
            "shared",
            False,
            True,
            False,
            True,
            [2.0, 3.0],
            [5.0, 7.0],
            [1.0, 1.0],
        ),
        (
            "pruned-save",
            "pruned-save",
            False,
            True,
            False,
            False,
            [2.0, 3.0],
            [5.0, 7.0],
            [1.0, 1.0],
        ),
        (
            "view-copy",
            "view-copy",
            False,
            True,
            False,
            False,
            [2.0, 3.0],
            [5.0, 7.0],
            [1.0, 1.0],
        ),
        (
            "direct-copy",
            "direct-copy",
            False,
            True,
            False,
            False,
            [2.0, 3.0],
            [5.0, 7.0],
            [1.0, 1.0],
        ),
        ("scalar", "ordinary", False, True, False, False, 2.0, 5.0, 1.0),
        (
            "singleton",
            "ordinary",
            False,
            True,
            False,
            False,
            [[[2.0]]],
            [[[5.0]]],
            [[[1.0]]],
        ),
        (
            "matrix",
            "ordinary",
            False,
            True,
            False,
            False,
            [[2.0, 3.0], [4.0, 5.0]],
            [[5.0, 7.0], [9.0, 11.0]],
            [[1.0, 1.0], [1.0, 1.0]],
        ),
        (
            "empty",
            "ordinary",
            False,
            True,
            False,
            False,
            empty_data,
            empty_data,
            empty_data,
        ),
    )
    for (
        name,
        kind,
        good_first,
        good_saved,
        swap,
        repeated,
        x_data,
        y_data,
        seed_data,
    ) in variants:
        inputs = ["x"] if kind in ("shared", "pruned-save") else ["x", "y"]
        calls = [
            ("root", inputs),
            ("root", inputs),
            ("good", ["shared"] if kind == "shared" else ["y"]),
            ("bad", ["shared"] if kind == "shared" else ["x"]),
            ("bad", ["bad"]),
        ]
        if kind == "shared":
            calls.append(("shared", ["x"]))
        config = {
            "kind": kind,
            "good_first": good_first,
            "good_saved": good_saved,
            "swap_operands": swap,
            "repeated": repeated,
            "x_data": x_data,
            "y_data": y_data,
            "seed_data": seed_data,
            "calls": calls,
        }
        prefix = "\n".join(f"{key} = {value!r}" for key, value in config.items()) + "\n"
        source = prefix + GRAD_PROGRESS_SETUP
        namespace: dict[str, object] = {"torch": oracle}
        exec(source, namespace)
        cases.append(
            {
                "name": name,
                "config": config,
                "source": source,
                "expected": namespace["report"],
            }
        )
    return cases


NO_GRAD_CASES = (
    (
        "entry-binding-order",
        """x = torch.tensor(2., dtype=torch.float32, requires_grad=True)
report = [torch.no_grad().prev]
try:
    torch.no_grad.__enter__(None)
except AttributeError:
    report.append('AttributeError')
else:
    raise AssertionError('Invalid receiver was accepted')
report.append((x + x).requires_grad)
class RejectCapture(torch.no_grad):
    def __setattr__(self, name, value):
        if name == 'prev' and value is True:
            raise ValueError('capture rejected')
        super().__setattr__(name, value)
try:
    with RejectCapture():
        raise AssertionError('Invalid capture entered its body')
except ValueError:
    report.append('ValueError')
report.append((x + x).requires_grad)
""",
    ),
    (
        "joined-asyncio-overlap",
        """import asyncio
report = []
async def joined_scopes():
    x = torch.tensor(2., dtype=torch.float32, requires_grad=True)
    first_entered, second_entered, first_exited = asyncio.Event(), asyncio.Event(), asyncio.Event()
    async def first():
        report.append((x + x).requires_grad)
        with torch.no_grad():
            report.append((x + x).requires_grad)
            first_entered.set()
            await second_entered.wait()
        report.append((x + x).requires_grad)
        first_exited.set()
    async def second():
        await first_entered.wait()
        with torch.no_grad():
            report.append((x + x).requires_grad)
            second_entered.set()
            await first_exited.wait()
        report.append((x + x).requires_grad)
    await asyncio.gather(first(), second())
await joined_scopes()
""",
    ),
    (
        "context-binding-errors",
        """x = torch.tensor(2., dtype=torch.float32, requires_grad=True)
report = []
for expression in ('torch.no_grad(1, 2)', 'torch.no_grad(unknown=True)',
                   'torch.no_grad().__enter__(1)', 'torch.no_grad().__exit__()'):
    try:
        eval(expression)
    except TypeError:
        report.append('TypeError')
    else:
        raise AssertionError(expression)
    report.append((x + x).requires_grad)
""",
    ),
    (
        "scope-restoration",
        """x = torch.tensor([2., 3.], dtype=torch.float32, requires_grad=True)
report = []
manager = torch.no_grad()
with manager as entered:
    report.append(entered is None)
    report.append((x + x).requires_grad)
    with torch.no_grad():
        report.append((x * x).requires_grad)
    report.append(x.sum().requires_grad)
    factory = torch.tensor([5., 7.], dtype=torch.float32, requires_grad=True)
    report.append(factory.requires_grad)
    report.append(torch.autograd.grad(factory, factory, torch.tensor([1., 1.], dtype=torch.float32))[0].tolist())
report.append((x + x).requires_grad)
try:
    with manager:
        raise ValueError('scope error')
except ValueError:
    report.append((x * x).requires_grad)
loss = (x * x).sum()
ordinary = x.view(1, 2)
with torch.no_grad():
    report.append(torch.autograd.grad(ordinary, x, torch.tensor([[2., 3.]], dtype=torch.float32))[0].tolist())
    report.append(torch.autograd.grad(loss, x)[0].tolist())
    try:
        torch.autograd.grad(loss, x)
    except RuntimeError:
        report.append('RuntimeError')
    else:
        raise AssertionError('Consumed history was reused under no-grad')
    report.append((x * x).tolist())
""",
    ),
    (
        "captured-overlap",
        """x = torch.tensor(2., dtype=torch.float32, requires_grad=True)
first, second = torch.no_grad(), torch.no_grad()
report = [(x + x).requires_grad]
first.__enter__()
report.append((x + x).requires_grad)
second.__enter__()
report.append((x + x).requires_grad)
first.__exit__(None, None, None)
report.append((x + x).requires_grad)
second.__exit__(None, None, None)
report.append((x + x).requires_grad)
first.__exit__(None, None, None)
report.append((x + x).requires_grad)
""",
    ),
    (
        "same-manager-reentry",
        """x = torch.tensor(2., dtype=torch.float32, requires_grad=True)
manager = torch.no_grad()
report = []
with manager:
    with manager:
        report.append((x * x).requires_grad)
report.append((x * x).requires_grad)
""",
    ),
)


def no_grad_cases(oracle: _OracleModule) -> list[dict[str, object]]:
    """Freeze observable context behavior from the pinned native runtime."""
    cases: list[dict[str, object]] = []
    for name, source in NO_GRAD_CASES:
        namespace: dict[str, object] = {"torch": oracle}
        # The reentered same object can leave native mode disabled. Give each
        # case an outer restoration scope, independent of its inner captures.
        exec(
            "outer = torch.no_grad()\nouter.__enter__()\nouter.__exit__(None, None, None)",
            namespace,
        )
        try:
            result: object = eval(
                compile(
                    source,
                    "<no-grad-oracle>",
                    "exec",
                    flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT,
                ),
                namespace,
            )
            if asyncio.iscoroutine(result):
                asyncio.run(result)
            cases.append(
                {"name": name, "source": source, "expected": namespace["report"]}
            )
        finally:
            exec("outer.__exit__(None, None, None)", namespace)
    return cases


COPY_CASES = (
    (
        "stale-child-bypasses-parent-new-child-binds-parent",
        """
def query(kind, write_view=False):
    leaf = torch.tensor([2., 3.], dtype=torch.float32, requires_grad=True)
    base = leaf * leaf
    parent = base.view(1, 2)
    child = parent.view(2)
    old = child.sum()
    source = torch.tensor([5., 7.], dtype=torch.float32, requires_grad=True)
    if write_view:
        parent.copy_(source.view(1, 2))
    else:
        base.copy_(source)
    if kind == 'old':
        result = torch.autograd.grad(old, leaf)
    elif kind == 'stale-connected':
        result = torch.autograd.grad(child.sum(), (base, leaf, source))
    else:
        output = child.sum() if kind == 'stale-parent' else parent.view(2).sum()
        try:
            result = torch.autograd.grad(output, (base, parent, leaf, source))
        except Exception as error:
            return [type(error).__name__, old.tolist(), child.tolist()]
    return [[t.tolist() for t in result], old.tolist(), child.tolist()]
report = [[query(kind, write_view) for kind in ('old', 'stale-connected', 'stale-parent', 'new-parent')] for write_view in (False, True)]
""",
    ),
    (
        "copy-float32-bits-and-independent-source",
        """
import struct, math
s = torch.tensor([0., -0., 2.**-149, 1. + 2.**-23, float('inf'), -float('inf'), float('nan')], dtype=torch.float32)
d = torch.tensor([1.] * 7, dtype=torch.float32)
def bits(t):
    return ['nan' if math.isnan(v) else struct.unpack('<I', struct.pack('<f', v))[0] for v in t.tolist()]
before = bits(s)
d.copy_(s)
s.copy_(torch.tensor([2.] * 7, dtype=torch.float32))
report = [before, bits(d), bits(s), list(d.shape), d.requires_grad]
""",
    ),
    (
        "source-only-prunes-consumed-old-multiplication",
        """
x = torch.tensor([2.], dtype=torch.float32, requires_grad=True)
s = torch.tensor([7.], dtype=torch.float32, requires_grad=True)
d = x * x
torch.autograd.grad(d, x)
d.copy_(s)
first = torch.autograd.grad(d, s)[0]
try:
    torch.autograd.grad(d, (x, s))
except Exception as error:
    consumed = type(error).__name__
second = torch.autograd.grad(d, s)[0]
report = [first.tolist(), consumed, second.tolist(), d.tolist()]
""",
    ),
    (
        "zero-edge-validates-old-saved-plain-position",
        """
x = torch.tensor([2.], dtype=torch.float32, requires_grad=True)
y = torch.tensor([3.], dtype=torch.float32)
s = torch.tensor([7.], dtype=torch.float32)
d = x * y
d.copy_(s)
y.copy_(s)
try:
    torch.autograd.grad(d, x)
except Exception as error:
    rejected = type(error).__name__
cutoff = torch.autograd.grad(d, d)[0]
report = [rejected, cutoff.tolist(), d.tolist()]
""",
    ),
    (
        "no-grad-leaf-alias-old-output",
        """
x = torch.tensor([2., 4.], dtype=torch.float32, requires_grad=True)
s = torch.tensor([7., 9.], dtype=torch.float32)
v = x.view(1, 2)
old = x + x
with torch.no_grad():
    returned = x.copy_(other=s, non_blocking=True)
g = torch.autograd.grad(old, x, torch.tensor([1., 1.], dtype=torch.float32))[0]
report = [returned is x, x.tolist(), v.tolist(), x.requires_grad, g.tolist()]
""",
    ),
    (
        "active-promotion-connected-zeros-reuse",
        """
x = torch.tensor([2., 4.], dtype=torch.float32, requires_grad=True)
s = torch.tensor([7., 9.], dtype=torch.float32, requires_grad=True)
d = x + x
returned = d.copy_(s)
g = torch.autograd.grad(d, (x, s), torch.tensor([1., 1.], dtype=torch.float32))
again = torch.autograd.grad(d, s, torch.tensor([1., 1.], dtype=torch.float32))[0]
p = torch.tensor([0., 0.], dtype=torch.float32)
p.copy_(s, False)
pg = torch.autograd.grad(p, s, torch.tensor([1., 1.], dtype=torch.float32))[0]
report = [returned is d, d.tolist(), d.requires_grad, [t.tolist() for t in g], again.tolist(), p.requires_grad, pg.tolist()]
""",
    ),
    (
        "view-copy-consumption-and-cutoff",
        """
x = torch.tensor([2., 4.], dtype=torch.float32, requires_grad=True)
s = torch.tensor([[7., 9.]], dtype=torch.float32, requires_grad=True)
b = x + x
v = b.view(1, 2)
old = v + v
v.copy_(s)
g = torch.autograd.grad(v, s, torch.tensor([[1., 1.]], dtype=torch.float32))[0]
try:
    torch.autograd.grad(v, s, torch.tensor([[1., 1.]], dtype=torch.float32))
except Exception as error:
    consumed = type(error).__name__
cutoff = torch.autograd.grad(v, b, torch.tensor([[1., 1.]], dtype=torch.float32))[0]
old_g = torch.autograd.grad(old, x, torch.tensor([[1., 1.]], dtype=torch.float32))[0]
report = [v.tolist(), b.tolist(), g.tolist(), consumed, cutoff.tolist(), old_g.tolist()]
""",
    ),
    (
        "node-saves-before-pruning-and-cutoff",
        """
x = torch.tensor([2.], dtype=torch.float32, requires_grad=True)
y = torch.tensor([3.], dtype=torch.float32, requires_grad=True)
p = x * y
with torch.no_grad():
    x.copy_(y)
try:
    torch.autograd.grad(p, x)
except Exception as error:
    rejected = type(error).__name__
cutoff = torch.autograd.grad(p, p)[0]
report = [rejected, cutoff.tolist(), x.tolist()]
""",
    ),
    (
        "special-dirty-resolution-and-fresh-epoch",
        """
p = torch.tensor([2., 4.], dtype=torch.float32)
s = torch.tensor([7., 9.], dtype=torch.float32, requires_grad=True)
with torch.no_grad():
    special = p.view(1, 2)
p.copy_(s)
report = [special.tolist(), special.requires_grad]
try:
    special + special
except Exception as error:
    report.append(type(error).__name__)
with torch.no_grad():
    fresh = special.view(1, 2)
active = fresh + fresh
report.extend([fresh.tolist(), fresh.requires_grad, active.requires_grad])
try:
    torch.autograd.grad(active, s, torch.tensor([[1., 1.]], dtype=torch.float32))
except Exception as error:
    report.append(type(error).__name__)
""",
    ),
    (
        "self-copy-connected-source-path",
        """
x = torch.tensor([2., 4.], dtype=torch.float32, requires_grad=True)
d = x + x
d.copy_(d)
g = torch.autograd.grad(d, x, torch.tensor([1., 1.], dtype=torch.float32))[0]
report = [d.tolist(), d.requires_grad, g.tolist()]
""",
    ),
    (
        "inherited-special-origin-on-plain-child",
        """
p = torch.tensor([2., 4.], dtype=torch.float32)
s = torch.tensor([7., 9.], dtype=torch.float32, requires_grad=True)
with torch.no_grad():
    special = p.view(1, 2)
child = special.view(1, 2)
report = []
try:
    child.copy_(s.view(1, 2))
except Exception as error:
    report.append(type(error).__name__)
report.extend([p.tolist(), child.requires_grad])
p.copy_(s)
try:
    child + child
except Exception as error:
    report.append(type(error).__name__)
report.extend([child.tolist(), child.requires_grad])
""",
    ),
    (
        "inherited-special-origin-with-bound-entry",
        """
p = torch.tensor([2., 4.], dtype=torch.float32, requires_grad=True)
s = torch.tensor([[7., 9.]], dtype=torch.float32)
with torch.no_grad():
    special = p.view(1, 2)
child = special.view(1, 2)
g = torch.autograd.grad(child, child, torch.tensor([[1., 1.]], dtype=torch.float32))[0]
report = [g.tolist(), child.requires_grad]
try:
    child.copy_(s)
except Exception as error:
    report.append(type(error).__name__)
with torch.no_grad():
    p.copy_(s.view(2))
try:
    child.sum()
except Exception as error:
    report.append(type(error).__name__)
report.append(child.tolist())
""",
    ),
)


COPY_RESET_CASES = tuple(
    (
        f"reset-view:length={length}:source={tracked}:no-grad={no_grad}:promoted={promoted}",
        f"""
from contextlib import nullcontext
p = torch.tensor([2.] * {length}, dtype=torch.float32, requires_grad=True)
x = torch.tensor([3.] * {length}, dtype=torch.float32, requires_grad=True)
base = x*x
destination = base.view({length})
p.grad = base
optimizer = torch.optim.SGD([p], lr=0.01)
optimizer.zero_grad(set_to_none=False)
if {promoted}:
    promotion = torch.tensor([4.] * {length}, dtype=torch.float32, requires_grad=True)
    base.copy_(promotion)
source = torch.tensor([5.] * {length}, dtype=torch.float32, requires_grad={tracked})
before = [base.requires_grad, destination.requires_grad, destination.tolist()]
try:
    with torch.no_grad() if {no_grad} else nullcontext():
        returned = destination.copy_(source)
    result = ['ok', returned is destination]
except Exception as error:
    result = [type(error).__name__]
report = [before, result, base.tolist(), destination.tolist(), base.requires_grad, destination.requires_grad]
""",
    )
    for length in (1, 8)
    for tracked in (False, True)
    for no_grad in (False, True)
    for promoted in (False, True)
)


def copy_cases(oracle: _OracleModule) -> list[dict[str, object]]:
    """Capture supported copy workflows and effective native argument binding."""
    cases: list[dict[str, object]] = []
    for name, source in (*COPY_CASES, *COPY_RESET_CASES):
        namespace: dict[str, object] = {"torch": oracle}
        exec(source, namespace)
        cases.append({"name": name, "source": source, "expected": namespace["report"]})
    for name, data in (
        ("scalar", "3."),
        ("empty", "[[], []]"),
        ("matrix", "[[1., -0.], [3., 4.]]"),
    ):
        for expression in (
            "d.copy_(s)",
            "d.copy_(other=s)",
            "d.copy_(s, False)",
            "d.copy_(s, non_blocking=True)",
        ):
            source = (
                f"s = torch.tensor({data}, dtype=torch.float32)\nd = torch.tensor({data}, dtype=torch.float32)\n"
                f"returned = {expression}\n"
                "report = [returned is d, list(d.shape), d.tolist(), d.requires_grad]\n"
            )
            namespace = {"torch": oracle}
            exec(source, namespace)
            cases.append(
                {
                    "name": f"{name}:{expression}",
                    "source": source,
                    "expected": namespace["report"],
                }
            )
    expressions = (
        "d.copy_()",
        "d.copy_(src=s)",
        "d.copy_(s, other=s)",
        "d.copy_(s, non_blocking=1)",
        "d.copy_(s, non_blocking=None)",
        "d.copy_(s, False, False)",
        "d.copy_(1)",
        "d.copy_(torch.tensor([1., 2.], dtype=torch.float32))",
        "d.view(1).copy_(s)",
    )
    for expression in expressions:
        source = (
            "d = torch.tensor([2.], dtype=torch.float32, requires_grad=True)\ns = torch.tensor([3.], dtype=torch.float32)\n"
            "try:\n"
            f"    {expression}\n"
            "except Exception as error:\n"
            "    report = [type(error).__name__, d.tolist(), d.requires_grad]\n"
        )
        namespace = {"torch": oracle}
        exec(source, namespace)
        if "report" not in namespace:
            raise AssertionError(f"Expected copy rejection: {expression}")
        cases.append(
            {"name": expression, "source": source, "expected": namespace["report"]}
        )
    return cases


NO_GRAD_VIEW_QUERIES = (
    ("special-self", "special", "special"),
    ("special-base", "special", "base"),
    ("active-self", "active", "active"),
    ("product-self", "product", "product"),
    ("product-special", "product", "special"),
    ("special-sum-self", "special_sum", "special_sum"),
    ("special-sum-base", "special_sum", "base"),
    ("active-special", "active", "special"),
    ("active-base", "active", "base"),
    ("mixed-base", "mixed", "base"),
    ("mixed-special", "mixed", "special"),
    ("child-base", "child", "base"),
    ("child-root", "child", "root"),
    ("mixed-root", "mixed", "root"),
    ("child-special", "child", "special"),
    ("child-self", "child", "child"),
    ("disabled-child-self", "disabled_child", "disabled_child"),
    ("summed-active", "summed", "active"),
)


def no_grad_view_cases(oracle: _OracleModule) -> list[dict[str, object]]:
    """Capture immutable special-view provenance and disconnected tracked nodes."""
    cases: list[dict[str, object]] = []
    for geometry, data, shape in (
        ("scalar", [2.0], []),
        ("empty", [], [2, 0, 3]),
        ("matrix", [2.0, 3.0, 4.0, 5.0], [2, 2]),
    ):
        for kind in ("plain", "leaf", "nonleaf", "ordinary-view"):
            source = (
                f"root = torch.tensor({data}, dtype=torch.float32, requires_grad={kind != 'plain'})\n"
                "base = root\n"
            )
            if kind == "nonleaf":
                source += "base = base + base\n"
            elif kind == "ordinary-view":
                source += f"base = root.view({shape})\n"
            source += (
                "with torch.no_grad():\n"
                f"    special = base.view({shape})\n"
                f"    disabled_child = special.view({shape})\n"
                "active = special + special\n"
                "product = special * special\n"
                "special_sum = special.sum()\n"
                f"mixed = special + base.view({shape})\n"
                f"child = special.view({shape})\n"
                "summed = active.sum()\n"
                "tensors = [base, special, disabled_child, active, mixed, child, summed, product, special_sum]\n"
                "report = {'metadata': [[list(t.shape), t.tolist(), t.requires_grad] for t in tensors], 'queries': []}\n"
            )
            for name, output, requested in NO_GRAD_VIEW_QUERIES:
                seed = (
                    "torch.tensor(1., dtype=torch.float32)"
                    if output in ("summed", "special_sum")
                    else (
                        f"torch.tensor({[1.0] * len(data)}, dtype=torch.float32).view({shape})"
                    )
                )
                source += (
                    "try:\n"
                    f"    gradient = torch.autograd.grad({output}, {requested}, {seed})[0]\n"
                    "except RuntimeError:\n"
                    f"    report['queries'].append(['{name}', 'RuntimeError'])\n"
                    "else:\n"
                    f"    report['queries'].append(['{name}', list(gradient.shape), gradient.tolist(), gradient.requires_grad])\n"
                )
            namespace: dict[str, object] = {"torch": oracle}
            exec(source, namespace)
            cases.append(
                {
                    "name": f"{geometry}-{kind}",
                    "data": data,
                    "shape": shape,
                    "kind": kind,
                    "queries": NO_GRAD_VIEW_QUERIES,
                    "source": source,
                    "expected": namespace["report"],
                }
            )
    return cases


class _VersionModule(Protocol):
    git_version: str


class _OracleModule(Protocol):
    __version__: str
    version: _VersionModule

    def set_num_threads(self, value: int) -> None: ...
    def set_num_interop_threads(self, value: int) -> None: ...


def float32_bits(value: float) -> int | str:
    """Keep signed zero and rounding exact without requiring a NaN payload."""
    if math.isnan(value):
        return "nan"
    return int(struct.unpack("<I", struct.pack("<f", value))[0])


def tensor_bits(expression: str, namespace: dict[str, object]) -> list[int | str]:
    """Encode oracle tensor values while preserving signed zeros and rounding."""
    raw: object = eval(f"{expression}.reshape(-1).tolist()", namespace)
    if not isinstance(raw, list):
        raise TypeError("Expected flat oracle tensor values.")
    result: list[int | str] = []
    for value in cast(list[object], raw):
        if not isinstance(value, float):
            raise TypeError("Expected float32 oracle values.")
        result.append(float32_bits(value))
    return result


def mul_cases(oracle: _OracleModule) -> list[dict[str, object]]:
    """Record products and the supported syntax using native tensor arithmetic."""
    cases: list[dict[str, object]] = []
    for name, left, right in MUL_INPUTS:
        source = (
            f"left = torch.tensor({left}, dtype=torch.float32)\n"
            f"right = torch.tensor({right}, dtype=torch.float32)\n"
        )
        namespace: dict[str, object] = {"torch": oracle}
        exec(source, namespace)
        expected: list[int | str] = []
        for expression in MUL_OPERATIONS:
            exec(f"result = {expression}", namespace)
            bits = tensor_bits("result", namespace)
            if expression == MUL_OPERATIONS[0]:
                expected = bits
            elif bits != expected:
                raise AssertionError(f"Multiplication syntax disagrees: {expression}")
        cases.append(
            {
                "name": name,
                "source": source,
                "leftBits": tensor_bits("left", namespace),
                "rightBits": tensor_bits("right", namespace),
                "bits": expected,
                "metadata": eval(METADATA, namespace),
            }
        )
        if name == "separate-multiply-add":
            exec("addend = torch.tensor([-1.] * 5, dtype=torch.float32)", namespace)
            exec("combined = result + addend", namespace)
            cases[-1]["addendBits"] = tensor_bits("addend", namespace)
            cases[-1]["multiplyAddBits"] = tensor_bits("combined", namespace)
    return cases


def sum_cases(oracle: _OracleModule) -> list[dict[str, object]]:
    """Record native results and conditioning facts, not a second reduction engine."""
    cases: list[dict[str, object]] = []
    sources = [
        (name, f"torch.tensor({data}, dtype=torch.float32)", comparison)
        for name, data, comparison in SUM_INPUTS
    ]
    sources.extend(
        (
            (
                "view-matrix",
                "torch.tensor([1, -2, 3, 4, -5, 6], dtype=torch.float32).view(2, 3)",
                "exact",
            ),
            (
                "view-empty",
                "torch.tensor([], dtype=torch.float32).view(2, 0, 3)",
                "exact",
            ),
        )
    )
    for name, expression, comparison in sources:
        source = f"source = {expression}\n"
        namespace: dict[str, object] = {"torch": oracle}
        exec(source + "result = source.sum()", namespace)
        raw: object = eval("source.reshape(-1).tolist()", namespace)
        if not isinstance(raw, list):
            raise TypeError("Expected float32 input values.")
        values: list[float] = []
        for item in cast(list[object], raw):
            if not isinstance(item, float):
                raise TypeError("Expected float32 input values.")
            values.append(item)
        result = eval("result.tolist()", namespace)
        if not isinstance(result, float):
            raise TypeError("Expected scalar float32 sum.")
        case: dict[str, object] = {
            "name": name,
            "source": source,
            "comparison": comparison,
            "inputBits": [float32_bits(value) for value in values],
            "shape": eval("list(source.shape)", namespace),
            "metadata": eval(METADATA, namespace),
            "bits": float32_bits(result),
        }
        if comparison == "bounded":
            case["referenceSum"] = math.fsum(values)
            case["absoluteSum"] = math.fsum(abs(value) for value in values)
        cases.append(case)
    return cases


def generate() -> str:
    # Optional development dependency: the pinned module is imported only when
    # generating fixtures, never by CI consumers or the browser. This protocol
    # describes the setup calls; executable case text intentionally exercises
    # the real module dynamically instead of using Tabgrad declarations.
    oracle = cast(_OracleModule, importlib.import_module("torch"))
    if oracle.__version__ != VERSION or oracle.version.git_version != REVISION:
        raise RuntimeError("The installed oracle does not match the pinned build.")
    oracle.set_num_threads(1)
    oracle.set_num_interop_threads(1)
    cases: list[dict[str, object]] = []
    rank_cases: list[dict[str, object]] = []
    view_cases: list[dict[str, object]] = []
    for name, data, dimensions in VIEW_INPUTS:
        source = (
            f"base = torch.tensor({data}, dtype=torch.float32)\n"
            f"result = base.view({dimensions})\n"
        )
        namespace: dict[str, object] = {"torch": oracle}
        exec(source, namespace)
        view_cases.append(
            {
                "name": name,
                "source": source,
                "metadata": eval(METADATA, namespace),
                "values": eval("result.tolist()", namespace),
            }
        )
    for name, left, right in (*INPUTS, *RANK_INPUTS):
        for operation in OPERATIONS:
            source = (
                f"left = torch.tensor({left}, dtype=torch.float32, device='cpu')\n"
                f"right = torch.tensor({right}, dtype=torch.float32, device='cpu')\n"
                f"result = {operation}\n"
            )
            namespace: dict[str, object] = {"torch": oracle}
            exec(source, namespace)
            values: object = eval("result.reshape(-1).tolist()", namespace)
            if not isinstance(values, list):
                raise TypeError("Expected flat float32 oracle values.")
            items = cast(list[object], values)
            bits: list[int | str] = []
            for value in items:
                if not isinstance(value, float):
                    raise TypeError("Expected floating-point oracle values.")
                bits.append(float32_bits(value))
            case: dict[str, object] = {
                "name": f"{name}: {operation}",
                "source": source,
                "metadata": eval(METADATA, namespace),
                "bits": bits,
            }
            if (name, left, right) in RANK_INPUTS:
                case["values"] = eval("result.tolist()", namespace)
                rank_cases.append(case)
            else:
                cases.append(case)
    errors: list[dict[str, str]] = []
    namespace = {"torch": oracle}
    exec(
        "left = torch.tensor([1, 2, 3, 4], dtype=torch.float32)\nright = left",
        namespace,
    )
    for expression in ERRORS:
        try:
            eval(expression, namespace)
        except Exception as error:
            errors.append({"expression": expression, "type": type(error).__name__})
        else:
            raise AssertionError(f"Expected oracle rejection: {expression}")
    return (
        json.dumps(
            {
                "torchVersion": VERSION,
                "torchBuildRevision": REVISION,
                "torchSourceRevision": "2b3ec34829036a65cd9d1398ea72a0167dc37470",
                "pyodideVersion": "314.0.6",
                "pyodideSourceRevision": "8cec1b9bb8ead68c7c09b0a6443576bec7512268",
                "metadataExpression": METADATA,
                "comparison": "Exact float32 bits except NaN payload; exact metadata and error classes.",
                "mulOperations": MUL_OPERATIONS,
                "mulCases": mul_cases(oracle),
                "sumComparison": "Exact simple cases; conditioning-aware absolute bounds for finite reassociation; explicit backend-dependent intermediate-overflow classifications. See docs/reference/tensor-sum.md.",
                "sumCases": sum_cases(oracle),
                "gradientCases": gradient_cases(oracle),
                "gradientErrors": gradient_errors(oracle),
                "gradientProgressCases": gradient_progress_cases(oracle),
                "backwardCases": backward_cases(oracle),
                "sgdCases": sgd_cases(oracle),
                "copyCases": copy_cases(oracle),
                "noGradCases": no_grad_cases(oracle),
                "noGradViewCases": no_grad_view_cases(oracle),
                "cases": cases,
                "rankCases": rank_cases,
                "viewCases": view_cases,
                "errors": errors,
                "metadataCases": [
                    {"expression": expression, "value": eval(expression, namespace)}
                    for expression in METADATA_CASES
                ],
            },
            indent=2,
            allow_nan=False,
        )
        + "\n"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    generated = generate()
    if args.check:
        if OUTPUT.read_text(encoding="utf-8") != generated:
            raise SystemExit("Tensor oracle fixtures are stale.")
    else:
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT.write_text(generated, encoding="utf-8")


if __name__ == "__main__":
    main()
