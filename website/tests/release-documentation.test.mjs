import test from "node:test";
import assert from "node:assert/strict";
import { parseReleaseCatalogue, readReleaseMetadata, resolveReleaseCatalogue, releaseNotesSection, admitReleaseDocumentation } from "../../scripts/release-documentation.mjs";

const source = "a".repeat(40);
const admission = { directories: ["concepts"], individual: ["docs/javascript-api.md"] };
const support = { summary: "Calculate locally.", capabilities: [{ title: "Arithmetic", description: "Add tensors.", source: "docs/javascript-api.md" }],
  environments: [{ title: "CPU", usage: "Default", tested: "Chrome", setup: "Load the package.", links: [{ label: "Setup", source: "docs/javascript-api.md" }] }],
  limits: [{ title: "Data", description: "Float32." }] };
const metadata = version => ({ schemaVersion: 1, version, title: "Tensor arithmetic", documentationImpact: "Public references describe the supported calls.", support });
const record = data => `# Source and support\n\n<!-- tabgrad-release\n${JSON.stringify(data)}\n-->\n`;
const catalogue = entries => parseReleaseCatalogue(JSON.stringify({ schemaVersion: 1, releases: entries }));
const entry = (version, origin = source) => ({ version, source: origin, documentation: admission });

test("catalogue rejects ambiguous, unsafe and unordered source admission", () => {
  assert.equal(catalogue([entry("0.3.0")]).releases[0].source, source);
  for (const entries of [[entry("0.3.0"), entry("0.3.0")], [entry("0.3.0"), entry("0.4.0")],
    [entry("0.3.0", "main")], [entry("0.3.0", "candidate"), entry("0.2.0", "candidate")],
    [{ ...entry("0.3.0"), documentation: { directories: ["../local"], individual: [] } }]]) {
    assert.throws(() => catalogue(entries));
  }
});

test("support records own presentation and attributable documentation impact", () => {
  assert.equal(readReleaseMetadata(record(metadata("0.3.0")), "0.3.0").title, "Tensor arithmetic");
  assert.throws(() => readReleaseMetadata(record(metadata("0.3.0")), "0.4.0"), /Invalid/);
  assert.throws(() => readReleaseMetadata("# Empty", "0.3.0"), /Missing/);
  assert.throws(() => readReleaseMetadata(record(metadata("0.3.0")) + record(metadata("0.3.0")), "0.3.0"), /ambiguous/);
  assert.throws(() => readReleaseMetadata(record({ ...metadata("0.3.0"), documentationImpact: "" }), "0.3.0"), /Invalid/);
});

test("a new release explicitly inherits unchanged support and overrides only its changes", () => {
  const values = catalogue([entry("0.4.0", "candidate"), entry("0.3.0")]);
  const current = { schemaVersion: 1, version: "0.4.0", title: "Broadcasting", documentationImpact: "Addition and multiplication document broadcasting.",
    inherits: "0.3.0", support: { summary: "Broadcast compatible tensor shapes." } };
  const records = new Map([["0.3.0", record(metadata("0.3.0"))], ["0.4.0", record(current)]]);
  const resolved = resolveReleaseCatalogue(values, records);
  assert.equal(resolved[0].support.summary, "Broadcast compatible tensor shapes.");
  assert.deepEqual(resolved[0].support.capabilities, support.capabilities);
  assert.equal(admitReleaseDocumentation(resolved, "0.4.0", source, "0.4.0").source, source);
  assert.throws(() => admitReleaseDocumentation(resolved, "0.4.0", source, "0.3.0"), /does not match/);
  assert.throws(() => admitReleaseDocumentation(resolved, "0.5.0", source, "0.5.0"), /does not match/);
  assert.throws(() => admitReleaseDocumentation(resolved, "0.3.0", "b".repeat(40), "0.3.0"), /does not match/);
  records.delete("0.3.0"); assert.throws(() => resolveReleaseCatalogue(values, records), /Missing/);
});

test("every selected version needs dated substantive notes rather than a placeholder", () => {
  const good = "# Changelog\n\n## Unreleased\n\n## 0.4.0 - 2026-11-15\n\n### Added\n\n- Broadcast compatible shapes with gradients.\n\n## 0.3.0 - 2026-11-05\n\n### Added\n\n- Read diagnostics.\n";
  assert.equal(releaseNotesSection(good, "0.4.0").date, "2026-11-15");
  assert.ok(!releaseNotesSection(good, "0.4.0").body.includes("Read diagnostics"));
  for (const body of ["## 0.4.0 - 2026-11-15\n\nTBD\n", good.replace("2026-11-15", "2026-02-30"), good + "\n## 0.4.0 - 2026-11-15\n", good.replace("### Added", "### Internal")]) {
    assert.throws(() => releaseNotesSection(body, "0.4.0"));
  }
});
