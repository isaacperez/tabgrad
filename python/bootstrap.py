"""Install and retire the Python package without owning the interpreter."""

import importlib
import importlib.util
import os
import sys
import tempfile
from pathlib import Path
from types import ModuleType

from _pyodide._importhook import jsfinder
from pyodide.ffi import register_js_module, unregister_js_module

BRIDGE_NAME = "_tabgrad_runtime_bridge"


class _OwnedImportPath(str):
    """Give a sys.path entry identity distinct from equal host strings."""


def _reject_conflicts() -> None:
    for name in ("torch", BRIDGE_NAME):
        if (
            name in sys.modules
            or name in jsfinder.jsproxies
            or importlib.util.find_spec(name) is not None
        ):
            raise ImportError(f"Tabgrad cannot replace the existing module {name!r}")


def _same_file(path: Path, inode: int) -> bool:
    try:
        return path.lstat().st_ino == inode
    except FileNotFoundError:
        return False


class Installation:
    """Own exact import and filesystem entries for one attached package."""

    def __init__(self) -> None:
        self.import_path: _OwnedImportPath | None = None
        self.directories: list[tuple[Path, int]] = []
        self.files: list[tuple[Path, int, bytes | None]] = []
        self.modules: dict[str, ModuleType] = {}
        self.registration: object | None = None
        # Only identity is used; host finders need not inherit an importlib ABC.
        self.importer: object | None = None

    def _write_source(self, path: Path, content: bytes) -> None:
        # Claim the newly created identity before a write can partially fail.
        path.touch(exist_ok=False)
        inode = path.stat().st_ino
        self.files.append((path, inode, None))
        try:
            path.write_bytes(content)
        finally:
            self.files[-1] = (path, inode, path.read_bytes())

    def install(self, source: str, bridge: object) -> None:
        """Reject conflicts before mutation and roll back partial installation."""
        _reject_conflicts()
        try:
            root = Path(tempfile.mkdtemp(prefix="tabgrad-"))
            self.directories.append((root, root.stat().st_ino))
            package = root / "torch"
            package.mkdir()
            self.directories.append((package, package.stat().st_ino))
            path = package / "__init__.py"
            content = source.encode("utf-8")
            self._write_source(path, content)
            self.import_path = _OwnedImportPath(str(root))
            sys.path.insert(0, self.import_path)
            register_js_module(BRIDGE_NAME, bridge)
            self.registration = jsfinder.jsproxies[BRIDGE_NAME]
            self.modules[BRIDGE_NAME] = importlib.import_module(BRIDGE_NAME)
            previous_bytecode = sys.dont_write_bytecode
            try:
                # Source is already verified. Do not leave an untracked cache in
                # the borrowed interpreter's filesystem during initial import.
                sys.dont_write_bytecode = True
                self.modules["torch"] = importlib.import_module("torch")
            finally:
                sys.dont_write_bytecode = previous_bytecode
                self.importer = sys.path_importer_cache.get(self.import_path)
        except BaseException as primary:
            try:
                self.close()
            except BaseException as cleanup:
                raise BaseExceptionGroup(
                    "Python installation and rollback failed", [primary, cleanup]
                ) from None
            raise

    def close(self) -> None:
        """Remove owned identities; host replacements and additions survive."""
        errors: list[OSError] = []
        for name, module in self.modules.items():
            if sys.modules.get(name) is module:
                del sys.modules[name]
        self.modules.clear()
        if self.registration is not None:
            if jsfinder.jsproxies.get(BRIDGE_NAME) is self.registration:
                unregister_js_module(BRIDGE_NAME)
            self.registration = None
        if self.import_path is not None:
            sys.path[:] = [entry for entry in sys.path if entry is not self.import_path]
            if sys.path_importer_cache.get(self.import_path) is self.importer:
                sys.path_importer_cache.pop(self.import_path, None)
            self.import_path = None
        for path, inode, content in self.files:
            try:
                if _same_file(path, inode) and (
                    content is None or path.read_bytes() == content
                ):
                    path.unlink()
            except OSError as error:
                errors.append(error)
        self.files.clear()
        for path, inode in reversed(self.directories):
            try:
                if _same_file(path, inode) and not os.listdir(path):
                    path.rmdir()
            except OSError as error:
                errors.append(error)
        self.directories.clear()
        if errors:
            raise ExceptionGroup("Python installation cleanup failed", errors)
