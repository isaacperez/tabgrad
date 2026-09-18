"""Check the local extraction boundary without loading a browser interpreter."""

import tempfile
import unittest
from pathlib import Path
from zipfile import BadZipFile, ZipFile

from scripts.prepare_pyodide_types import prepare_pyodide_types


class PyodideTypeSourceTests(unittest.TestCase):
    def test_copies_only_upstream_modules_and_preserves_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dependency = Path(directory)
            with ZipFile(dependency / "python_stdlib.zip", "w") as archive:
                archive.writestr("pyodide/ffi/__init__.py", b"# upstream\r\n")
                archive.writestr("_pyodide/py.typed", b"")
                archive.writestr("os.py", b"# unrelated standard library")
            prepare_pyodide_types(dependency)
            output = dependency / "python-types"
            self.assertEqual(
                (output / "pyodide/ffi/__init__.py").read_bytes(), b"# upstream\r\n"
            )
            self.assertTrue((output / "_pyodide/py.typed").is_file())
            self.assertFalse((output / "os.py").exists())
            prepare_pyodide_types(dependency)
            self.assertEqual(
                (output / "pyodide/ffi/__init__.py").read_bytes(), b"# upstream\r\n"
            )

    def test_rejects_paths_outside_the_declared_root(self) -> None:
        for name in ("pyodide/../../escape.py", "pyodide/..\\escape.py"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                dependency = Path(directory)
                with ZipFile(dependency / "python_stdlib.zip", "w") as archive:
                    archive.writestr(name, b"untrusted")
                with self.assertRaisesRegex(ValueError, "Invalid Pyodide"):
                    prepare_pyodide_types(dependency)
                self.assertFalse((dependency / "escape.py").exists())
                self.assertFalse((dependency / "python-types").exists())

    def test_missing_or_invalid_archive_fails_without_creating_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dependency = Path(directory)
            with self.assertRaises(FileNotFoundError):
                prepare_pyodide_types(dependency)
            (dependency / "python_stdlib.zip").write_bytes(b"not a ZIP archive")
            with self.assertRaises(BadZipFile):
                prepare_pyodide_types(dependency)
            self.assertFalse((dependency / "python-types").exists())
