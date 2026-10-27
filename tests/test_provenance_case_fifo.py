"""Finite descriptor controls: this module never creates a FIFO or probes Linux."""

from __future__ import annotations

import io
import json
import os
import stat
import sys
import unittest
from collections.abc import Mapping
from unittest.mock import patch

from scripts import provenance_case_fifo as helper


def payload() -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "root": {"path": "/private-case/ipc", "identity": {"dev": "7", "ino": "1"}},
        "gid": "12345",
    }


class FifoModel:
    def __init__(self, fail: tuple[str, int] | None = None) -> None:
        self.fail = fail
        self.calls: list[tuple[str, str]] = []
        self.nodes: dict[int, dict[str, int]] = {
            10: {
                "dev": 7,
                "ino": 1,
                "mode": stat.S_IFDIR | 0o750,
                "uid": 0,
                "gid": 12345,
            }
        }
        self.next_fd = 100
        self.closed: list[int] = []

    def _record(self, name: str, detail: str) -> None:
        self.calls.append((name, detail))
        if self.fail == (name, sum(1 for call in self.calls if call[0] == name)):
            raise OSError("finite private diagnostic")

    def open_root(self, path: str) -> int:
        self._record("open_root", path)
        return 10

    def mkfifo(self, name: str, root: int) -> None:
        self._record("mkfifo", name)
        if root != 10:
            raise AssertionError("wrong retained root")

    def open_fifo(self, name: str, root: int) -> int:
        self._record("open_fifo", name)
        if root != 10:
            raise AssertionError("wrong retained root")
        fd = self.next_fd
        self.next_fd += 1
        self.nodes[fd] = {
            "dev": 7,
            "ino": fd,
            "mode": stat.S_IFIFO | 0o640,
            "uid": 0,
            "gid": 0,
        }
        return fd

    def metadata(self, descriptor: int) -> Mapping[str, int]:
        self._record("metadata", str(descriptor))
        return dict(self.nodes[descriptor])

    def permissions(self, descriptor: int, gid: int) -> None:
        self._record("permissions", str(descriptor))
        self.nodes[descriptor].update(
            {"mode": stat.S_IFIFO | 0o660, "uid": 0, "gid": gid}
        )

    def close(self, descriptor: int) -> None:
        self._record("close", str(descriptor))
        self.closed.append(descriptor)


class CaseFifoTests(unittest.TestCase):
    def test_three_fixed_names_use_retained_root_and_close_each_descriptor_once(
        self,
    ) -> None:
        calls = FifoModel()
        result = helper.prepare_fifos(payload(), calls)
        self.assertTrue(result["complete"])
        self.assertIsNone(result["error"])
        self.assertEqual(result["closeUnknown"], [])
        self.assertEqual(
            [detail for name, detail in calls.calls if name == "mkfifo"],
            ["stdout", "stderr", "control"],
        )
        self.assertEqual(calls.closed, [100, 101, 102, 10])
        self.assertTrue(all(value["gid"] == 12345 for value in calls.nodes.values()))

    def test_partial_effects_and_close_failure_are_retained_without_retry(self) -> None:
        for failure in [
            ("open_root", 1),
            ("mkfifo", 1),
            ("open_fifo", 1),
            ("metadata", 2),
            ("permissions", 1),
            ("close", 1),
        ]:
            with self.subTest(failure=failure):
                calls = FifoModel(failure)
                result = helper.prepare_fifos(payload(), calls)
                self.assertFalse(result["complete"])
                self.assertIn(result["error"], {"LAB_WRITE", "LAB_CLEANUP"})
                self.assertLessEqual(
                    sum(name == "mkfifo" for name, _ in calls.calls), 1
                )
                self.assertEqual(len(calls.closed), len(set(calls.closed)))
                if failure == ("close", 1):
                    self.assertEqual(result["closeUnknown"], [100])
                    self.assertEqual(
                        sum(
                            name == "close" and detail == "100"
                            for name, detail in calls.calls
                        ),
                        1,
                    )

    def test_invalid_inputs_and_wrong_root_cannot_begin_creation(self) -> None:
        for value in [
            None,
            {},
            {**payload(), "schemaVersion": True},
            {**payload(), "gid": "0"},
            {**payload(), "gid": "012345"},
            {**payload(), "extra": 1},
            {
                **payload(),
                "root": {
                    "path": "/private-case/../ipc",
                    "identity": {"dev": "7", "ino": "1"},
                },
            },
        ]:
            calls = FifoModel()
            self.assertEqual(helper.prepare_fifos(value, calls)["error"], "LAB_INPUT")
            self.assertEqual(calls.calls, [])
        calls = FifoModel()
        calls.nodes[10]["gid"] = 1
        self.assertEqual(
            helper.prepare_fifos(payload(), calls)["error"], "LAB_IDENTITY"
        )
        self.assertFalse(any(name == "mkfifo" for name, _ in calls.calls))
        self.assertEqual(calls.closed, [10])

    def test_cli_bounds_bytes_and_rejects_duplicate_keys_before_syscalls(self) -> None:
        for data in [b"x" * 32769, b"\xff", b'{"schemaVersion":1,"schemaVersion":1}']:
            calls = FifoModel()
            output = io.StringIO()
            with (
                patch.object(helper.sys, "platform", "linux"),
                patch.object(helper, "NativeFifoCalls", return_value=calls),
            ):
                status = helper.main(
                    ["32768", os.path.realpath(sys.prefix)], io.BytesIO(data), output
                )
            self.assertEqual(status, 1)
            self.assertEqual(json.loads(output.getvalue())["error"], "LAB_INPUT")
            self.assertEqual(calls.calls, [])

    def test_cli_refuses_global_or_wrong_interpreter_before_native_creation(
        self,
    ) -> None:
        for name, value in [("base_prefix", sys.prefix), ("version_info", (3, 12, 0))]:
            calls = FifoModel()
            with (
                patch.object(helper.sys, "platform", "linux"),
                patch.object(helper.sys, name, value),
                patch.object(helper, "NativeFifoCalls", return_value=calls),
            ):
                status = helper.main(
                    ["32768", os.path.realpath(sys.prefix)],
                    io.BytesIO(json.dumps(payload()).encode()),
                    io.StringIO(),
                )
            self.assertEqual(status, 1)
            self.assertEqual(calls.calls, [])


if __name__ == "__main__":
    unittest.main()
