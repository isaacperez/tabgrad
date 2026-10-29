import hashlib
import io
import json
import tarfile
import tempfile
import unittest
from email.message import Message
from pathlib import Path
from typing import Literal
from unittest import mock

from scripts import prepare_publication_client as CLIENT


def archive(
    entries: list[tuple[tarfile.TarInfo, bytes]], mode: Literal["w:gz", "w:xz"]
) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode=mode) as target:
        for entry, content in entries:
            target.addfile(entry, io.BytesIO(content) if entry.isfile() else None)
    return output.getvalue()


def regular(name: str, content: bytes) -> tuple[tarfile.TarInfo, bytes]:
    entry = tarfile.TarInfo(name)
    entry.size = len(content)
    return entry, content


def profile(raw: bytes) -> CLIENT.NodeArchive:
    return {
        "platform": "linux",
        "architecture": "x64",
        "root": "vendor",
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


class PublicationPreparationTests(unittest.TestCase):
    def test_node_selects_only_regular_binary_without_following_vendor_links(
        self,
    ) -> None:
        link = tarfile.TarInfo("vendor/bin/npm")
        link.type = tarfile.SYMTYPE
        link.linkname = "../lib/npm-cli.js"
        raw = archive(
            [
                regular("vendor/bin/node", b"binary"),
                regular("vendor/LICENSE", b"vendor notices"),
                (link, b""),
            ],
            "w:xz",
        )
        self.assertEqual(
            CLIENT.node_files(raw, profile(raw)),
            {"node": b"binary", "node-license.txt": b"vendor notices"},
        )

    def test_node_rejects_identity_missing_duplicate_link_and_oversize(self) -> None:
        link = tarfile.TarInfo("vendor/bin/node")
        link.type = tarfile.SYMTYPE
        link.linkname = "/outside"
        for entries in [
            [],
            [(link, b"")],
            [regular("vendor/bin/node", b"x"), regular("vendor/bin/node", b"y")],
            [regular("vendor/bin/node", b"x")],
        ]:
            raw = archive(entries, "w:xz")
            with self.assertRaises(CLIENT.PublicationPreparationError):
                CLIENT.node_files(raw, profile(raw))
        raw = archive(
            [
                regular("vendor/bin/node", b"binary"),
                regular("vendor/LICENSE", b"notices"),
            ],
            "w:xz",
        )
        for field in ["bytes", "sha256"]:
            changed = profile(raw)
            if field == "bytes":
                changed["bytes"] = len(raw) - 1
            else:
                changed["sha256"] = "0" * 64
            with self.assertRaises(CLIENT.PublicationPreparationError):
                CLIENT.node_files(raw, changed)
        with (
            mock.patch.object(CLIENT, "MAX_NODE_BYTES", 1),
            self.assertRaises(CLIENT.PublicationPreparationError),
        ):
            CLIENT.node_files(raw, profile(raw))

    def npm_archive(self, extra: str | None = None) -> tuple[bytes, dict[str, bytes]]:
        files = {
            "package.json": json.dumps(
                {"name": "npm", "version": CLIENT.NPM_VERSION}
            ).encode(),
            "bin/npm-cli.js": b"controlled source; never executed",
        }
        entries = [regular("package/" + name, raw) for name, raw in files.items()]
        if extra is not None:
            entries.append(regular(extra, b"unexpected"))
        return archive(entries, "w:gz"), files

    def test_npm_preserves_exact_tree_with_no_execution(self) -> None:
        raw, files = self.npm_archive()
        with (
            mock.patch.object(CLIENT, "NPM_FILES", len(files)),
            mock.patch.object(
                CLIENT, "NPM_UNPACKED_BYTES", sum(map(len, files.values()))
            ),
        ):
            self.assertEqual(
                CLIENT.npm_files(raw, hashlib.sha512(raw).hexdigest()), files
            )

    def test_npm_rejects_wrong_digest_escape_links_duplicates_and_unknown_inventory(
        self,
    ) -> None:
        raw, files = self.npm_archive()
        with self.assertRaises(CLIENT.PublicationPreparationError):
            CLIENT.npm_files(raw, "0" * 128)
        for name in [
            "../outside",
            "package/../outside",
            "/package/outside",
            "package/bin/../x",
            "package\\x",
        ]:
            changed, _ = self.npm_archive(name)
            with (
                self.subTest(name=name),
                self.assertRaises(CLIENT.PublicationPreparationError),
            ):
                CLIENT.npm_files(changed, hashlib.sha512(changed).hexdigest())
        link = tarfile.TarInfo("package/link")
        link.type = tarfile.LNKTYPE
        link.linkname = "package/bin/npm-cli.js"
        for entries in [
            [(link, b"")],
            [regular("package/package.json", files["package.json"])] * 2,
        ]:
            changed = archive(entries, "w:gz")
            with self.assertRaises(CLIENT.PublicationPreparationError):
                CLIENT.npm_files(changed, hashlib.sha512(changed).hexdigest())
        with self.assertRaises(CLIENT.PublicationPreparationError):
            CLIENT.npm_files(raw, hashlib.sha512(raw).hexdigest())

    def test_owned_install_and_rollback_never_adopt_existing_output(self) -> None:
        node = archive(
            [
                regular("vendor/bin/node", b"binary"),
                regular("vendor/LICENSE", b"vendor notices"),
            ],
            "w:xz",
        )
        _, files = self.npm_archive()
        with tempfile.TemporaryDirectory() as name:
            output = Path(name) / "client"
            with mock.patch.object(CLIENT, "npm_files", return_value=files):
                identity = CLIENT.install_client(
                    node, b"controlled npm", output, profile(node)
                )
                self.assertEqual((output / "node").read_bytes(), b"binary")
                self.assertEqual((output / "node").stat().st_mode & 0o777, 0o700)
                self.assertEqual((output / "client.json").stat().st_mode & 0o777, 0o600)
                self.assertEqual(
                    identity["node"],
                    json.loads((output / "client.json").read_text())["node"],
                )
                self.assertEqual(
                    (output / "npm/bin/npm-cli.js").read_bytes(),
                    files["bin/npm-cli.js"],
                )
                with self.assertRaises(FileExistsError):
                    CLIENT.install_client(
                        node, b"controlled npm", output, profile(node)
                    )
                self.assertTrue((output / "client.json").is_file())
                failure = Path(name) / "failure"
                with (
                    mock.patch.object(
                        Path, "write_text", side_effect=OSError("controlled failure")
                    ),
                    self.assertRaises(OSError),
                ):
                    CLIENT.install_client(
                        node, b"controlled npm", failure, profile(node)
                    )
                self.assertFalse(failure.exists())

    def test_missing_platform_and_existing_paths_stop_before_network(self) -> None:
        with (
            tempfile.TemporaryDirectory() as name,
            mock.patch.object(CLIENT, "download") as get,
        ):
            with mock.patch.object(CLIENT.sys, "platform", "unsupported"):
                with self.assertRaises(CLIENT.PublicationPreparationError):
                    CLIENT.prepare_client(Path(name) / "new")
            with self.assertRaises(CLIENT.PublicationPreparationError):
                CLIENT.prepare_client(Path(name))
            get.assert_not_called()

    def test_fixture_acquisition_is_identified_bounded_and_owns_only_new_output(
        self,
    ) -> None:
        originals = {"one.json": b"one", "two.tgz": b"two"}
        manifest = {
            "files": [
                {
                    "name": key,
                    "url": "https://example.invalid/" + key,
                    "byteLength": len(raw),
                    "sha256": hashlib.sha256(raw).hexdigest(),
                }
                for key, raw in originals.items()
            ]
        }
        with tempfile.TemporaryDirectory() as name:
            output = Path(name) / "fixtures"
            with (
                mock.patch.object(Path, "read_text", return_value=json.dumps(manifest)),
                mock.patch.object(
                    CLIENT, "download", side_effect=list(originals.values())
                ) as get,
            ):
                CLIENT.prepare_fixtures(output)
                self.assertEqual(get.call_count, 2)
                with self.assertRaises(FileExistsError):
                    CLIENT.prepare_fixtures(output)
                self.assertEqual(get.call_count, 2)
            for key, raw in originals.items():
                self.assertEqual((output / key).read_bytes(), raw)
            failed = Path(name) / "failed"
            with (
                mock.patch.object(Path, "read_text", return_value=json.dumps(manifest)),
                mock.patch.object(CLIENT, "download", side_effect=[b"one", b"bad"]),
                self.assertRaises(CLIENT.PublicationPreparationError),
            ):
                CLIENT.prepare_fixtures(failed)
            self.assertFalse(failed.exists())
            self.assertTrue(output.is_dir())

    def test_setup_emits_only_its_original_manifest_digest_for_ci(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            raw = b'{"controlled":"manifest"}\n'
            (directory / "client.json").write_bytes(raw)
            result_path = directory / "workflow-output"
            with mock.patch.dict(
                CLIENT.os.environ,
                {"GITHUB_ACTIONS": "true", "GITHUB_OUTPUT": str(result_path)},
                clear=True,
            ):
                receipt = CLIENT.preparation_receipt(directory)
            expected = hashlib.sha256(raw).hexdigest()
            self.assertEqual(result_path.read_text(), f"client_sha256={expected}\n")
            self.assertEqual(receipt["clientSha256"], expected)
            self.assertNotIn(str(directory), json.dumps(receipt))

    def test_download_failures_preserve_safe_categories_without_transport_payload(
        self,
    ) -> None:
        for error, expected in [
            (
                CLIENT.HTTPError(
                    "https://example.invalid/private", 429, "PRIVATE", Message(), None
                ),
                "PUBLICATION_HTTP_RESPONSE",
            ),
            (CLIENT.URLError("PRIVATE transport diagnostics"), "PUBLICATION_NETWORK"),
        ]:
            with mock.patch.object(CLIENT, "urlopen", side_effect=error):
                with self.assertRaises(CLIENT.PublicationPreparationError) as caught:
                    CLIENT.download("https://example.invalid/original", 10)
            receipt = CLIENT.preparation_failure(caught.exception)
            self.assertEqual(receipt["code"], expected)
            self.assertNotIn("PRIVATE", json.dumps(receipt))
            self.assertNotIn("example.invalid", json.dumps(receipt))
        self.assertEqual(
            CLIENT.preparation_failure(OSError("PRIVATE path")),
            {"status": "failed", "code": "PUBLICATION_CLIENT_PREPARATION_FAILED"},
        )


if __name__ == "__main__":
    unittest.main()
