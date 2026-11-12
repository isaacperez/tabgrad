import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { once } from "node:events";
import { createPreviewServer } from "../scripts/serve.mjs";
import { contentType, deliveryHeaders, scriptHashes } from "../scripts/delivery.mjs";

test("sharing assets, sitemaps and source downloads have their actual content types", () => {
  assert.equal(contentType("/social/tabgrad.png"), "image/png");
  assert.equal(contentType("/sitemap-index.xml"), "application/xml; charset=utf-8");
  assert.equal(contentType("/examples/python/index.html.txt"), "text/plain; charset=utf-8");
});

test("document policy admits only its inline scripts; edited eval belongs to the worker", () => {
  const html = '<script>window.example = 1;</script><script type="application/json">{"text":"not executable"}</script>';
  const policy = deliveryHeaders("/index.html", html)["Content-Security-Policy"];
  assert.equal(scriptHashes(html).length, 1);
  assert.ok(policy.includes(scriptHashes(html)[0]));
  assert.ok(!policy.includes("'unsafe-eval'"));
  const worker = deliveryHeaders(`/playground/executor-${"a".repeat(64)}.worker.js`);
  assert.ok(worker["Content-Security-Policy"].includes("'unsafe-eval'"));
  assert.equal(worker["Cache-Control"], "no-cache");
  assert.equal(deliveryHeaders("/index.html")["Cache-Control"], "no-cache");
});

test("execution aliases redirect once to their canonical route and retain query and isolation", async context => {
  const root = await mkdtemp(join(tmpdir(), "tabgrad-route-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "playground"));
  await writeFile(join(root, "index.html"), "Home");
  await writeFile(join(root, "playground/index.html"), "Playground");
  const server = createPreviewServer(root);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  context.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ["/playground//", "//playground", "/playground%2F/"]) {
    const response = await fetch(base + path + "?example=one&device=webgpu", { redirect: "manual" });
    assert.equal(response.status, 301, path);
    assert.equal(response.headers.get("location"), "/playground/?example=one&device=webgpu", path);
    const canonical = await fetch(base + response.headers.get("location"));
    assert.equal(canonical.status, 200);
    assert.equal(await canonical.text(), "Playground");
    assert.equal(canonical.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(canonical.headers.get("cross-origin-embedder-policy"), "require-corp");
  }
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
  const notFound = '<!doctype html><h1>Page not found</h1><a href="/">Home</a><script>window.recovery = true;</script>';
  await writeFile(join(root, "output/404.html"), notFound);
  for (const path of ["/unknown/", "/leak.txt", "/.env"]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-cache");
    assert.equal(response.headers.get("content-security-policy"), deliveryHeaders("/404.html", notFound)["Content-Security-Policy"]);
    assert.equal(await response.text(), notFound, "missing routes use the built recovery page without reflecting the requested path");
  }
  const head = await fetch(base + "/unknown/", {method: "HEAD"});
  assert.equal(head.status, 404);
  assert.equal(head.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(await head.text(), "");
  await rm(join(root, "output/404.html"));
  await symlink(join(root, "private.txt"), join(root, "output/404.html"));
  assert.equal(await (await fetch(base + "/unknown/")).text(), "Not found", "an unsafe recovery file cannot expose content outside the output");
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

test("search worker can serve isolated and ordinary pages without broader isolation or eval", () => {
  const headers = deliveryHeaders("/pagefind/pagefind-worker.js");
  assert.equal(headers["Cross-Origin-Embedder-Policy"], "require-corp");
  assert.equal(headers["Cross-Origin-Opener-Policy"], undefined);
  assert.equal(headers["Cache-Control"], "no-cache");
  assert.ok(!headers["Content-Security-Policy"].includes("'unsafe-eval'"));
  assert.equal(deliveryHeaders("/docs/")["Cross-Origin-Embedder-Policy"], undefined);
  assert.equal(deliveryHeaders("/pagefind/pagefind.js")["Cross-Origin-Embedder-Policy"], undefined);
});
