import assert from "node:assert/strict";
import { createServer } from "node:http";

/** Loopback namespace only. Every credential and response is synthetic. */
export async function publicationNamespaceService(t, owner = true) {
  const calls = [], sockets = new Set();
  const server = createServer((request, response) => {
    try {
      assert.equal(request.method, "GET");
      assert.equal(request.headers.authorization, "Bearer fixture-only-not-a-credential");
      const path = decodeURIComponent(request.url); calls.push(path);
      let status = 200, value;
      if (path === "/-/whoami") value = { username: "fixture-owner" };
      else if (path === "/-/org/example/user") value = { "fixture-owner": owner ? "owner" : "developer" };
      else if (path === "/@example/candidate") { status = 404; value = { error: "not_found" }; }
      else throw new Error("unexpected route");
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    } catch { request.socket.destroy(); }
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { registry: `http://127.0.0.1:${server.address().port}/`, calls };
}
