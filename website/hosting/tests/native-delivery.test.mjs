import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import test from "node:test";
import { deliveryHeaders, contentType } from "../../scripts/delivery.mjs";
import { startNativeServer } from "../scripts/native.mjs";
import { verifyPayload } from "../scripts/payload.mjs";
import { websiteRoot } from "../../scripts/config.mjs";

test("native static responses retain page/worker isolation, CSP, revalidation, bytes and real recovery", { timeout: 60_000 }, async context => {
  const root = resolve(process.env.TABGRAD_WEBSITE_PAYLOAD ?? join(websiteRoot, ".generated/delivery"));
  const { manifest } = await verifyPayload(root, { production: false });
  const server = await startNativeServer(root);
  context.after(() => server.close());
  for (const file of manifest.files) {
    if (file.path === "_headers") continue;
    const path = "/" + file.path.replace(/index\.html$/, "");
    const response = await fetch(server.origin + path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("cache-control"), "no-cache", path);
    const bytes = await readFile(join(root, file.path));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes, path);
    const html = file.path.endsWith(".html");
    const expected = deliveryHeaders(path, html ? bytes.toString("utf8") : "");
    if (html || expected["Cross-Origin-Embedder-Policy"]) {
      for (const [key, value] of Object.entries(expected)) assert.equal(response.headers.get(key), value, `${path} ${key}`);
    }
    if ([".js", ".mjs", ".wasm", ".json", ".html"].some(extension => file.path.endsWith(extension)))
      assert.equal(response.headers.get("content-type")?.split(";")[0], contentType(file.path).split(";")[0], path);
  }
  for (const path of ["/missing/", "/vendor/missing/next.js", "/docs/missing/", "/.env", "/_headers"]) {
    const response = await fetch(server.origin + path);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get("cache-control"), "no-cache", path);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8", path);
    assert.equal(await response.text(), await readFile(join(root, "404.html"), "utf8"));
  }
  for (const path of ["/playground", "/playground/index.html"]) {
    const response = await fetch(server.origin + path + "?device=webgpu", { redirect: "manual" });
    assert.ok([301, 307, 308].includes(response.status), path);
    assert.equal(new URL(response.headers.get("location"), server.origin).pathname, "/playground/");
    assert.equal(new URL(response.headers.get("location"), server.origin).search, "?device=webgpu");
  }
  const first = await fetch(server.origin + "/robots.txt");
  assert.ok(first.headers.get("etag"));
  const cached = await fetch(server.origin + "/robots.txt", { headers: { "If-None-Match": first.headers.get("etag") } });
  assert.equal(cached.status, 304);
  assert.equal((await cached.arrayBuffer()).byteLength, 0);
  const head = await fetch(server.origin + "/", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});
