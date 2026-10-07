import { mkdir, writeFile } from "node:fs/promises";
import { platform, release, arch } from "node:os";
import { execFileSync } from "node:child_process";
import { browserDefinitions, browserVersion, resolveBrowser, runBrowserPage, selectBrowserDefinitions, startBrowserServer } from "./browser-harness.mjs";
import { fingerprintTypeScriptSources } from "./source-identity.mjs";

const mode = process.argv[2];
const operation = process.argv[3] ?? "add";
if (!["pilot", "measure"].includes(mode) || !["add", "sum"].includes(operation)) throw new Error("Use: node scripts/measure-webgpu.mjs pilot|measure [add|sum]");
const sourceSha256 = await fingerprintTypeScriptSources(new URL("../src/", import.meta.url));
const report = { mode, operation, measuredAt: new Date().toISOString(), sourceSha256,
  platform: platform(), operatingSystemRelease: release(), architecture: arch(), node: process.version,
  operatingSystemVersion: platform() === "darwin" ? execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim() : release(),
  completed: false, browsers: [] };
const stem = operation === "sum" ? "webgpu-sum-measure" : "webgpu-measure";
const page = `measurements/webgpu/${stem}.html`;
const server = await startBrowserServer([page], { assets: [`measurements/webgpu/${stem}.mjs`] });
try {
  for (const browser of selectBrowserDefinitions(process.env.TABGRAD_BROWSER ?? "Chrome", browserDefinitions)) {
    const attempt = { browser: browser.name, completed: false };
    report.browsers.push(attempt);
    const executable = await resolveBrowser(browser), version = browserVersion(executable);
    attempt.version = version;
    await runBrowserPage({ server, browser, executable, version, page,
      parameters: { mode }, applicationTimeoutMilliseconds: 65_000,
      validateResult(result) {
        attempt.result = result;
        if (!result.ok) throw new Error(JSON.stringify(result.error));
      } });
    attempt.completed = true;
  }
  report.completed = true;
} catch (error) {
  report.failure = { message: String(error), diagnostics: error?.diagnostics };
  throw error;
} finally {
  await server.close();
  await mkdir(new URL("../test-results/", import.meta.url), { recursive: true });
  const filename = `webgpu-${operation === "sum" ? "sum-" : ""}${mode}-${report.measuredAt.replaceAll(":", "-")}.json`;
  await writeFile(new URL(`../test-results/${filename}`, import.meta.url), JSON.stringify(report, null, 2));
  process.stdout.write(`Saved test-results/${filename}\n`);
}
