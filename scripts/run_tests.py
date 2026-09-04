#!/usr/bin/env python3
"""Run the repository unit tests and reject an empty test suite."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import TextIO


def run_tests(start_directory: Path, stream: TextIO | None = None) -> int:
    if not start_directory.is_dir():
        print(
            f"Test directory does not exist: {start_directory}",
            file=stream or sys.stderr,
        )
        return 2

    original_modules = set(sys.modules)
    original_path = list(sys.path)
    test_root = start_directory.resolve()
    try:
        try:
            suite = unittest.TestLoader().discover(
                str(start_directory), pattern="test_*.py"
            )
        except ImportError as error:
            print(f"Test discovery failed: {error}", file=stream or sys.stderr)
            return 2
        count = suite.countTestCases()
        if count == 0:
            print(
                "Test discovery found zero tests; this is not a passing result.",
                file=stream or sys.stderr,
            )
            return 2

        result = unittest.TextTestRunner(stream=stream, verbosity=2).run(suite)
        return 0 if result.wasSuccessful() else 1
    finally:
        sys.path[:] = original_path
        for name in set(sys.modules).difference(original_modules):
            module_file = getattr(sys.modules[name], "__file__", None)
            if module_file is None:
                continue
            try:
                belongs_to_suite = Path(module_file).resolve().is_relative_to(test_root)
            except (OSError, ValueError):
                belongs_to_suite = False
            if belongs_to_suite:
                del sys.modules[name]


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    return run_tests(root / "tests")


if __name__ == "__main__":
    sys.exit(main())
