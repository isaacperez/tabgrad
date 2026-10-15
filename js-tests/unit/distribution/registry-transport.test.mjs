import assert from "node:assert/strict";
import { request } from "node:http";
import { createServer, connect } from "node:net";
import { test } from "node:test";
import { registryTransport } from "../../../scripts/package-registry-transport.mjs";

function proxyRequest(proxy, target, options) {
  const address = new URL(proxy);
  return new Promise((resolve, reject) => {
    const client = request({ hostname: address.hostname, port: address.port, path: target, ...options }, response => {
      response.resume(); response.once("end", () => resolve(response.statusCode));
    });
    client.once("error", reject); client.end();
  });
}

test("metadata guard rejects writes and authorization before contacting an origin", async () => {
  const transport = await registryTransport(["http://127.0.0.1:1"], 1000);
  try {
    assert.equal(await proxyRequest(transport.url, "http://127.0.0.1:1/metadata", { method: "POST" }), 403);
    assert.equal(await proxyRequest(transport.url, "http://127.0.0.1:1/metadata", { method: "GET", headers: { authorization: "synthetic-denied" } }), 403);
    assert.equal(await proxyRequest(transport.url, "http://127.0.0.1:2/metadata", { method: "GET" }), 403);
    assert.equal(transport.observations.requests, 0);
    assert.equal(transport.observations.rejected, 3);
    assert.throws(() => transport.assertAllowed(), { code: "REGISTRY_ENDPOINT_REJECTED" });
  } finally { await transport.close(); }
});

test("CONNECT guard tunnels only an admitted target and joins owned socket cleanup", async context => {
  const peers = new Set();
  const server = createServer(socket => {
    peers.add(socket); socket.once("close", () => peers.delete(socket)); socket.on("data", bytes => socket.write(bytes));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  context.after(async () => { for (const peer of peers) peer.destroy(); await new Promise(resolve => server.close(resolve)); });
  const target = `127.0.0.1:${server.address().port}`;
  const transport = await registryTransport([`https://${target}`], 1000);
  const proxy = new URL(transport.url);
  try {
    await new Promise((resolve, reject) => {
      const client = connect(Number(proxy.port), proxy.hostname);
      let output = "";
      client.once("error", reject);
      client.once("connect", () => client.write(`CONNECT unadmitted.example.invalid:443 HTTP/1.1\r\nHost: unadmitted.example.invalid\r\n\r\n`));
      client.on("data", bytes => { output += bytes; });
      client.once("close", () => {
        try { assert.ok(output.startsWith("HTTP/1.1 403")); assert.equal(peers.size, 0); resolve(); }
        catch (error) { reject(error); }
      });
    });
    await new Promise((resolve, reject) => {
      const client = connect(Number(proxy.port), proxy.hostname);
      let output = "";
      client.once("error", reject);
      client.once("connect", () => client.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\nprobe`));
      client.on("data", bytes => {
        output += bytes;
        if (output.includes("probe")) {
          assert.ok(output.startsWith("HTTP/1.1 200")); client.destroy();
        }
      });
      client.once("close", () => output.includes("probe") ? resolve() : reject(new Error("Admitted tunnel did not deliver its payload.")));
    });
    assert.equal(transport.observations.requests, 1);
    assert.equal(transport.observations.rejected, 1);
    assert.throws(() => transport.assertAllowed(), { code: "REGISTRY_ENDPOINT_REJECTED" });
  } finally { await transport.close(); }
});
