import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { once } from "node:events";
import { createPreviewServer } from "../scripts/serve.mjs";
import { deliveryHeaders, scriptHashes } from "../scripts/delivery.mjs";

test("document policy admits only its inline scripts; edited eval belongs to the worker", () => {
  const html = '<script>window.example = 1;</script><script type="application/json">{"text":"not executable"}</script>';
  const policy = deliveryHeaders("/index.html", html)["Content-Security-Policy"];
  assert.equal(scriptHashes(html).length, 1);
  assert.ok(policy.includes(scriptHashes(html)[0]));
  assert.ok(!policy.includes("'unsafe-eval'"));
  const worker = deliveryHeaders(`/playground/executor-${"a".repeat(64)}.worker.js`);
  assert.ok(worker["Content-Security-Policy"].includes("'unsafe-eval'"));
  assert.match(worker["Cache-Control"], /immutable/);
  assert.equal(deliveryHeaders("/index.html")["Cache-Control"], "no-cache");
});

test("HTTP output preserves bytes, MIME and boundaries including symlinks", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "tabgrad-static-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "output"));
  await writeFile(join(root, "output/index.html"), "<!doctype html><h1>Website</h1>");
  await writeFile(join(root, "output/kernel.wasm"), new Uint8Array([0, 97, 115, 109]));
  await mkdir(join(root, "output/docs"));
  await writeFile(join(root, "output/docs/index.html"), "<h1>Documentation</h1>");
  await writeFile(join(root, "private.txt"), "private");
  await symlink(join(root, "private.txt"), join(root, "output/leak.txt"));
  const server = createPreviewServer(join(root, "output"));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await (await fetch(base + "/")).text(), "<!doctype html><h1>Website</h1>");
  const canonical = await fetch(base + "/docs?example=1", { redirect: "manual" });
  assert.equal(canonical.status, 301);
  assert.equal(canonical.headers.get("location"), "/docs/?example=1");
  const wasm = await fetch(base + "/kernel.wasm");
  assert.equal(wasm.headers.get("content-type"), "application/wasm");
  assert.deepEqual(new Uint8Array(await wasm.arrayBuffer()), new Uint8Array([0, 97, 115, 109]));
  for (const path of ["/leak.txt", "/.env", "/%2e%2e/private.txt", "/.generated/", "/unknown/"]) assert.equal((await fetch(base + path)).status, 404, path);
  assert.equal((await fetch(base + "/", { method: "POST", body: "nothing" })).status, 405);
});

test("execution pages and their workers admit managed Python GPU without isolating docs", () => {
  for (const path of ["/", "/index.html", "/playground/", "/playground/index.html"]) {
    const headers = deliveryHeaders(path);
    assert.equal(headers["Cross-Origin-Opener-Policy"], "same-origin", path);
    assert.equal(headers["Cross-Origin-Embedder-Policy"], "require-corp", path);
  }
  for (const path of [`/playground/executor-${"a".repeat(64)}.worker.js`, "/vendor/tabgrad/0.1.3/webgpu-worker.js"]) {
    assert.equal(deliveryHeaders(path)["Cross-Origin-Embedder-Policy"], "require-corp", path);
  }
  assert.equal(deliveryHeaders("/docs/index.html")["Cross-Origin-Opener-Policy"], undefined);
});
