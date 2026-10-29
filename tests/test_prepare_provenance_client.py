import hashlib
import io
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import prepare_provenance_client as CLIENT


def archive_bytes(entries: list[tarfile.TarInfo]) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for entry in entries:
            archive.addfile(
                entry, io.BytesIO(b"finite-client") if entry.isfile() else None
            )
    return output.getvalue()


def regular(name: str = CLIENT.CLIENT_MEMBER) -> tarfile.TarInfo:
    entry = tarfile.TarInfo(name)
    entry.size = len(b"finite-client")
    return entry


class PrepareClientTests(unittest.TestCase):
    def install(self, raw: bytes, output: Path) -> dict[str, object]:
        return CLIENT.install_archive(
            raw, output, len(raw), hashlib.sha256(raw).hexdigest()
        )

    def test_extracts_only_the_identified_binary_without_executing_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "client"
            raw = archive_bytes(
                [regular(), regular("gh_2.102.0_linux_amd64/share/doc")]
            )
            identity = self.install(raw, output)
            self.assertEqual((output / "gh").read_bytes(), b"finite-client")
            self.assertEqual(
                set(p.name for p in output.iterdir()), {"gh", "client.json"}
            )
            self.assertEqual(
                identity["sha256"], hashlib.sha256(b"finite-client").hexdigest()
            )
            self.assertEqual((output / "gh").stat().st_mode & 0o777, 0o700)

    def test_rejects_size_and_digest_before_parsing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "client"
            raw = archive_bytes([regular()])
            for size, digest in [
                (len(raw) - 1, hashlib.sha256(raw).hexdigest()),
                (len(raw), "0" * 64),
            ]:
                with (
                    self.subTest(size=size, digest=digest),
                    self.assertRaises(CLIENT.ClientPreparationError),
                ):
                    CLIENT.install_archive(raw, output, size, digest)
                self.assertFalse(output.exists())

    def test_rejects_missing_duplicate_escape_and_link_members(self) -> None:
        link = tarfile.TarInfo("gh_2.102.0_linux_amd64/link")
        link.type = tarfile.SYMTYPE
        link.linkname = "/elsewhere"
        cases = [
            [],
            [regular(), regular()],
            [regular(), regular("../outside")],
            [regular(), regular("/outside")],
            [regular(), link],
        ]
        with tempfile.TemporaryDirectory() as directory:
            for entries in cases:
                with (
                    self.subTest(entries=[e.name for e in entries]),
                    self.assertRaises(CLIENT.ClientPreparationError),
                ):
                    self.install(archive_bytes(entries), Path(directory) / "client")
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_existing_output_is_never_adopted_or_removed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "client"
            output.mkdir()
            (output / "keep").write_bytes(b"owned-elsewhere")
            with self.assertRaises(FileExistsError):
                self.install(archive_bytes([regular()]), output)
            self.assertEqual((output / "keep").read_bytes(), b"owned-elsewhere")

    def test_failed_publication_removes_only_new_owned_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "client"
            with mock.patch.object(
                Path, "chmod", side_effect=OSError("fixture failure")
            ):
                with self.assertRaises(OSError):
                    self.install(archive_bytes([regular()]), output)
            self.assertFalse(output.exists())

    def test_declared_client_limit_is_enforced_before_reading(self) -> None:
        entry = regular()
        raw = archive_bytes([entry])
        with (
            tempfile.TemporaryDirectory() as directory,
            mock.patch.object(CLIENT, "MAX_CLIENT_BYTES", 2),
        ):
            with self.assertRaises(CLIENT.ClientPreparationError):
                self.install(raw, Path(directory) / "client")

    def test_incomplete_archive_is_not_installed(self) -> None:
        raw = archive_bytes([regular()])[:30]
        with (
            tempfile.TemporaryDirectory() as directory,
            self.assertRaises((tarfile.TarError, EOFError)),
        ):
            self.install(raw, Path(directory) / "client")


if __name__ == "__main__":
    unittest.main()
