"""Finite TOML-reader controls without a container runtime or native host reads."""

import json
import subprocess
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/provenance-containerd-config.py"


class ContainerdConfigTests(unittest.TestCase):
    def run_reader(
        self, raw: bytes, limit: int = 4096
    ) -> subprocess.CompletedProcess[bytes]:
        """Use the prepared test interpreter, without setup or global fallback."""
        return subprocess.run(
            [sys.executable, "-I", str(SCRIPT), str(limit), sys.prefix],
            input=raw,
            capture_output=True,
            timeout=5,
            check=False,
        )

    def test_real_toml_escapes_tables_and_absence_are_preserved(self) -> None:
        raw = b'version = 2\nroot = "/owned/\\u0072oot"\n[grpc]\naddress = "/socket"\n'
        result = self.run_reader(raw)
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value["root"], "/owned/root")
        self.assertEqual(value["grpc"], {"address": "/socket"})
        self.assertIsNone(value["imports"])
        self.assertEqual(result.stderr, b"")

    def test_independent_format_encoding_duplicates_and_capacity_fail_closed(
        self,
    ) -> None:
        for raw, limit in (
            (b"root = [", 4096),
            (b"root = 1\nroot = 2", 4096),
            (b"root = '\xff'", 4096),
            (b"version = 2", 3),
            (b"", 0),
        ):
            with self.subTest(raw=raw, limit=limit):
                result = self.run_reader(raw, limit)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, b"")
                self.assertEqual(result.stderr, b"LAB_PROTOCOL\n")


if __name__ == "__main__":
    unittest.main()
