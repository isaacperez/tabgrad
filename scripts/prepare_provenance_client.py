"""Prepare the fixed optional CI client; import and tests make no network call."""

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import sys
import tarfile
from pathlib import Path
from urllib.request import urlopen

VERSION = "2.102.0"
ARCHIVE_URL = (
    "https://github.com/cli/cli/releases/download/v2.102.0/"
    "gh_2.102.0_linux_amd64.tar.gz"
)
ARCHIVE_BYTES = 15319960
ARCHIVE_SHA256 = "bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386"
CLIENT_MEMBER = "gh_2.102.0_linux_amd64/bin/gh"
MAX_CLIENT_BYTES = 128 * 1024 * 1024


class ClientPreparationError(ValueError):
    """A safe diagnostic without remote response or caller paths."""


def install_archive(
    raw: bytes, output: Path, expected_size: int, expected_sha256: str
) -> dict[str, object]:
    """Verify admitted archive bytes before reading one regular executable."""
    if len(raw) != expected_size or hashlib.sha256(raw).hexdigest() != expected_sha256:
        raise ClientPreparationError("CLIENT_ARCHIVE_IDENTITY")
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
        members = archive.getmembers()
        names = [entry.name for entry in members]
        if len(names) != len(set(names)):
            raise ClientPreparationError("CLIENT_ARCHIVE_MEMBERS")
        for entry in members:
            parts = Path(entry.name).parts
            if (
                entry.name.startswith("/")
                or ".." in parts
                or "\\" in entry.name
                or not parts
                or parts[0] != "gh_2.102.0_linux_amd64"
                or not (entry.isdir() or entry.isfile())
            ):
                raise ClientPreparationError("CLIENT_ARCHIVE_MEMBERS")
        selected = [entry for entry in members if entry.name == CLIENT_MEMBER]
        if (
            len(selected) != 1
            or not selected[0].isfile()
            or not 0 < selected[0].size <= MAX_CLIENT_BYTES
        ):
            raise ClientPreparationError("CLIENT_ARCHIVE_MEMBER")
        stream = archive.extractfile(selected[0])
        if stream is None:
            raise ClientPreparationError("CLIENT_ARCHIVE_MEMBER")
        with stream:
            client = stream.read(MAX_CLIENT_BYTES + 1)
        if len(client) != selected[0].size:
            raise ClientPreparationError("CLIENT_ARCHIVE_MEMBER")
    output.mkdir(mode=0o700)  # Existing output is never adopted or removed.
    try:
        executable = output / "gh"
        with executable.open("xb") as target:
            target.write(client)
        executable.chmod(0o700)
        identity: dict[str, object] = {
            "path": str(executable.resolve()),
            "version": VERSION,
            "sha256": hashlib.sha256(client).hexdigest(),
            "sourceArchiveSha256": expected_sha256,
        }
        (output / "client.json").write_text(
            json.dumps(identity) + "\n", encoding="utf-8"
        )
        (output / "client.json").chmod(0o600)
        return identity
    except BaseException as error:
        try:
            shutil.rmtree(output)
        except OSError:
            error.add_note("CLIENT_CLEANUP_INCOMPLETE")
        raise


def prepare_client(output: Path) -> dict[str, object]:
    """Explicit, separately authorized CI setup. TLS and vendor digest are premises."""
    if sys.platform != "linux" or os.uname().machine != "x86_64":
        raise ClientPreparationError("CLIENT_PLATFORM")
    if output.exists():
        raise ClientPreparationError("CLIENT_OUTPUT_EXISTS")
    with urlopen(ARCHIVE_URL, timeout=60) as response:
        if response.status != 200 or not response.geturl().startswith("https://"):
            raise ClientPreparationError("CLIENT_DOWNLOAD")
        raw = response.read(ARCHIVE_BYTES + 1)
    return install_archive(raw, output, ARCHIVE_BYTES, ARCHIVE_SHA256)


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ClientPreparationError("CLIENT_ARGUMENTS")
        print(json.dumps(prepare_client(Path(sys.argv[1]))))
    except (ValueError, OSError, EOFError, tarfile.TarError):
        print("CLIENT_PREPARATION_FAILED", file=sys.stderr)
        raise SystemExit(1) from None
