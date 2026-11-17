"""Record binary16 construction and separate stored pointwise operations."""

from __future__ import annotations

import json
import math
from pathlib import Path

import torch


def words(value: torch.Tensor) -> list[int]:
    encoded = value.view(torch.int16)
    return [int(encoded[index]) & 0xFFFF for index in range(encoded.numel())]


def encoded_number(value: float) -> float | str:
    if math.isnan(value):
        return "nan"
    if math.isinf(value):
        return "inf" if value > 0 else "-inf"
    if value == 0 and math.copysign(1.0, value) < 0:
        return "-0"
    return value


def from_words(values: list[int]) -> torch.Tensor:
    signed = [value if value < 0x8000 else value - 0x10000 for value in values]
    return torch.tensor(signed, dtype=torch.int16).view(torch.float16)


def main() -> None:
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    if str(torch.__version__) != "2.14.0":
        raise RuntimeError("This corpus requires the pinned PyTorch 2.14.0 oracle.")
    values = [0.0, -0.0, math.inf, -math.inf, math.nan]
    for exponent in range(-25, 16):
        unit = 2.0**exponent
        for factor in (1.0, 1.5, 1.0 + 2**-11, 1.0 + 3 * 2**-11):
            for direction in (-1.0, 0.0, 1.0):
                value = factor * unit + direction * unit * 2**-30
                values.extend((value, -value))
    values.extend((65520.0 - 2**-10, 65520.0, 65520.0 + 2**-10))
    boundary = [
        0,
        0x8000,
        1,
        2,
        3,
        0x3FF,
        0x400,
        0x401,
        0x3BFF,
        0x3C00,
        0x3C01,
        0x3C02,
        0x4000,
        0x63FF,
        0x6400,
        0x7BFE,
        0x7BFF,
        0x7C00,
        0x7E00,
        0x8001,
        0x83FF,
        0x8400,
        0xBBFF,
        0xBC00,
        0xBC01,
        0xFBFF,
        0xFC00,
        0xFE00,
    ]
    left_words = [left for left in boundary for _ in boundary]
    right_words = boundary * len(boundary)
    for index in range(8192):
        left_words.append((index * 53 + 1) & 0xFFFF)
        right_words.append((index * 40503 + 97) & 0xFFFF)
    left, right = from_words(left_words), from_words(right_words)
    # Separate tensors preserve the two storage-rounding boundaries.
    product = left * right
    result = {
        "schema": 1,
        "reference": {
            "torch": str(torch.__version__),
            "git": torch.version.git_version,
            "device": "cpu",
            "threads": torch.get_num_threads(),
        },
        "construction": {
            "inputs": [encoded_number(v) for v in values],
            "words": words(torch.tensor(values, dtype=torch.float16)),
        },
        "pointwise": {
            "left": left_words,
            "right": right_words,
            "add": words(left + right),
            "mul": words(product),
            "mulThenAdd": words(product + left),
        },
    }
    target = (
        Path(__file__).resolve().parents[1] / "js-tests/fixtures/float16-oracle.json"
    )
    target.write_text(json.dumps(result, allow_nan=False, separators=(",", ":")) + "\n")
    errors: list[dict[str, str | list[int]]] = []
    for name, value in [
        ("int64-max", 2**63 - 1),
        ("uint64-min", 2**63),
        ("uint64-max", 2**64 - 1),
        ("outside-u64", 2**64),
        ("outside-i64", -(2**63) - 1),
        ("huge", 2**1024),
    ]:
        try:
            tensor = torch.tensor([value], dtype=torch.float16)
            errors.append({"name": name, "words": words(tensor)})
        except (TypeError, ValueError, RuntimeError, OverflowError) as error:
            errors.append(
                {"name": name, "error": type(error).__name__, "message": str(error)}
            )
    print(
        json.dumps(
            {
                "type": "result",
                "value": {
                    "status": "ok",
                    "torch": str(torch.__version__),
                    "constructionCases": len(values),
                    "pointwiseCases": len(left_words),
                    "integers": errors,
                },
            }
        )
    )


if __name__ == "__main__":
    main()
