import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { platform, release, arch } from "node:os";
import { execFileSync } from "node:child_process";
import { browserDefinitions, browserVersion, resolveBrowser, runBrowserPage, selectBrowserDefinitions, startBrowserServer } from "./browser-harness.mjs";

const mode = process.argv[2];
if (mode !== "pilot" && mode !== "measure") throw new Error("Use: node scripts/measure-webgpu.mjs pilot|measure");
const fingerprint = createHash("sha256");
for (const name of (await readdir(new URL("../src/", import.meta.url))).filter((name) => name.endsWith(".ts")).sort()) {
  fingerprint.update(name).update(await readFile(new URL(`../src/${name}`, import.meta.url)));
}
const report = { mode, measuredAt: new Date().toISOString(), sourceSha256: fingerprint.digest("hex"),
  platform: platform(), operatingSystemRelease: release(), architecture: arch(), node: process.version,
  operatingSystemVersion: platform() === "darwin" ? execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim() : release(),
  browsers: [] };
const server = await startBrowserServer(["webgpu-measure.html"], { assets: ["webgpu-measure.mjs"] });
try {
  for (const browser of selectBrowserDefinitions(process.env.TABGRAD_BROWSER ?? "Chrome", browserDefinitions)) {
    const executable = await resolveBrowser(browser), version = browserVersion(executable);
    await runBrowserPage({ server, browser, executable, version, page: "webgpu-measure.html",
      parameters: { mode }, applicationTimeoutMilliseconds: 65_000,
      validateResult(result) {
        report.browsers.push({ browser: browser.name, version, result });
        if (!result.ok) throw new Error(JSON.stringify(result.error));
      } });
  }
} finally {
  await server.close();
  await mkdir(new URL("../test-results/", import.meta.url), { recursive: true });
  const filename = `webgpu-${mode}-${report.measuredAt.replaceAll(":", "-")}.json`;
  await writeFile(new URL(`../test-results/${filename}`, import.meta.url), JSON.stringify(report, null, 2));
  process.stdout.write(`Saved test-results/${filename}\n`);
}
