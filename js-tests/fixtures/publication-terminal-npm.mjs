/** Actual pinned npm challenge handler, with no registry or account access. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const [client, output] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const { otplease } = require(join(client, "npm/lib/utils/auth.js"));
const Display = require(join(client, "npm/lib/utils/display.js"));
const display = new Display({ stdout: process.stdout, stderr: process.stderr });
await display.load({ loglevel: "silent", stdoutColor: false, stderrColor: false,
  timing: false, unicode: false, progress: false, json: false, heading: "npm" });
const terminal = { stdin: Boolean(process.stdin.isTTY), stdout: Boolean(process.stdout.isTTY), stderr: Boolean(process.stderr.isTTY) };
let calls = 0;
try {
  await otplease({}, {}, async options => {
    calls++;
    if (calls === 1) throw Object.assign(new Error("controlled challenge; no request sent"), { code: "EOTP" });
    assert.equal(options.otp, "123456");
  });
  await writeFile(output, JSON.stringify({ terminal, calls, status: "passed", registryRequests: 0 }), { mode: 0o600 });
} catch (error) {
  await writeFile(output, JSON.stringify({ terminal, calls, status: "failed", code: error.code, registryRequests: 0 }), { mode: 0o600 });
  process.exitCode = 1;
} finally { display.off(); }
