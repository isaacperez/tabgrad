import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  BrowserIngressDiagnostics,
  captureBrowserTimeoutSnapshot,
} from "../../../scripts/browser-run-diagnostics.mjs";
import { startBrowserServer } from "../../../scripts/browser-harness.mjs";

function gate() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function register(server, token) {
  const registration = server.register(token, "runtime/runtime.html");
  registration.navigation.catch(() => {});
  registration.result.catch(() => {});
  return registration;
}

async function waitForStage(registration, stage) {
  const deadline = performance.now() + 1_000;
  while (performance.now() < deadline) {
    if (registration.snapshot().incomingRequests.some(record => record.stage === stage)) return;
    await delay(5);
  }
  assert.fail(`Controlled request did not reach ${stage}`);
}

test("file ingress precedes admission and late completion cannot mutate the next interval", async () => {
  const entered = gate();
  const release = gate();
  const server = await startBrowserServer(["runtime/runtime.html"], {
    async readAsset(path) {
      entered.resolve();
      await release.promise;
      return readFile(path);
    },
  });
  const first = register(server, "first-fixture-token");
  let fetchResult;
  let second;
  try {
    fetchResult = fetch(`${server.origin}/runtime/runtime.html?token=first-fixture-token&private=fixture-query`);
    await entered.promise;
    const heldSnapshot = first.snapshot();
    assert.deepEqual(heldSnapshot.requests, []);
    assert.equal(heldSnapshot.lastPhase, "browser-process-requested");
    assert.equal(heldSnapshot.incomingRequests[0].association, "matching-token");
    assert.equal(heldSnapshot.incomingRequests[0].stage, "reading-file");
    assert.equal(heldSnapshot.incomingRequests[0].responseFinished, false);
    first.cancel();
    second = register(server, "second-fixture-token");
    release.resolve();
    assert.equal((await fetchResult).status, 200);
    assert.deepEqual(second.snapshot().incomingRequests, []);
    assert.equal(first.snapshot().incomingRequests[0].stage, "reading-file");
    assert.equal(heldSnapshot.incomingRequests[0].responseFinished, false);
    const stale = await fetch(`${server.origin}/__result?token=first-fixture-token`, {
      method: "POST", body: JSON.stringify({ ok: true }),
    });
    assert.equal(stale.status, 404);
    assert.equal(second.snapshot().incomingRequests[0].association, "unmatched-token");
    assert.equal(second.snapshot().lastPhase, "browser-process-requested");
    assert.deepEqual(second.snapshot().requests, []);
  } finally {
    release.resolve();
    await fetchResult?.catch(() => {});
    first.cancel();
    second?.cancel();
    await server.close();
  }
});

test("a partial control body is observed before its contents are available", async () => {
  const server = await startBrowserServer(["runtime/runtime.html"]);
  const registration = register(server, "body-fixture-token");
  const body = JSON.stringify({ phase: "application-started", private: "fixture-body-secret" });
  const client = request(`${server.origin}/__phase?token=body-fixture-token`, {
    method: "POST", headers: { "content-length": Buffer.byteLength(body) },
  });
  // Observe errors before cleanup can destroy this deliberately partial request.
  client.on("error", () => {});
  const response = once(client, "response");
  try {
    client.write(body.slice(0, 5));
    await waitForStage(registration, "reading-body");
    const held = registration.snapshot();
    assert.deepEqual(held.requests, []);
    assert.equal(held.lastPhase, "browser-process-requested");
    assert.equal(held.incomingRequests[0].association, "matching-token");
    client.end(body.slice(5));
    const [result] = await response;
    result.resume();
    assert.equal(result.statusCode, 204);
    assert.equal(registration.snapshot().lastPhase, "application-started");
    assert.equal(held.incomingRequests[0].stage, "reading-body");
    assert.equal(JSON.stringify(registration.snapshot().incomingRequests).includes("fixture-body-secret"), false);
  } finally {
    client.destroy();
    await response.catch(() => {});
    registration.cancel();
    await server.close();
  }
});

test("ingress is capped per interval and unknown paths remain categorical", async () => {
  const server = await startBrowserServer(["runtime/runtime.html"]);
  const first = register(server, "capacity-fixture-token");
  let second;
  try {
    for (let index = 0; index < 67; index += 1) {
      const response = await fetch(`${server.origin}/fixture-secret-${index}.txt?private=fixture-secret`);
      assert.equal(response.status, 404);
    }
    const snapshot = first.snapshot();
    assert.equal(snapshot.incomingRequests.length, 64);
    assert.equal(snapshot.incomingRequestsTruncated, true);
    assert(snapshot.incomingRequests.every(record => record.resource === "[unregistered]"));
    assert.equal(JSON.stringify(snapshot.incomingRequests).includes("fixture-secret"), false);
    first.cancel();
    second = register(server, "new-capacity-fixture-token");
    const response = await fetch(`${server.origin}/runtime/runtime.html`);
    assert.equal(response.status, 200);
    await second.navigation;
    const next = second.snapshot();
    assert.equal(next.incomingRequests.length, 1);
    assert.equal(next.incomingRequestsTruncated, false);
    assert.equal(next.incomingRequests[0].association, "active-fallback");
    assert.equal(next.incomingRequests[0].stage, "file-served");
    assert.equal(next.incomingRequests[0].responseFinished, true);
    assert.equal(next.incomingRequests[0].responseStatus, 200);
  } finally {
    first.cancel();
    second?.cancel();
    await server.close();
  }
});

test("known identifier length, methods and returned snapshots are bounded independently of inputs", () => {
  const longIdentifier = `/${"x".repeat(300)}`;
  const diagnostics = new BrowserIngressDiagnostics(new Set([longIdentifier]), performance.now());
  const response = new EventEmitter();
  response.statusCode = 204;
  const observation = diagnostics.begin("PRIVATE-METHOD-TEXT", longIdentifier, response);
  diagnostics.associate(observation, "active-fallback");
  assert.equal(diagnostics.snapshot().incomingRequests[0].method, "OTHER");
  assert.equal(diagnostics.snapshot().incomingRequests[0].resource, "[registered-identifier-omitted]");
  const before = diagnostics.snapshot();
  response.emit("finish");
  assert.equal(before.incomingRequests[0].responseFinished, false);
  assert.equal(diagnostics.snapshot().incomingRequests[0].responseStatus, 204);
  diagnostics.close();
  diagnostics.progress(observation, "file-served");
  response.emit("close");
  assert.equal(diagnostics.snapshot().incomingRequests[0].stage, "received");
  assert.equal(diagnostics.snapshot().incomingRequests[0].responseClosed, false);
});

function snapshotInputs(inspectProfile, inspectionMilliseconds = 20) {
  return {
    child: { pid: 12345 },
    processState: { spawnObserved: true, error: null, exitCode: null, signal: null },
    registration: { snapshot: () => ({ elapsedMilliseconds: 17, lastPhase: "browser-launched",
      incomingRequests: [], incomingRequestsTruncated: false }) },
    profile: "/synthetic-private-owned-profile",
    inspectProfile, inspectionMilliseconds,
  };
}

test("profile failures produce safe categories instead of native messages or paths", async () => {
  for (const [code, expected] of [
    ["ENOENT", { state: "missing" }],
    ["EACCES", { state: "unavailable", reason: "permission-denied" }],
    ["EPERM", { state: "unavailable", reason: "permission-denied" }],
    ["EIO", { state: "unavailable", reason: "inspection-error" }],
  ]) {
    const inputs = snapshotInputs(() => Promise.reject(Object.assign(new Error("fixture-private-native-message"), { code })));
    const result = await captureBrowserTimeoutSnapshot(inputs);
    assert.deepEqual(result.profile, expected);
    for (const omitted of ["12345", inputs.profile, "fixture-private-native-message"]) {
      assert.equal(JSON.stringify(result).includes(omitted), false);
    }
  }
  assert.equal((await captureBrowserTimeoutSnapshot(snapshotInputs(() => ({ isDirectory: () => false })))).profile.state,
    "not-directory");
});

test("bounded profile inspection freezes child state and observes late rejection", async () => {
  const inspection = gate();
  const inputs = snapshotInputs(() => inspection.promise, 5);
  const pending = captureBrowserTimeoutSnapshot(inputs);
  inputs.processState.exitCode = 9;
  inputs.processState.signal = "SIGTERM";
  const result = await pending;
  assert.deepEqual(result.profile, { state: "unavailable", reason: "inspection-timeout" });
  assert.equal(result.process.exitCode, null);
  assert.equal(result.process.signal, null);
  inspection.reject(new Error("fixture-late-private-error"));
  await delay(0);
  assert.equal(JSON.stringify(result).includes("fixture-late-private-error"), false);
});
