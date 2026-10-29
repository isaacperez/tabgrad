import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { publicationGithub } from "../../../scripts/publication-github.mjs";
import { publicationPlanFixture } from "../../fixtures/publication.mjs";
import { sha256 } from "../../../scripts/release-record-data.mjs";

async function service(context, handler, options = {}) {
  const calls = [], sockets = new Set();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    calls.push({ method: req.method, path: req.url, body });
    try {
      assert.equal(req.headers.authorization, "Bearer fixture-not-a-credential");
      await handler(req, res, body);
    } catch { req.socket.destroy(); }
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  context.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const { publicationPlan: plan } = publicationPlanFixture();
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { plan, calls, api: publicationGithub({ repository: plan.github.repository,
    token: "fixture-not-a-credential", origin, ...options }) };
}
const json = (res, status, value) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));

test("actual HTTP: push visibility is required before interpreting absence", async context => {
  const f = await service(context, (req, res) => json(res, 200, {
    full_name: "example/project", permissions: { push: false }, archived: false, disabled: false }));
  await assert.rejects(f.api.state(f.plan), { code: "PUBLICATION_GITHUB_VISIBILITY" });
  assert.equal(f.calls.length, 1);
});

test("actual HTTP: tag resolution, paginated drafts and full original asset bytes", async context => {
  const raw = Buffer.from("original payload");
  let fixture;
  const f = await service(context, (req, res) => {
    const route = req.url.slice(`/repos/${fixture.plan.github.repository}`.length);
    if (route === "") return json(res, 200, { full_name: fixture.plan.github.repository,
      permissions: { push: true }, archived: false, disabled: false });
    if (route.startsWith("/git/ref/")) return json(res, 200, { ref: `refs/tags/${fixture.plan.github.tag}`,
      object: { type: "tag", sha: "1".repeat(40) } });
    if (route.startsWith("/git/tags/")) return json(res, 200, { object: { type: "commit", sha: fixture.plan.candidate.sourceRevision } });
    if (route === "/releases?per_page=100&page=1") return json(res, 200,
      Array.from({ length: 100 }, (_, i) => ({ id: i + 100, tag_name: `other-${i}` })));
    if (route === "/releases?per_page=100&page=2") return json(res, 200, [{ id: 12, tag_name: fixture.plan.github.tag, draft: true }]);
    if (route === "/releases/12/assets?per_page=100&page=1") return json(res, 200,
      [{ id: 7, name: "payload.bin", state: "uploaded", size: raw.length }]);
    if (route === "/releases/assets/7") return res.writeHead(200).end(raw);
    return json(res, 404, { error: "missing fixture route" });
  });
  fixture = f;
  const state = await f.api.state(f.plan, new Map([["payload.bin", { byteLength: raw.length, sha256: sha256(raw) }]]));
  assert.equal(state.tagRevision, f.plan.candidate.sourceRevision);
  assert.deepEqual(state.assets, [{ id: "7", name: "payload.bin", byteLength: raw.length, sha256: sha256(raw) }]);
  assert.ok(f.calls.some(call => call.path.endsWith("page=2")));
});

test("actual HTTP: write bodies bind exact tag, metadata and opaque asset bytes", async context => {
  const f = await service(context, (req, res, bytes) => {
    let result;
    if (req.url.endsWith("/git/refs")) {
      const body = JSON.parse(bytes); result = { ref: body.ref, object: { type: "commit", sha: body.sha } };
    } else if (req.url.includes("/assets?")) result = { id: 8, name: new URL(req.url, "http://fixture.invalid").searchParams.get("name"),
      size: bytes.length, state: "uploaded", digest: `sha256:${sha256(bytes)}` };
    else result = { ...JSON.parse(bytes), id: 17 };
    return json(res, req.method === "POST" ? 201 : 200, result);
  });
  const { publicationEffects } = await import("../../../scripts/publication-plan.mjs");
  const raw = Buffer.from([0, 255, 13, 10, 0]);
  f.plan.github.assets = f.plan.github.assets.map(asset => ({ ...asset, byteLength: raw.length, sha256: sha256(raw) }));
  const effects = publicationEffects(f.plan);
  for (const effect of effects) if (effect.kind !== "npm-publish") {
    await f.api.write(effect, f.plan, { release: { id: 17 } }, raw, "approved notes");
  }
  const tag = JSON.parse(f.calls[0].body);
  assert.deepEqual(tag, { ref: `refs/tags/${f.plan.github.tag}`, sha: f.plan.candidate.sourceRevision });
  assert.equal(JSON.parse(f.calls[1].body).draft, true);
  for (const call of f.calls.filter(value => value.path.includes("/assets?"))) assert.deepEqual(call.body, raw);
  assert.equal(f.calls.at(-1).method, "PATCH");
  assert.equal(JSON.parse(f.calls.at(-1).body).draft, false);
});

test("actual HTTP: a 2xx response for a different tag remains an unknown dispatched call", async context => {
  const f = await service(context, (req, res) => json(res, 201, { ref: "refs/tags/other", object: { type: "commit", sha: "f".repeat(40) } }));
  await assert.rejects(f.api.write({ kind: "github-tag" }, f.plan),
    error => error.code === "PUBLICATION_GITHUB_CALL_MISMATCH" && error.dispatched === true);
  assert.equal(f.calls.length, 1);
});

for (const scenario of ["reject", "redirect", "disconnect", "timeout", "invalid-json", "oversize"]) {
  test(`actual HTTP: ${scenario} preserves a dispatched uncertain write without retry`, async context => {
    const f = await service(context, (req, res) => {
      if (scenario === "reject") return json(res, 403, { error: "fixture rejection" });
      if (scenario === "redirect") return res.writeHead(302, { location: "https://example.invalid/never-request" }).end();
      if (scenario === "disconnect") return req.socket.destroy();
      if (scenario === "timeout") return undefined;
      if (scenario === "invalid-json") return res.writeHead(201).end("not JSON");
      return res.writeHead(201).end("x".repeat(200));
    }, { timeoutMs: 100, maxResponseBytes: 100 });
    await assert.rejects(f.api.request("/git/refs", { method: "POST", body: { ref: "fixture" } }),
      error => error.dispatched === true);
    assert.equal(f.calls.length, 1);
  });
}
