"""Generate bounded Python tensor expectations using the installed native oracle."""

import argparse
import importlib
import json
import math
import struct
from pathlib import Path
from typing import Protocol, cast

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
                "sumComparison": "Exact simple cases; conditioning-aware absolute bounds for finite reassociation; explicit backend-dependent intermediate-overflow classifications. See docs/reference/tensor-sum.md.",
                "sumCases": sum_cases(oracle),
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
