"""Fixed diagnostic FIFO preparation; tests supply finite syscalls, never real FIFO."""

from __future__ import annotations

import json
import os
import stat
import sys
from collections.abc import Mapping
from typing import BinaryIO, Protocol, TextIO, TypeGuard, cast


class FifoCalls(Protocol):
    """The retained native descriptor boundary used by this one helper."""

    def open_root(self, path: str) -> int: ...
    def mkfifo(self, name: str, root: int) -> None: ...
    def open_fifo(self, name: str, root: int) -> int: ...
    def metadata(self, descriptor: int) -> Mapping[str, int]: ...
    def permissions(self, descriptor: int, gid: int) -> None: ...
    def close(self, descriptor: int) -> None: ...


class NativeFifoCalls:
    def open_root(self, path: str) -> int:
        return os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)

    def mkfifo(self, name: str, root: int) -> None:
        os.mkfifo(name, 0o660, dir_fd=root)

    def open_fifo(self, name: str, root: int) -> int:
        return os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root)

    def metadata(self, descriptor: int) -> Mapping[str, int]:
        value = os.fstat(descriptor)
        return {
            "dev": value.st_dev,
            "ino": value.st_ino,
            "mode": value.st_mode,
            "uid": value.st_uid,
            "gid": value.st_gid,
        }

    def permissions(self, descriptor: int, gid: int) -> None:
        os.fchown(descriptor, 0, gid)
        os.fchmod(descriptor, 0o660)

    def close(self, descriptor: int) -> None:
        os.close(descriptor)


def _uint(value: object) -> TypeGuard[str]:
    return (
        isinstance(value, str)
        and value.isascii()
        and value.isdecimal()
        and str(int(value)) == value
        and int(value) < 1 << 64
    )


def _fields(value: object, names: set[str]) -> TypeGuard[dict[str, object]]:
    return type(value) is dict and set(cast(dict[object, object], value)) == names


def prepare_fifos(value: object, calls: FifoCalls) -> dict[str, object]:
    """Retain partial effects and close uncertainty instead of retrying a name."""
    result: dict[str, object] = {
        "complete": False,
        "created": [],
        "error": None,
        "closeUnknown": [],
    }
    created: list[dict[str, object]] = []
    result["created"] = created
    unknown: list[int] = []
    result["closeUnknown"] = unknown
    owned: list[int] = []
    try:
        if not _fields(value, {"schemaVersion", "root", "gid"}):
            raise ValueError("LAB_INPUT")
        root = value["root"]
        if (
            type(value["schemaVersion"]) is not int
            or value["schemaVersion"] != 1
            or not _fields(root, {"path", "identity"})
        ):
            raise ValueError("LAB_INPUT")
        path = root["path"]
        identity = root["identity"]
        gid = value["gid"]
        if not (
            isinstance(path, str)
            and path.startswith("/")
            and os.path.normpath(path) == path
            and path != "/"
            and len(path.encode("utf-8")) <= 4096
            and "\\" not in path
            and not any(ord(c) < 32 or ord(c) == 127 for c in path)
            and _fields(identity, {"dev", "ino"})
            and _uint(gid)
            and 0 < int(gid) <= 0xFFFFFFFF
        ):
            raise ValueError("LAB_INPUT")
        if not (
            _uint(identity["dev"]) and _uint(identity["ino"]) and identity["ino"] != "0"
        ):
            raise ValueError("LAB_INPUT")
        root_fd = calls.open_root(path)
        owned.append(root_fd)
        observed = calls.metadata(root_fd)
        if not (
            stat.S_ISDIR(observed["mode"])
            and str(observed["dev"]) == identity["dev"]
            and str(observed["ino"]) == identity["ino"]
            and observed["uid"] == 0
            and observed["gid"] == int(gid)
            and stat.S_IMODE(observed["mode"]) == 0o750
        ):
            raise ValueError("LAB_IDENTITY")
        identities = {(observed["dev"], observed["ino"])}
        for name in ("stdout", "stderr", "control"):
            calls.mkfifo(name, root_fd)
            entry: dict[str, object] = {"name": name, "identity": None, "ready": False}
            created.append(entry)
            descriptor = calls.open_fifo(name, root_fd)
            owned.append(descriptor)
            before = calls.metadata(descriptor)
            if not (
                stat.S_ISFIFO(before["mode"])
                and before["dev"] == observed["dev"]
                and before["ino"] > 0
                and (before["dev"], before["ino"]) not in identities
            ):
                raise ValueError("LAB_IDENTITY")
            identities.add((before["dev"], before["ino"]))
            entry["identity"] = {"dev": str(before["dev"]), "ino": str(before["ino"])}
            calls.permissions(descriptor, int(gid))
            after = calls.metadata(descriptor)
            if not (
                stat.S_ISFIFO(after["mode"])
                and before["dev"] == after["dev"]
                and before["ino"] == after["ino"]
                and after["uid"] == 0
                and after["gid"] == int(gid)
                and stat.S_IMODE(after["mode"]) == 0o660
            ):
                raise ValueError("LAB_IDENTITY")
            owned.remove(descriptor)
            try:
                calls.close(descriptor)
            except Exception:
                unknown.append(descriptor)
                raise ValueError("LAB_CLEANUP") from None
            entry["ready"] = True
        result["complete"] = True
    except Exception as error:
        code = str(error)
        result["error"] = (
            code
            if code in {"LAB_INPUT", "LAB_IDENTITY", "LAB_CLEANUP"}
            else "LAB_WRITE"
        )
    finally:
        for descriptor in reversed(owned):
            try:
                calls.close(descriptor)
            except Exception:
                unknown.append(descriptor)
                result["complete"] = False
                if result["error"] is None:
                    result["error"] = "LAB_CLEANUP"
    return result


def _object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("LAB_INPUT")
        result[key] = value
    return result


def main(
    args: list[str], stdin: BinaryIO = sys.stdin.buffer, stdout: TextIO = sys.stdout
) -> int:
    result: dict[str, object]
    try:
        if (
            len(args) != 2
            or args[0] != "32768"
            or sys.platform != "linux"
            or sys.version_info[:2] != (3, 11)
            or sys.prefix == sys.base_prefix
            or os.path.realpath(sys.prefix) != args[1]
        ):
            raise ValueError("LAB_INPUT")
        data = stdin.read(32769)
        if len(data) > 32768:
            raise ValueError("LAB_INPUT")
        result = prepare_fifos(
            json.loads(data.decode("utf-8"), object_pairs_hook=_object),
            NativeFifoCalls(),
        )
    except Exception:
        result = {
            "complete": False,
            "created": [],
            "error": "LAB_INPUT",
            "closeUnknown": [],
        }
    stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
    return 0 if result["complete"] is True else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
