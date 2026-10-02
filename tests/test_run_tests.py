"""Contracts for native test discovery and invocation isolation."""

import io
import sys
import tempfile
import unittest
from pathlib import Path

from scripts import run_tests as RUNNER


class TestRunnerTests(unittest.TestCase):
    def test_test_runner_rejects_zero_discovered_tests(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = io.StringIO()
            result = RUNNER.run_tests(Path(directory), stream=output)
            self.assertEqual(result, 2)
            self.assertIn("zero tests", output.getvalue())

    def test_test_runner_does_not_reuse_discovery_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            populated = root / "populated"
            populated.mkdir()
            (populated / "test_example.py").write_text(
                "import unittest\n\n"
                "class ExampleTest(unittest.TestCase):\n"
                "    def test_example(self):\n"
                "        self.assertTrue(True)\n",
                encoding="utf-8",
            )
            self.assertEqual(RUNNER.run_tests(populated, stream=io.StringIO()), 0)

            empty = root / "empty"
            empty.mkdir()
            output = io.StringIO()
            self.assertEqual(RUNNER.run_tests(empty, stream=output), 2)
            self.assertIn("zero tests", output.getvalue())

    def test_test_runner_isolates_modules_between_invocations(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("first", "second"):
                suite = root / name
                suite.mkdir()
                (suite / "test_tabgrad_runner_same_name.py").write_text(
                    "import unittest\n\n"
                    "class ExampleTest(unittest.TestCase):\n"
                    "    def test_example(self):\n"
                    "        self.assertTrue(True)\n",
                    encoding="utf-8",
                )
                self.assertEqual(RUNNER.run_tests(suite, stream=io.StringIO()), 0)
            self.assertNotIn("test_tabgrad_runner_same_name", sys.modules)


if __name__ == "__main__":
    unittest.main()
