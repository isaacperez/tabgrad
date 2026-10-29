"""Explicit isolated publisher setup; import never downloads or executes clients."""

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import sys
import tarfile
from pathlib import Path, PurePosixPath
from typing import TypedDict, TypeGuard
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

# This is reviewed source configuration, not a caller-supplied setup profile.
PROFILE = json.loads(
    Path(__file__).with_name("publication-client-profile.json").read_bytes()
)
NODE_VERSION: str = PROFILE["node"]["version"]
NPM_VERSION: str = PROFILE["npm"]["version"]
NPM_URL: str = PROFILE["npm"]["url"]
NPM_SHA512: str = PROFILE["npm"]["sha512"]
# The admitted registry metadata counts regular files and their total bytes.
NPM_FILES: int = PROFILE["npm"]["fileCount"]
NPM_UNPACKED_BYTES: int = PROFILE["npm"]["unpackedBytes"]
# Tar headers/padding give a bounded read even when a response omits its length.
NPM_DOWNLOAD_LIMIT = NPM_UNPACKED_BYTES + NPM_FILES * 1024 + 10240
MAX_NODE_BYTES: int = PROFILE["node"]["maxBinaryBytes"]
MAX_NODE_LICENSE_BYTES: int = PROFILE["node"]["maxLicenseBytes"]


class NodeArchive(TypedDict):
    platform: str
    architecture: str
    root: str
    bytes: int
    sha256: str


NODE_ARCHIVES: dict[str, NodeArchive] = PROFILE["node"]["archives"]


class PublicationPreparationError(ValueError):
    """Safe setup failure; caller paths and transport diagnostics stay private."""

    def __init__(
        self, code: str, details: dict[str, str | int | bool] | None = None
    ) -> None:
        super().__init__(code)
        self.code = code
        self.details = {} if details is None else details


def identified_bytes(raw: bytes, algorithm: str, expected: str) -> None:
    if hashlib.new(algorithm, raw).hexdigest() != expected:
        raise PublicationPreparationError("PUBLICATION_ARCHIVE_IDENTITY")


def regular_bytes(archive: tarfile.TarFile, entry: tarfile.TarInfo) -> bytes:
    if not entry.isfile():
        raise PublicationPreparationError("PUBLICATION_ARCHIVE_MEMBER")
    stream = archive.extractfile(entry)
    if stream is None:
        raise PublicationPreparationError("PUBLICATION_ARCHIVE_MEMBER")
    with stream:
        raw = stream.read(entry.size + 1)
    if len(raw) != entry.size:
        raise PublicationPreparationError("PUBLICATION_ARCHIVE_MEMBER")
    return raw


def node_files(raw: bytes, profile: NodeArchive) -> dict[str, bytes]:
    if len(raw) != profile["bytes"]:
        raise PublicationPreparationError("PUBLICATION_ARCHIVE_IDENTITY")
    identified_bytes(raw, "sha256", profile["sha256"])
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:xz") as archive:
        members = archive.getmembers()
        files: dict[str, bytes] = {}
        for name, vendor_name, limit in [
            ("node", "/bin/node", MAX_NODE_BYTES),
            ("node-license.txt", "/LICENSE", MAX_NODE_LICENSE_BYTES),
        ]:
            entries = [
                entry
                for entry in members
                if entry.name == profile["root"] + vendor_name
            ]
            if len(entries) != 1 or not 0 < entries[0].size <= limit:
                raise PublicationPreparationError("PUBLICATION_ARCHIVE_MEMBER")
            files[name] = regular_bytes(archive, entries[0])
        # Other vendor members (including npm links) are never extracted.
        return files


def npm_files(raw: bytes, expected_sha512: str = NPM_SHA512) -> dict[str, bytes]:
    identified_bytes(raw, "sha512", expected_sha512)
    files: dict[str, bytes] = {}
    names: set[str] = set()
    total = 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
        for entry in archive:
            path = PurePosixPath(entry.name)
            if (
                not path.parts
                or path.parts[0] != "package"
                or ".." in path.parts
                or "\\" in entry.name
                or str(path) != entry.name.rstrip("/")
                or str(path) in names
                or not (entry.isdir() or entry.isfile())
            ):
                raise PublicationPreparationError("PUBLICATION_ARCHIVE_MEMBERS")
            names.add(str(path))
            if entry.isdir():
                continue
            total += entry.size
            if total > NPM_UNPACKED_BYTES or len(files) >= NPM_FILES:
                raise PublicationPreparationError("PUBLICATION_ARCHIVE_SIZE")
            relative = path.relative_to("package").as_posix()
            if relative == ".":
                raise PublicationPreparationError("PUBLICATION_ARCHIVE_MEMBER")
            files[relative] = regular_bytes(archive, entry)
    manifest: dict[str, object] | list[object] | str | int | float | bool | None = (
        json.loads(files.get("package.json", b"{}"))
    )
    if (
        len(files) != NPM_FILES
        or total != NPM_UNPACKED_BYTES
        or "bin/npm-cli.js" not in files
        or not isinstance(manifest, dict)
        or manifest.get("version") != NPM_VERSION
    ):
        raise PublicationPreparationError("PUBLICATION_ARCHIVE_CONTENTS")
    return files


def install_client(
    node_raw: bytes, npm_raw: bytes, output: Path, profile: NodeArchive
) -> dict[str, object]:
    """Identify both vendor archives before creating an exclusively owned tree."""
    node = node_files(node_raw, profile)
    binary = node["node"]
    files = npm_files(npm_raw)
    output.mkdir(mode=0o700)  # Never adopt/remove an existing caller directory.
    try:
        executable = output / "node"
        with executable.open("xb") as target:
            target.write(binary)
        executable.chmod(0o700)
        license_path = output / "node-license.txt"
        license_path.write_bytes(node["node-license.txt"])
        license_path.chmod(0o600)
        inventory: list[dict[str, object]] = []
        for name, raw in sorted(files.items()):
            destination = output / "npm" / name
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with destination.open("xb") as target:
                target.write(raw)
            destination.chmod(0o600)
            inventory.append(
                {
                    "path": name,
                    "byteLength": len(raw),
                    "sha256": hashlib.sha256(raw).hexdigest(),
                }
            )
        identity: dict[str, object] = {
            "schemaVersion": 1,
            "platform": profile["platform"],
            "architecture": profile["architecture"],
            "node": {
                "path": "node",
                "version": NODE_VERSION,
                "byteLength": len(binary),
                "sha256": hashlib.sha256(binary).hexdigest(),
                "sourceArchiveSha256": profile["sha256"],
                "license": {
                    "path": "node-license.txt",
                    "byteLength": len(node["node-license.txt"]),
                    "sha256": hashlib.sha256(node["node-license.txt"]).hexdigest(),
                },
            },
            "npm": {
                "directory": "npm",
                "version": NPM_VERSION,
                "sourceArchiveSha512": NPM_SHA512,
                "files": inventory,
            },
        }
        manifest = output / "client.json"
        manifest.write_text(
            json.dumps(identity, sort_keys=True) + "\n", encoding="utf-8"
        )
        manifest.chmod(0o600)
        return identity
    except BaseException as error:
        try:
            shutil.rmtree(output)
        except OSError:
            error.add_note("PUBLICATION_CLEANUP_INCOMPLETE")
        raise


def download(url: str, limit: int) -> bytes:
    try:
        with urlopen(url, timeout=60) as response:
            if response.status != 200 or response.geturl() != url:
                raise PublicationPreparationError(
                    "PUBLICATION_DOWNLOAD",
                    {
                        "httpStatus": response.status,
                        "redirected": response.geturl() != url,
                    },
                )
            raw = response.read(limit + 1)
    except HTTPError as error:
        raise PublicationPreparationError(
            "PUBLICATION_HTTP_RESPONSE", {"httpStatus": error.code}
        ) from error
    except URLError as error:
        raise PublicationPreparationError("PUBLICATION_NETWORK") from error
    if len(raw) > limit:
        raise PublicationPreparationError("PUBLICATION_DOWNLOAD_SIZE")
    return raw


def prepare_client(output: Path) -> dict[str, object]:
    """Explicit setup, not verification; TLS/vendor digest admission is a premise."""
    if sys.platform not in {"darwin", "linux"}:
        raise PublicationPreparationError("PUBLICATION_PLATFORM")
    architecture = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64"}.get(
        os.uname().machine
    )
    profile = NODE_ARCHIVES.get(f"{sys.platform}-{architecture}")
    if profile is None:
        raise PublicationPreparationError("PUBLICATION_PLATFORM")
    if output.exists() or output.is_symlink():
        raise PublicationPreparationError("PUBLICATION_OUTPUT_EXISTS")
    node_raw = download(
        f"https://nodejs.org/dist/v{NODE_VERSION}/{profile['root']}.tar.xz",
        profile["bytes"],
    )
    identified_bytes(node_raw, "sha256", profile["sha256"])
    npm_raw = download(NPM_URL, NPM_DOWNLOAD_LIMIT)
    return install_client(node_raw, npm_raw, output, profile)


def json_object(value: object) -> TypeGuard[dict[str, object]]:
    """A JSON-decoded object has string keys; this checks the mapping boundary."""
    return isinstance(value, dict)


def json_array(value: object) -> TypeGuard[list[object]]:
    return isinstance(value, list)


def fixture_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise PublicationPreparationError("PUBLICATION_FIXTURE_ENVELOPE")
        value[key] = item
    return value


def fixture_bundle(raw: bytes, predicate_type: str) -> bytes:
    """Canonicalize the complete selected bundle, never its signed strings."""
    try:
        envelope: object = json.loads(raw, object_pairs_hook=fixture_object)
        if not json_object(envelope):
            raise PublicationPreparationError("PUBLICATION_FIXTURE_ENVELOPE")
        attestations = envelope.get("attestations")
        if not json_array(attestations):
            raise PublicationPreparationError("PUBLICATION_FIXTURE_ENVELOPE")
        bundles = [
            value.get("bundle")
            for value in attestations
            if json_object(value) and value.get("predicateType") == predicate_type
        ]
        if len(bundles) != 1 or not json_object(bundles[0]):
            raise PublicationPreparationError("PUBLICATION_FIXTURE_ENVELOPE")
        return (
            json.dumps(
                bundles[0],
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
                allow_nan=False,
            )
            + "\n"
        ).encode()
    except (ValueError, UnicodeError) as error:
        if isinstance(error, PublicationPreparationError):
            raise
        raise PublicationPreparationError("PUBLICATION_FIXTURE_ENVELOPE") from error


def prepare_fixtures(output: Path) -> list[dict[str, str | int | bool]]:
    """Acquire identified public originals; never execute the package or sign."""
    manifest = json.loads(
        (
            Path(__file__).resolve().parent.parent
            / "js-tests/fixtures/publication-client.json"
        ).read_text(encoding="utf-8")
    )
    output.mkdir(mode=0o700)
    observations: list[dict[str, str | int | bool]] = []
    try:
        for entry in manifest["files"]:
            observation: dict[str, str | int | bool] = {}
            try:
                if entry["kind"] == "raw":
                    raw = download(entry["url"], entry["byteLength"])
                elif entry["kind"] == "attestation-envelope":
                    envelope = download(entry["url"], entry["maxDownloadBytes"])
                    observation = {
                        "input": entry["name"],
                        "envelopeBytes": len(envelope),
                        "envelopeSha256": hashlib.sha256(envelope).hexdigest(),
                    }
                    observation["baselineEnvelope"] = (
                        "exact"
                        if observation["envelopeBytes"]
                        == entry["baselineEnvelope"]["byteLength"]
                        and observation["envelopeSha256"]
                        == entry["baselineEnvelope"]["sha256"]
                        else "different"
                    )
                    observations.append(observation)
                    raw = fixture_bundle(envelope, entry["predicateType"])
                else:
                    raise PublicationPreparationError("PUBLICATION_FIXTURE_PROFILE")
                if len(raw) != entry["byteLength"]:
                    raise PublicationPreparationError(
                        "PUBLICATION_FIXTURE_SIZE", {"observedBytes": len(raw)}
                    )
                if hashlib.sha256(raw).hexdigest() != entry["sha256"]:
                    raise PublicationPreparationError(
                        "PUBLICATION_FIXTURE_IDENTITY",
                        {"observedSha256": hashlib.sha256(raw).hexdigest()},
                    )
            except PublicationPreparationError as error:
                error.details.update(observation)
                error.details["input"] = entry["name"]
                raise
            path = output / entry["name"]
            path.write_bytes(raw)
            path.chmod(0o600)
        return observations
    except BaseException as error:
        try:
            shutil.rmtree(output)
        except OSError:
            error.add_note("PUBLICATION_CLEANUP_INCOMPLETE")
        raise


def preparation_receipt(output: Path) -> dict[str, str]:
    identity = hashlib.sha256((output / "client.json").read_bytes()).hexdigest()
    # Only the safe digest is a workflow output, never local paths/configuration.
    if os.environ.get("GITHUB_ACTIONS") == "true" and (
        destination := os.environ.get("GITHUB_OUTPUT")
    ):
        with Path(destination).open("a", encoding="utf-8") as target:
            target.write(f"client_sha256={identity}\n")
    return {
        "status": "prepared",
        "node": NODE_VERSION,
        "npm": NPM_VERSION,
        "clientSha256": identity,
    }


def preparation_failure(error: BaseException) -> dict[str, object]:
    """Only codes and public-source observations; never raw exceptions or paths."""
    if isinstance(error, PublicationPreparationError):
        return {"status": "failed", "code": error.code, "observation": error.details}
    return {"status": "failed", "code": "PUBLICATION_CLIENT_PREPARATION_FAILED"}


if __name__ == "__main__":
    try:
        if len(sys.argv) == 3 and sys.argv[1] == "--fixtures":
            observations = prepare_fixtures(Path(sys.argv[2]))
            print(
                json.dumps(
                    {
                        "status": "prepared",
                        "input": "original-public-fixtures",
                        "observations": observations,
                    }
                )
            )
            raise SystemExit(0)
        if len(sys.argv) != 2:
            raise PublicationPreparationError("PUBLICATION_ARGUMENTS")
        output = Path(sys.argv[1])
        prepare_client(output)
        print(json.dumps(preparation_receipt(output)))
    except (ValueError, OSError, EOFError, tarfile.TarError) as error:
        print(json.dumps(preparation_failure(error)), file=sys.stderr)
        raise SystemExit(1) from None
