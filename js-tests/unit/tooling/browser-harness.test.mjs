import assert from "node:assert/strict";
import { test } from "node:test";
import { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  BrowserRunError,
  removeBrowserProfile,
  runBrowserPage,
  selectBrowserDefinitions,
  startBrowserServer,
  terminateBrowser,
} from "../../../scripts/browser-harness.mjs";

const fixturePrelude = `
const pageUrl = new URL(process.argv[1]);
const token = pageUrl.searchParams.get("token");
async function post(path, body) {
  const url = new URL(path, pageUrl);
  url.searchParams.set("token", token);
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
`;

test("an isolated distribution can be measured without replacing the working distribution", async () => {
  const directory = fileURLToPath(new URL("../../fixtures", import.meta.url));
  const original = await readFile(new URL("../../../dist/manifest.json", import.meta.url), "utf8");
  const server = await startBrowserServer([], { distributionDirectory: directory });
  try {
    const response = await fetch(`${server.origin}/python-tensor-oracle.json`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), await readFile(`${directory}/python-tensor-oracle.json`, "utf8"));
    assert.equal((await fetch(`${server.origin}/manifest.json`)).status, 404);
  } finally { await server.close(); }
  assert.equal(await readFile(new URL("../../../dist/manifest.json", import.meta.url), "utf8"), original);
});


function fixtureBrowser(script, onArguments = undefined) {
  return {
    name: "FixtureBrowser",
    argumentsFor(profile, url) {
      onArguments?.(profile, url);
      return ["--input-type=module", "--eval", `${fixturePrelude}\n${script}`, url];
    },
  };
}

async function runFixtureBrowser(script, options = {}) {
  const { onArguments, ...runOptions } = options;
  const server = await startBrowserServer(["runtime/runtime.html"]);
  try {
    return await runBrowserPage({
      applicationTimeoutMilliseconds: 500,
      browser: fixtureBrowser(script, onArguments),
      executable: process.execPath,
      navigationTimeoutMilliseconds: 500,
      page: "runtime/runtime.html",
      server,
      version: process.version,
      ...runOptions,
    });
  } finally {
    await server.close();
  }
}

function expectBrowserFailure(expectedKind, inspect = undefined) {
  return (error) => {
    assert(error instanceof BrowserRunError);
    assert.equal(error.diagnostics.failureKind, expectedKind);
    assert.equal(error.diagnostics.browser, "FixtureBrowser");
    assert.equal(error.diagnostics.browserVersion, process.version);
    assert.equal(error.diagnostics.page, "runtime/runtime.html");
    assert(Number.isInteger(error.diagnostics.elapsedMilliseconds));
    inspect?.(error);
    return true;
  };
}

async function runInheritedStderrFixture(scenario) {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("../../fixtures/inherited-browser-stderr.mjs", import.meta.url)),
    "harness", scenario,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errorOutput = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { errorOutput += chunk; });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0, errorOutput);
    const record = output.split("\n").find((line) => line.startsWith("OUTCOME "));
    assert.notEqual(record, undefined, output);
    return { output, outcome: JSON.parse(record.slice("OUTCOME ".length)) };
  } finally { clearTimeout(deadline); }
}

class FixtureBrowserProcess extends EventEmitter {
  pid = 1;
  exitCode = null;
  signalCode = null;
  signals = [];
  constructor(exitOnSignal) { super(); this.exitOnSignal = exitOnSignal; }
  kill(signal) {
    this.signals.push(signal);
    if (signal === this.exitOnSignal) {
      queueMicrotask(() => {
        this.signalCode = signal;
        this.emit("exit", null, signal);
      });
    }
    return true;
  }
}

test("browser termination joins ordinary exit and leaves no exit listener", async () => {
  const child = new FixtureBrowserProcess("SIGTERM");
  await terminateBrowser(child);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(child.signalCode, "SIGTERM");
  assert.equal(child.listenerCount("exit"), 0);
});

test("already exited and failed-to-spawn processes require no signal", async () => {
  const exited = new FixtureBrowserProcess("SIGTERM");
  exited.exitCode = 0;
  await terminateBrowser(exited);
  const unspawned = new FixtureBrowserProcess("SIGTERM");
  unspawned.pid = undefined;
  await terminateBrowser(unspawned);
  assert.deepEqual(exited.signals, []);
  assert.deepEqual(unspawned.signals, []);
});

test("termination escalates after an unjoined SIGTERM and joins actual SIGKILL exit", async () => {
  const child = new FixtureBrowserProcess("SIGKILL");
  const termination = terminateBrowser(child);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  await termination;
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.signalCode, "SIGKILL");
  assert.equal(child.listenerCount("exit"), 0);
});

test("sending SIGKILL is not evidence of process exit", async () => {
  const child = new FixtureBrowserProcess(undefined);
  await assert.rejects(terminateBrowser(child), /process exit after SIGKILL timed out/);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  assert.equal(child.listenerCount("exit"), 0);
});

test("inherited stderr does not prevent successful harness completion or retain its runner", async () => {
  const { output, outcome } = await runInheritedStderrFixture("success");
  assert.deepEqual(outcome.result, { ok: true });
  assert.match(output, /stderr capture ended without EOF/);
  assert.equal(outcome.writerStillAlive, true);
  assert.equal(outcome.writerJoined, true);
  assert.equal(outcome.profileRemoved, true);
});

test("inherited stderr preserves the primary application failure and explicit capture cutoff", async () => {
  const { outcome } = await runInheritedStderrFixture("failure");
  assert.equal(outcome.failureKind, "application-result");
  assert.equal(outcome.diagnostics.terminationFailure, null);
  assert.equal(outcome.diagnostics.standardErrorClosedEarly, true);
  assert.equal(outcome.diagnostics.standardErrorTruncated, false);
  assert.match(outcome.diagnostics.standardError, /inherited stderr fixture/);
  assert.equal(outcome.writerStillAlive, true);
  assert.equal(outcome.writerJoined, true);
  assert.equal(outcome.profileRemoved, true);
});

test("a failed stderr read remains a diagnostic failure rather than a successful process join", async (context) => {
  const emit = ChildProcess.prototype.emit;
  context.mock.method(ChildProcess.prototype, "emit", function (event, ...arguments_) {
    const result = emit.call(this, event, ...arguments_);
    if (event === "spawn") this.stderr.destroy(new Error("controlled stderr failure"));
    return result;
  });
  await assert.rejects(
    runFixtureBrowser("setInterval(() => {}, 1_000);"),
    expectBrowserFailure("browser-diagnostics", (error) => {
      assert.equal(error.diagnostics.terminationFailure, null);
      assert.equal(error.diagnostics.cleanupFailure, null);
      assert.equal(error.diagnostics.standardErrorClosedEarly, true);
      assert.match(error.cause.cause.message, /controlled stderr failure/);
    }),
  );
});

test("a late stderr failure cannot replace a result-validation failure", async (context) => {
  let browserProcess;
  const emit = ChildProcess.prototype.emit;
  context.mock.method(ChildProcess.prototype, "emit", function (event, ...arguments_) {
    if (event === "spawn") browserProcess = this;
    return emit.call(this, event, ...arguments_);
  });
  await assert.rejects(
    runFixtureBrowser('await fetch(pageUrl); await post("/__result", { ok: true });', {
      validateResult() {
        browserProcess.stderr.destroy(new Error("late stderr failure"));
        throw new Error("primary validation failure");
      },
    }),
    expectBrowserFailure("application-result", (error) => {
      assert.equal(error.diagnostics.terminationFailure, null);
      assert(error.cause instanceof AggregateError);
      assert.match(error.cause.errors[0].message, /primary validation failure/);
      assert.match(error.cause.errors[1].message, /late stderr failure/);
    }),
  );
});

test("browser profile cleanup retries transient directory races", async () => {
  let observedPath;
  let observedOptions;

  await removeBrowserProfile("/temporary/browser-profile", async (path, options) => {
    observedPath = path;
    observedOptions = options;
  });

  assert.equal(observedPath, "/temporary/browser-profile");
  assert.deepEqual(observedOptions, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 100,
  });
});

test("browser selection keeps full local coverage and rejects unknown names", () => {
  const definitions = [{ name: "Chrome" }, { name: "Firefox" }];

  assert.strictEqual(selectBrowserDefinitions(undefined, definitions), definitions);
  assert.deepEqual(selectBrowserDefinitions("firefox", definitions), [definitions[1]]);
  assert.throws(
    () => selectBrowserDefinitions("Safari", definitions),
    /Unsupported TABGRAD_BROWSER value "Safari"\. Choose one of: Chrome, Firefox\./,
  );
});

test("browser lifecycle phases reach a validated result", async () => {
  const result = await runFixtureBrowser(`
await fetch(pageUrl);
await post("/__phase", { phase: "application-started" });
await post("/__phase", { phase: "assets-loaded" });
await post("/__phase", { phase: "runtime-started" });
await post("/__phase", { phase: "runtime-finished" });
await post("/__result", { ok: true, values: [5, 7, 9] });
`, {
    validateResult(value) {
      assert.equal(value.ok, true);
      assert.deepEqual(value.values, [5, 7, 9]);
    },
  });

  assert.deepEqual(result, { ok: true, values: [5, 7, 9] });
});

test("navigation timeout reports no associated page admission", async () => {
  let browserStarts = 0;
  await assert.rejects(
    runFixtureBrowser("setInterval(() => {}, 1_000);", {
      navigationTimeoutMilliseconds: 100,
      onArguments() {
        browserStarts += 1;
      },
    }),
    expectBrowserFailure("navigation-timeout", (error) => {
      assert.equal(error.diagnostics.lastPhase, "browser-launched");
      assert.deepEqual(error.diagnostics.requests, []);
      assert.equal(error.diagnostics.cleanupFailure, null);
    }),
  );
  assert.equal(browserStarts, 1);
});

test("timeout snapshots distinguish failure-time state from final owned cleanup", async () => {
  await assert.rejects(
    runFixtureBrowser("setInterval(() => {}, 1_000);", { navigationTimeoutMilliseconds: 100 }),
    expectBrowserFailure("navigation-timeout", (error) => {
      const snapshot = error.diagnostics.timeoutSnapshot;
      assert.notEqual(snapshot, undefined, "Missing pre-cleanup timeout snapshot");
      assert.equal(snapshot.lastPhase, "browser-launched");
      assert.equal(snapshot.process.spawnObserved, true);
      assert.equal(snapshot.process.exitCode, null);
      assert.equal(snapshot.process.signal, null);
      assert.equal(snapshot.profile.state, "directory-present");
      assert.deepEqual(snapshot.incomingRequests, []);
      assert.equal(snapshot.incomingRequestsTruncated, false);
      assert.equal(error.diagnostics.process.signal, "SIGTERM");
      assert.equal(error.diagnostics.cleanupFailure, null);
      assert.equal(JSON.stringify(snapshot).includes("tabgrad-browser-profile-"), false);
    }),
  );
});

test("unassociated incoming controls are visible without advancing the run", async () => {
  const server = await startBrowserServer(["runtime/runtime.html"]);
  const registration = server.register("active-fixture-token", "runtime/runtime.html");
  registration.navigation.catch(() => {});
  registration.result.catch(() => {});
  try {
    for (const suffix of ["", "?token=unknown-fixture-token&private=fixture-secret"]) {
      const response = await fetch(`${server.origin}/__result${suffix}`, {
        method: "POST", body: JSON.stringify({ ok: true, private: "fixture-body" }),
      });
      assert.equal(response.status, 404);
    }
    const snapshot = registration.snapshot();
    assert.ok(Array.isArray(snapshot.incomingRequests), "Missing pre-association ingress records");
    assert.deepEqual(snapshot.incomingRequests.map(({ resource, association, responseStatus }) =>
      ({ resource, association, responseStatus })), [
      { resource: "/__result", association: "missing-control-token", responseStatus: 404 },
      { resource: "/__result", association: "unmatched-token", responseStatus: 404 },
    ]);
    assert.equal(snapshot.lastPhase, "browser-process-requested");
    assert.deepEqual(snapshot.requests, []);
    const serialized = JSON.stringify(snapshot.incomingRequests);
    for (const omitted of ["active-fixture-token", "unknown-fixture-token", "fixture-secret", "fixture-body"]) {
      assert.equal(serialized.includes(omitted), false);
    }
  } finally {
    registration.cancel();
    await server.close();
  }
});

test("browser launch failure is distinct from navigation timeout", async () => {
  await assert.rejects(
    runFixtureBrowser("", {
      executable: "/path/that/cannot/contain/a/browser",
    }),
    expectBrowserFailure("browser-process", (error) => {
      assert.equal(error.diagnostics.lastPhase, "browser-process-requested");
      assert.match(error.diagnostics.process.error, /ENOENT/);
      assert.deepEqual(error.diagnostics.requests, []);
    }),
  );
});

test("application timeout preserves page, asset, and phase progress", async () => {
  await assert.rejects(
    runFixtureBrowser(`
await fetch(pageUrl);
await post("/__phase", { phase: "application-started" });
await fetch(new URL("/index.js", pageUrl));
setInterval(() => {}, 1_000);
`, { applicationTimeoutMilliseconds: 100 }),
    expectBrowserFailure("application-timeout", (error) => {
      assert.equal(error.diagnostics.lastPhase, "application-started");
      assert.deepEqual(
        error.diagnostics.requests.map(({ method, path, status }) => ({ method, path, status })),
        [
          { method: "GET", path: "/runtime/runtime.html", status: 200 },
          { method: "POST", path: "/__phase", status: 204 },
          { method: "GET", path: "/index.js", status: 200 },
        ],
      );
      assert(error.diagnostics.requests.every((request) => !request.path.includes("?")));
    }),
  );
});

test("missing required asset fails immediately with the requested path", async () => {
  await assert.rejects(
    runFixtureBrowser(`
await fetch(pageUrl);
await post("/__phase", { phase: "application-started" });
await fetch(new URL("/missing.js", pageUrl));
setInterval(() => {}, 1_000);
`),
    expectBrowserFailure("asset-loading", (error) => {
      assert.match(error.message, /Required browser asset \/missing\.js returned 404\./);
      assert.equal(error.diagnostics.lastPhase, "application-started");
      assert.deepEqual(
        error.diagnostics.requests.at(-1),
        {
          elapsedMilliseconds: error.diagnostics.requests.at(-1).elapsedMilliseconds,
          method: "GET",
          path: "/missing.js",
          status: 404,
        },
      );
    }),
  );
});

test("an explicit stale token cannot report a result for the active run", async () => {
  await assert.rejects(
    runFixtureBrowser(`
await fetch(pageUrl);
const staleResultUrl = new URL("/__result", pageUrl);
staleResultUrl.searchParams.set("token", "stale-run");
const response = await fetch(staleResultUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ok: true }),
});
if (response.status !== 404) {
  throw new Error(\`Expected stale result rejection, received ${"${response.status}"}.\`);
}
setInterval(() => {}, 1_000);
`, { applicationTimeoutMilliseconds: 100 }),
    expectBrowserFailure("application-timeout", (error) => {
      assert.equal(error.diagnostics.lastPhase, "page-requested");
      assert.deepEqual(
        error.diagnostics.requests.map(({ method, path }) => ({ method, path })),
        [{ method: "GET", path: "/runtime/runtime.html" }],
      );
    }),
  );
});

test("tokenless control messages cannot affect the active run", async () => {
  await assert.rejects(
    runFixtureBrowser(`
await fetch(pageUrl);
for (const [path, body] of [
  ["/__phase", { phase: "application-started" }],
  ["/__result", { ok: true }],
]) {
  const response = await fetch(new URL(path, pageUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status !== 404) {
    throw new Error(\`Expected tokenless ${"${path}"} rejection, received ${"${response.status}"}.\`);
  }
}
setInterval(() => {}, 1_000);
`, { applicationTimeoutMilliseconds: 100 }),
    expectBrowserFailure("application-timeout", (error) => {
      assert.equal(error.diagnostics.lastPhase, "page-requested");
      assert.deepEqual(
        error.diagnostics.requests.map(({ method, path }) => ({ method, path })),
        [{ method: "GET", path: "/runtime/runtime.html" }],
      );
    }),
  );
});

test("reported application failure is validated and never retried", async () => {
  let browserStarts = 0;
  await assert.rejects(
    runFixtureBrowser(`
await fetch(pageUrl);
await post("/__phase", { phase: "application-started" });
await post("/__result", { ok: false, error: { message: "fixture failure" } });
`, {
      onArguments() {
        browserStarts += 1;
      },
      validateResult(result) {
        assert.equal(result.ok, true, result.error.message);
      },
    }),
    expectBrowserFailure("application-result", (error) => {
      assert.match(error.message, /fixture failure/);
      assert.equal(error.diagnostics.lastPhase, "result-received");
    }),
  );
  assert.equal(browserStarts, 1);
});

test("premature exit records code and bounded standard error", async () => {
  await assert.rejects(
    runFixtureBrowser(`
await new Promise((resolve) => process.stderr.write("x".repeat(20_000), resolve));
process.exit(9);
`),
    expectBrowserFailure("browser-process", (error) => {
      assert.equal(error.diagnostics.process.exitCode, 9);
      assert.equal(error.diagnostics.process.signal, null);
      assert.equal(error.diagnostics.standardError.length, 16_384);
      assert.equal(error.diagnostics.standardErrorTruncated, true);
      assert.equal(error.diagnostics.standardErrorClosedEarly, false);
    }),
  );
});

test("browser standard error cannot expose run query data", async () => {
  await assert.rejects(
    runFixtureBrowser(`
await new Promise((resolve) => process.stderr.write(pageUrl.href, resolve));
process.exit(8);
`),
    expectBrowserFailure("browser-process", (error) => {
      assert.match(error.diagnostics.standardError, /\?\[redacted-query\]$/);
      assert.doesNotMatch(error.diagnostics.standardError, /token=/);
      assert.doesNotMatch(error.message, /token=/);
    }),
  );
});

test("an incomplete logged run URL cannot expose query data", async () => {
  await assert.rejects(
    runFixtureBrowser(`
await new Promise((resolve) => process.stderr.write(pageUrl.href.slice(0, -10), resolve));
process.exit(8);
`),
    expectBrowserFailure("browser-process", (error) => {
      assert.match(error.diagnostics.standardError, /\?\[redacted-query\]$/);
      assert.doesNotMatch(error.diagnostics.standardError, /token=/);
    }),
  );
});

test("size-limited capture redacts a partial bare run token", async () => {
  let token;
  await assert.rejects(
    runFixtureBrowser(`
await new Promise((resolve) => process.stderr.write("x".repeat(16_370) + token, resolve));
process.exit(8);
`, { onArguments(_profile, url) { token = new URL(url).searchParams.get("token"); } }),
    expectBrowserFailure("browser-process", (error) => {
      assert.equal(error.diagnostics.standardErrorTruncated, true);
      assert.equal(error.diagnostics.standardError.includes(token.slice(0, 14)), false);
      assert.match(error.diagnostics.standardError, /\[redacted-token-prefix\]$/);
    }),
  );
});

test("request diagnostics stay bounded and report truncation", async () => {
  await assert.rejects(
    runFixtureBrowser(`
await fetch(pageUrl);
await Promise.all(Array.from(
  { length: 70 },
  (_, index) => fetch(new URL(\`/optional-${"${index}"}.txt\`, pageUrl)),
));
await post("/__result", { ok: true });
`, {
      validateResult() {
        throw new Error("collect bounded diagnostics");
      },
    }),
    expectBrowserFailure("application-result", (error) => {
      assert.equal(error.diagnostics.requests.length, 64);
      assert.equal(error.diagnostics.requestsTruncated, true);
    }),
  );
});

test("cleanup failure does not replace the primary browser failure", async () => {
  await assert.rejects(
    runFixtureBrowser("setInterval(() => {}, 1_000);", {
      navigationTimeoutMilliseconds: 100,
      async removeProfile(profile) {
        await removeBrowserProfile(profile);
        throw new Error("fixture cleanup failure");
      },
    }),
    expectBrowserFailure("navigation-timeout", (error) => {
      assert.equal(error.diagnostics.cleanupFailure, "fixture cleanup failure");
      assert(error.cause instanceof AggregateError);
      assert.match(error.message, /navigation to runtime\/runtime\.html timed out/);
    }),
  );
});
