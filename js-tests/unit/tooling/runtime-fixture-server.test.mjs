import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RuntimeFixtureServer } from "../../fixtures/runtime-fixture-server.mjs";

function startupFailureControl(mode) {
  const moduleUrl = new URL("../../fixtures/runtime-fixture-server.mjs", import.meta.url).href;
  // A child keeps the original unhandled server event from escaping into the
  // test runner. Neither failure control needs permission to open a socket.
  return spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { Server } from "node:http";
    import { RuntimeFixtureServer } from ${JSON.stringify(moduleUrl)};
    const baseline = new Server();
    const failure = new Error("fixture listen failed");
    Server.prototype.listen = function () {
      if (${JSON.stringify(mode)} === "sync") throw failure;
      queueMicrotask(() => this.emit("error", failure));
      return this;
    };
    const fixture = new RuntimeFixtureServer("unused");
    await assert.rejects(fixture.start(), (error) => error === failure);
    assert.deepEqual(fixture.server.listeners("error"), baseline.listeners("error"));
    assert.deepEqual(fixture.server.listeners("listening"), baseline.listeners("listening"));
    assert.equal(fixture.distributionUrl, undefined);
    await fixture.close();
    await fixture.close();
    console.log("rejected and retired");
  `], { encoding: "utf8", timeout: 5000 });
}

for (const mode of ["async", "sync"]) {
  test(`${mode} fixture startup failure rejects with its cause and retires listeners`, () => {
    const result = startupFailureControl(mode);
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "rejected and retired\n");
    assert.equal(result.stderr, "");
  });
}

test("fixture close is safe before startup and preserves unrelated close errors", async () => {
  const fixture = new RuntimeFixtureServer("unused");
  await fixture.close();
  const failure = new Error("fixture close failed");
  fixture.server = { close: (callback) => callback(failure) };
  await assert.rejects(fixture.close(), (error) => error === failure);
});

test("fixture serving, manifest, request gates and normal retirement remain usable", async () => {
  const root = await mkdtemp(join(tmpdir(), "tabgrad-fixture-server-"));
  const fixture = new RuntimeFixtureServer(root);
  const gate = Promise.withResolvers();
  try {
    await writeFile(join(root, "entry.js"), "export const fixture = true;\n");
    const url = await fixture.start();
    const baseline = new Server();
    assert.deepEqual(fixture.server.listeners("error"), baseline.listeners("error"));
    assert.deepEqual(fixture.server.listeners("listening"), baseline.listeners("listening"));
    const entry = await fetch(new URL("entry.js", url));
    assert.equal(entry.headers.get("content-type"), "text/javascript");
    assert.equal(await entry.text(), "export const fixture = true;\n");
    const manifestUrl = fixture.installFixture("startup", {}, (value) => ({ ...value, marker: "preserved" }));
    const response = await fetch(manifestUrl);
    assert.equal(response.headers.get("content-type"), "application/json");
    const manifest = await response.json();
    assert.equal(manifest.marker, "preserved");
    const module = await fetch(new URL(manifest.variants[0].path, url));
    assert.equal(module.headers.get("content-type"), "application/wasm");
    assert.equal((await module.arrayBuffer()).byteLength, manifest.variants[0].byteLength);
    const missing = await fetch(new URL("missing.js", url));
    assert.equal(missing.status, 404);
    await missing.arrayBuffer();

    const requested = Promise.withResolvers();
    fixture.virtualResponses.set("/gated", {
      body: Buffer.from("released"), contentType: "text/plain",
      waitFor: { then(resolve) { requested.resolve(); gate.promise.then(resolve); } },
    });
    const pending = fetch(new URL("gated", url));
    await requested.promise;
    assert.equal(fixture.requestCounts.get("/gated"), 1);
    gate.resolve();
    assert.equal(await (await pending).text(), "released");
    assert.equal(fixture.requestCounts.get("/entry.js"), 1);
    assert.equal(fixture.requestCounts.get("/fixture-startup.json"), 1);
    assert.equal(fixture.requestCounts.get("/fixture-startup.wasm"), 1);
    assert.equal(fixture.requestCounts.get("/missing.js"), 1);
    await fixture.close();
    assert.equal(fixture.server.listening, false);
    await fixture.close();
  } finally {
    gate.resolve();
    try {
      await fixture.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
