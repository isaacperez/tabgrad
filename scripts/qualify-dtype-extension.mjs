import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createPackageApplication } from "../js-tests/fixtures/package-application.mjs";
import { checkPublicPackageCpuAssets, checkPublicPackageEntries } from "../js-tests/fixtures/package-consumer.mjs";
import { browserDefinitions, browserVersion, resolveBrowser } from "./browser-harness.mjs";
import { validateCompactFloatOracle, runDTypeConformance } from "./dtype-conformance.mjs";

const [tarball, evidencePath, oraclePath] = process.argv.slice(2);
if (process.argv.length !== 5 || [tarball, evidencePath, oraclePath].some(value => !value || value.startsWith("--"))) {
  throw new Error("Usage: node scripts/qualify-dtype-extension.mjs ARCHIVE EVIDENCE ORACLE");
}
const bytes = await readFile(oraclePath);
const oracle = JSON.parse(bytes);
const { dtype, fractionBits } = oracle;
const profile = { dtype, fractionBits, oracle };
validateCompactFloatOracle(profile, oracle);
const expected = JSON.parse(await readFile(evidencePath, "utf8"));
const browser = browserDefinitions.find(candidate => candidate.name === "Chrome");
const executable = await resolveBrowser(browser);
if (!executable) throw new Error("The dtype extension check requires the prepared Chrome browser.");
const version = browserVersion(executable);
const application = await createPackageApplication({ tarball, expected });
const observations = [];
const notes = [];
try {
  await checkPublicPackageEntries(application);
  await checkPublicPackageCpuAssets(application);
  const distributionDirectory = join(application.packageDirectory, "dist");
  const shared = { browser, executable, version, profile, distributionDirectory, reportNote: note => notes.push(note.trimEnd()) };
  for (const language of ["javascript", "python"]) {
    for (const variant of ["scalar", "simd128"]) {
      observations.push(...await runDTypeConformance({ ...shared, language, device: "cpu", variant }));
    }
    observations.push(...await runDTypeConformance({ ...shared, language, device: "webgpu" }));
  }
} finally {
  await application.close();
}

console.log(JSON.stringify({ status: "passed", sourceRevision: expected.sourceRevision,
  archiveSha256: expected.tarball.sha256, oracleSha256: createHash("sha256").update(bytes).digest("hex"),
  browser: browser.name, version, dtype, observations, notes }));
