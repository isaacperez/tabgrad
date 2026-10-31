/** Actual pinned npm challenge handler, with no registry or account access. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const web = process.argv[2] === "publish";
const [client, output] = web ? [process.env.TABGRAD_TEST_CLIENT, process.env.TABGRAD_TEST_REPORT] : process.argv.slice(2);
const require = createRequire(import.meta.url);
const { otplease } = require(join(client, "npm/lib/utils/auth.js"));
const Display = require(join(client, "npm/lib/utils/display.js"));
const nopt = require(join(client, "npm/node_modules/nopt"));
const definitions = require(join(client, "npm/node_modules/@npmcli/config/lib/definitions/definitions.js"));
const parsed = web ? nopt({ json: definitions.json.type, browser: definitions.browser.type }, {}, process.argv, 2) : {};
const config = { json: parsed.json ?? definitions.json.default, browser: parsed.browser ?? definitions.browser.default };
const display = new Display({ stdout: process.stdout, stderr: process.stderr });
await display.load({ loglevel: "silent", stdoutColor: false, stderrColor: false,
  timing: false, unicode: false, progress: false, json: config.json, heading: "npm" });
const terminal = { stdin: Boolean(process.stdin.isTTY), stdout: Boolean(process.stdout.isTTY), stderr: Boolean(process.stderr.isTTY) };

async function webChallenge() {
  const { createOpener } = require(join(client, "npm/lib/utils/open-url.js"));
  const report = { terminal, ...config, standardLinks: 0, bufferedLinks: 0, inputRequests: 0, registryRequests: 0 };
  const observeOutput = level => {
    if (level === "standard") report.standardLinks++;
    if (level === "buffer") report.bufferedLinks++;
  };
  const observeInput = () => { report.inputRequests++; };
  process.on("output", observeOutput); process.on("input", observeInput);
  const controller = new AbortController();
  try {
    const pending = createOpener({ config: { get: name => config[name] } }, "Controlled web challenge; no account")(
      "https://www.npmjs.com/auth/cli/fixture-no-account", { signal: controller.signal });
    // Abort a regressed Enter prompt immediately; never open a browser or request a URL.
    controller.abort(); await pending;
    await writeFile(output, JSON.stringify(report), { mode: 0o600 });
  } finally { process.off("output", observeOutput); process.off("input", observeInput); }
}

let calls = 0;
try {
  if (web) await webChallenge();
  else {
    await otplease({}, {}, async options => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("controlled challenge; no request sent"), { code: "EOTP" });
      assert.equal(options.otp, "123456");
    });
    await writeFile(output, JSON.stringify({ terminal, calls, status: "passed", registryRequests: 0 }), { mode: 0o600 });
  }
} catch (error) {
  await writeFile(output, JSON.stringify({ terminal, calls, status: "failed", code: error.code, registryRequests: 0 }), { mode: 0o600 });
  process.exitCode = 1;
} finally { display.off(); }
