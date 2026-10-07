"""Install and retire the Python package without owning the interpreter."""

import importlib
import importlib.util
import os
import sys
import tempfile
from importlib.machinery import (
    SOURCE_SUFFIXES,
    FileFinder,
    ModuleSpec,
    SourceFileLoader,
)
from pathlib import Path
from types import ModuleType

from _pyodide._importhook import jsfinder
from pyodide.ffi import register_js_module, unregister_js_module

BRIDGE_NAME = "_tabgrad_runtime_bridge"


class _OwnedImportPath(str):
    """Give a sys.path entry identity distinct from equal host strings."""


class _OwnedSourceLoader(SourceFileLoader):
    """Record module acquisition before its source can import children or fail."""

    def __init__(
        self, fullname: str, path: str, *, modules: dict[str, ModuleType]
    ) -> None:
        super().__init__(fullname, path)
        self.modules: dict[str, ModuleType] | None = modules

    def exec_module(self, module: ModuleType) -> None:
        if self.modules is not None:
            self.modules[self.name] = module
            self.modules = None
        super().exec_module(module)


class _OwnedSourceFinder(FileFinder):
    """Capture source-module identities only during synchronous installation."""

    def __init__(self, path: Path, modules: dict[str, ModuleType]) -> None:
        super().__init__(str(path), (SourceFileLoader, SOURCE_SUFFIXES))
        self.modules: dict[str, ModuleType] | None = modules

    def find_spec(
        self, fullname: str, target: ModuleType | None = None
    ) -> ModuleSpec | None:
        spec = super().find_spec(fullname, target)
        if (
            self.modules is not None
            and target is None
            and spec is not None
            and isinstance(spec.loader, SourceFileLoader)
        ):
            spec.loader = _OwnedSourceLoader(
                fullname, spec.loader.path, modules=self.modules
            )
        return spec


def _reject_conflicts() -> None:
    for child in ("torch.autograd", "torch.optim"):
        if child in sys.modules or child in jsfinder.jsproxies:
            raise ImportError(f"Tabgrad cannot replace the existing module {child!r}")
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
        self.package_importer: tuple[str, object] | None = None

    def _write_source(self, path: Path, content: bytes) -> None:
        # Claim the newly created identity before a write can partially fail.
        path.touch(exist_ok=False)
        inode = path.stat().st_ino
        self.files.append((path, inode, None))
        try:
            path.write_bytes(content)
        finally:
            self.files[-1] = (path, inode, path.read_bytes())

    def _install_importer(self, path: Path) -> _OwnedSourceFinder:
        importer = _OwnedSourceFinder(path, self.modules)
        sys.path_importer_cache[str(path)] = importer
        return importer

    def install(
        self, source: str, autograd_source: str, optim_source: str, bridge: object
    ) -> None:
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
            self._write_source(package / "autograd.py", autograd_source.encode("utf-8"))
            self._write_source(package / "optim.py", optim_source.encode("utf-8"))
            self.import_path = _OwnedImportPath(str(root))
            sys.path.insert(0, self.import_path)
            root_importer = self._install_importer(root)
            self.importer = root_importer
            package_importer = self._install_importer(package)
            self.package_importer = (str(package), package_importer)
            previous_bytecode = sys.dont_write_bytecode
            try:
                register_js_module(BRIDGE_NAME, bridge)
                self.registration = jsfinder.jsproxies[BRIDGE_NAME]
                self.modules[BRIDGE_NAME] = importlib.import_module(BRIDGE_NAME)
                # Source is already verified. Do not leave an untracked cache in
                # the borrowed interpreter's filesystem during initial import.
                sys.dont_write_bytecode = True
                importlib.import_module("torch")
                importlib.import_module("torch.autograd")
                importlib.import_module("torch.optim")
            finally:
                root_importer.modules = None
                package_importer.modules = None
                sys.dont_write_bytecode = previous_bytecode
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
        if self.package_importer is not None:
            package_path, importer = self.package_importer
            if sys.path_importer_cache.get(package_path) is importer:
                sys.path_importer_cache.pop(package_path, None)
            self.package_importer = None
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
