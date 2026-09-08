import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BrowserRunError,
  removeBrowserProfile,
  runBrowserPage,
  selectBrowserDefinitions,
  startBrowserServer,
} from "../../scripts/browser-harness.mjs";

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
  const server = await startBrowserServer(["runtime.html"]);
  try {
    return await runBrowserPage({
      applicationTimeoutMilliseconds: 500,
      browser: fixtureBrowser(script, onArguments),
      executable: process.execPath,
      navigationTimeoutMilliseconds: 500,
      page: "runtime.html",
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
    assert.equal(error.diagnostics.page, "runtime.html");
    assert(Number.isInteger(error.diagnostics.elapsedMilliseconds));
    inspect?.(error);
    return true;
  };
}

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

test("navigation timeout reports that the test page was never requested", async () => {
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
          { method: "GET", path: "/runtime.html", status: 200 },
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
        [{ method: "GET", path: "/runtime.html" }],
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
      assert.match(error.message, /navigation to runtime\.html timed out/);
    }),
  );
});
