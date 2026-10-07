import { mock } from "node:test";
import { browserDefinitions, BrowserRunError, selectBrowserDefinitions } from "../../scripts/browser-harness.mjs";

const [name, scenario, mode, operation] = process.argv.slice(2);
const launcher = new URL(`../../scripts/${name}`, import.meta.url);
const events = [];
const runs = [];
const page = { ok: scenario !== "application-and-cleanup", interpreterWorkerTerminated: scenario !== "worker-not-terminated",
  error: { message: "controlled page failure" }, samples: [1, 2], released: { ownedBytes: 0 } };
let saved;
let savedPath;
let expectedError;
let expectedDiagnostics;
let validationFailure;

function harnessFailure(kind, cause) {
  expectedDiagnostics = { failureKind: kind, cleanupFailure: kind === "profile-cleanup" || scenario === "application-and-cleanup" ? "controlled cleanup failure" : null,
    terminationFailure: null, standardErrorClosedEarly: true, browser: runs.at(-1).browser };
  expectedError = new BrowserRunError("Controlled browser failure", expectedDiagnostics, { cause });
  return expectedError;
}

mock.module("node:fs/promises", { namedExports: {
  async mkdir() { events.push("mkdir"); },
  async writeFile(path, text) { events.push("write"); savedPath = path.pathname; saved = JSON.parse(text); },
} });
mock.module(new URL("./source-identity.mjs", launcher).href, { namedExports: {
  async fingerprintTypeScriptSources() { events.push("fingerprint"); return "controlled-source"; },
} });
mock.module(new URL("./browser-harness.mjs", launcher).href, { namedExports: {
  browserDefinitions,
  selectBrowserDefinitions(choice, definitions) {
    events.push("select");
    try { return selectBrowserDefinitions(choice, definitions); }
    catch (error) { expectedError = error; throw error; }
  },
  async resolveBrowser(browser) {
    events.push("resolve");
    if (scenario === "resolution-failure") {
      expectedError = new Error("Controlled browser resolution failure");
      throw expectedError;
    }
    return browser.name;
  },
  browserVersion(executable) { events.push("version"); return `${executable} controlled-version`; },
  async startBrowserServer() {
    events.push("server");
    return { async close() { events.push("close"); } };
  },
  async runBrowserPage({ browser, version, page: pathname, parameters, applicationTimeoutMilliseconds, validateResult }) {
    events.push("run");
    runs.push({ browser: browser.name, version, page: pathname, parameters, applicationTimeoutMilliseconds });
    if (scenario === "before-page") throw harnessFailure("navigation-timeout");
    events.push("validate");
    try { await validateResult(page); }
    catch (error) { validationFailure = error.message; throw harnessFailure("application-result", error); }
    if (scenario === "cleanup" || (scenario === "multiple-browsers" && runs.length === 2)) {
      throw harnessFailure("profile-cleanup");
    }
    return page;
  },
} });

process.env.TABGRAD_BROWSER = scenario === "multiple-browsers" ? ""
  : scenario === "selection-failure" ? "unsupported-controlled-browser" : "Firefox";
process.argv = [process.execPath, launcher.pathname, mode, operation];
const originalWrite = process.stdout.write;
const output = [];
process.stdout.write = (chunk) => { output.push(String(chunk)); return true; };
let rejected = false;
let sameError = false;
try { await import(launcher.href); }
catch (error) { rejected = true; sameError = error === expectedError; }
finally { process.stdout.write = originalWrite; }
console.log(JSON.stringify({ rejected, sameError, saved, savedPath, events, runs, page,
  expectedMessage: expectedError === undefined ? undefined : String(expectedError), expectedDiagnostics, validationFailure, output }));
