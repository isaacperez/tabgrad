import { mkdir, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { browserDefinitions, browserVersion, resolveBrowser, runBrowserPage, selectBrowserDefinitions, startBrowserServer } from "./browser-harness.mjs";
import { fingerprintTypeScriptSources } from "./source-identity.mjs";

const mode = process.argv[2];
if (!["pilot", "measure", "diagnose"].includes(mode)) throw new Error("Use: node scripts/measure-python-webgpu.mjs pilot|measure|diagnose");
const sourceSha256 = await fingerprintTypeScriptSources(new URL("../src/", import.meta.url));
const report = { mode, measuredAt: new Date().toISOString(), sourceSha256,
  platform: platform(), operatingSystemRelease: release(), architecture: arch(), node: process.version, browsers: [] };
const server = await startBrowserServer(["measurements/python-webgpu/python-webgpu-measure.html"], { crossOriginIsolation: true,
  assets: ["measurements/python-webgpu/python-webgpu-measure-host.mjs", "measurements/python-webgpu/python-webgpu-measure-worker.mjs", "measurements/python-webgpu/python-webgpu-measure-controller.mjs", "measurements/python-webgpu/python-webgpu-measure-physical.mjs", "helpers/execution-probe.mjs"] });
try {
  for (const browser of selectBrowserDefinitions(process.env.TABGRAD_BROWSER ?? "Chrome", browserDefinitions)) {
    const executable = await resolveBrowser(browser);
    const version = browserVersion(executable);
    await runBrowserPage({ server, browser, executable, version, page: "measurements/python-webgpu/python-webgpu-measure.html",
      parameters: { mode }, applicationTimeoutMilliseconds: 65000,
      validateResult(result) {
        report.browsers.push({ browser: browser.name, version, result });
        if (!result.ok) throw new Error(JSON.stringify(result.error));
        if (!result.interpreterWorkerTerminated) throw new Error("Result preceded interpreter-worker termination.");
      } });
  }
} finally {
  await server.close();
  await mkdir(new URL("../test-results/", import.meta.url), { recursive: true });
  const filename = `python-webgpu-${mode}-${report.measuredAt.replaceAll(":", "-")}.json`;
  await writeFile(new URL(`../test-results/${filename}`, import.meta.url), JSON.stringify(report, null, 2));
  process.stdout.write(`Saved test-results/${filename}\n`);
}
