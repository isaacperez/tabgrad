"""Expose pinned upstream Pyodide declarations for static analysis only.

The npm distribution stores its typed Python modules in a ZIP archive, not
on the checker's import path. Copy only those modules beside the locked
dependency; do not import them into native CPython or distribute this copy.
"""

from pathlib import Path, PurePosixPath
from zipfile import ZipFile


def prepare_pyodide_types(dependency: Path) -> None:
    """Extract the installed upstream modules without downloading dependencies."""
    with ZipFile(dependency / "python_stdlib.zip") as archive:
        for name in archive.namelist():
            path = PurePosixPath(name)
            if not path.parts or path.parts[0] not in {"pyodide", "_pyodide"}:
                continue
            if path.is_absolute() or ".." in path.parts or "\\" in name:
                raise ValueError(f"Invalid Pyodide declaration path: {name!r}")
            archive.extract(name, dependency / "python-types")


if __name__ == "__main__":
    prepare_pyodide_types(
        Path(__file__).resolve().parent.parent / "node_modules" / "pyodide"
    )
