import { readFile, writeFile } from "node:fs/promises";

// pip owns dependency resolution. This translates its reviewed installation
// report into exact wheel references; it never resolves or downloads packages.
const reportPath = process.argv[2];
if (!reportPath || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/write-oracle-lock.mjs <pip-report.json>");
}
const report = JSON.parse(await readFile(reportPath, "utf8"));
const environment = report.environment;
if (
  report.version !== "1"
  || environment?.implementation_name !== "cpython"
  || environment?.python_version !== "3.11"
  || environment?.sys_platform !== "darwin"
  || environment?.platform_machine !== "arm64"
) {
  throw new Error("The oracle lock requires a CPython 3.11 macOS arm64 report.");
}
const requested = (await readFile("requirements-oracle.in", "utf8"))
  .split("\n").filter((line) => line && !line.startsWith("#"));
const direct = report.install.filter((entry) => entry.requested)
  .map((entry) => `${entry.metadata.name}==${entry.metadata.version}`);
if (JSON.stringify(direct.sort()) !== JSON.stringify(requested.sort())) {
  throw new Error("The pip report does not match requirements-oracle.in.");
}
const lines = report.install.map((entry) => {
  const { name, version } = entry.metadata;
  const { url, archive_info: archive } = entry.download_info;
  const source = new URL(url);
  const digest = archive?.hashes?.sha256;
  if (
    source.protocol !== "https:" || source.hostname !== "files.pythonhosted.org"
    || !source.pathname.endsWith(".whl") || source.search || source.hash
    || !/^[a-f0-9]{64}$/.test(digest ?? "")
    || !/^[A-Za-z0-9_.-]+$/.test(name)
  ) {
    throw new Error(`Expected a hashed PyPI wheel for ${name}.`);
  }
  return `# ${name} ${version}\n${name} @ ${url} --hash=sha256:${digest}\n`;
}).sort();
await writeFile("requirements-oracle.lock", [
  "# Generated from pip's report by scripts/write-oracle-lock.mjs.",
  "# CPython 3.11, macOS 14+ arm64; exact wheels, no source builds or CUDA.",
  "# Update through the procedure in docs/development.md, not by hand.",
  "", ...lines,
].join("\n"));
