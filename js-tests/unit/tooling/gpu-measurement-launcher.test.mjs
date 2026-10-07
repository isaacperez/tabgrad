import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("../../fixtures/gpu-measurement-launcher.mjs", import.meta.url));

function runLauncher(name, scenario, mode, operation) {
  const child = spawnSync(process.execPath, ["--experimental-test-module-mocks", fixture, name, scenario, mode, operation],
    { encoding: "utf8", timeout: 5_000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

for (const name of ["measure-webgpu.mjs", "measure-python-webgpu.mjs"]) {
  for (const scenario of ["success", "cleanup", "before-page", "application-and-cleanup", "resolution-failure", "selection-failure", "multiple-browsers"]) {
    test(`${name} preserves attempt outcome: ${scenario}`, () => {
      const mode = name.includes("python") && scenario === "before-page" ? "diagnose"
        : scenario === "success" ? "measure" : "pilot";
      const operation = scenario === "success" ? "sum" : "add";
      const observed = runLauncher(name, scenario, mode, operation);
      const report = observed.saved;
      assert.equal(report.mode, mode);
      assert.equal(report.operation, operation);
      assert.equal(report.sourceSha256, "controlled-source");
      assert.equal(report.completed, scenario === "success");
      assert.equal(observed.rejected, scenario !== "success");
      assert.deepEqual(observed.events.slice(-3), ["close", "mkdir", "write"]);
      assert.equal(observed.events.filter(event => event === "close").length, 1);
      assert.equal(observed.events.filter(event => event === "write").length, 1);
      assert.equal(observed.output.length, 1);
      assert.match(observed.output[0], /^Saved test-results\//);
      assert.match(observed.savedPath, new RegExp(`${operation === "sum" ? "sum-" : ""}${mode}-.*\\.json$`));

      if (scenario === "success") assert.equal(report.failure, undefined);
      else {
        assert.equal(observed.sameError, true);
        assert.equal(report.failure.message, observed.expectedMessage);
        assert.deepEqual(report.failure.diagnostics, observed.expectedDiagnostics);
      }
      if (scenario === "selection-failure") {
        assert.deepEqual(report.browsers, []);
        assert.deepEqual(observed.runs, []);
        return;
      }
      assert.equal(report.browsers.length, scenario === "multiple-browsers" ? 2 : 1);
      const attempt = report.browsers.at(-1);
      assert.equal(attempt.browser, "Firefox");
      assert.equal(attempt.completed, scenario === "success");
      if (scenario === "resolution-failure") {
        assert.equal(attempt.version, undefined);
        assert.equal(attempt.result, undefined);
        assert.deepEqual(observed.runs, []);
        return;
      }
      assert.equal(attempt.version, "Firefox controlled-version");
      assert.equal(observed.runs.length, scenario === "multiple-browsers" ? 2 : 1);
      const run = observed.runs.at(-1);
      assert.equal(run.applicationTimeoutMilliseconds, 65_000);
      assert.deepEqual(run.parameters, name.includes("python") ? { mode, operation } : { mode });
      assert.match(run.page, name.includes("python") ? /^measurements\/python-webgpu\// : /^measurements\/webgpu\//);
      if (scenario === "before-page") assert.equal(attempt.result, undefined);
      else assert.deepEqual(attempt.result, observed.page);
      if (scenario === "application-and-cleanup") {
        assert.match(observed.validationFailure, /controlled page failure/);
        assert.equal(report.failure.diagnostics.failureKind, "application-result");
        assert.equal(report.failure.diagnostics.cleanupFailure, "controlled cleanup failure");
      }
      if (scenario === "multiple-browsers") {
        assert.deepEqual(report.browsers[0], { browser: "Chrome", completed: true,
          version: "Chrome controlled-version", result: observed.page });
      }
    });
  }
}

test("managed GPU launcher retains interpreter-worker termination validation", () => {
  const observed = runLauncher("measure-python-webgpu.mjs", "worker-not-terminated", "pilot", "add");
  assert.equal(observed.rejected, true);
  assert.equal(observed.sameError, true);
  assert.match(observed.validationFailure, /Result preceded interpreter-worker termination/);
  assert.equal(observed.saved.completed, false);
  assert.equal(observed.saved.browsers[0].completed, false);
  assert.deepEqual(observed.saved.browsers[0].result, observed.page);
  assert.equal(observed.saved.failure.diagnostics.failureKind, "application-result");
});
