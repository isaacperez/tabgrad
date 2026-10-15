import { createServer } from "node:http";

/** Disposable registry with observable real npm requests; never forwards. */
export async function packageRegistry(context, input, options = {}) {
  const requests = [];
  let origin;
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    if (options.response) return options.response(request, response, { origin, input, requests });
    if (request.url.includes(".tgz")) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(options.bytes ?? input.bytes);
    } else {
      const version = { name: input.expected.name, version: input.expected.version,
        dist: { tarball: `${origin}/package.tgz`, integrity: input.expected.tarball.integrity },
        ...(typeof options.metadata === "function" ? options.metadata({ origin, input, requests }) : options.metadata) };
      const packument = { name: input.expected.name, "dist-tags": { latest: input.expected.version, ...options.tags },
        versions: { [input.expected.version]: version }, ...options.packument };
      response.writeHead(options.status ?? 200, { "content-type": "application/json" });
      response.end(options.text ?? JSON.stringify(packument));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  context.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, requests, plan: { schemaVersion: 1, registry: `${origin}/`, allowedOrigins: [origin],
    channel: "latest", clientTimeoutMs: 10000, maxClientOutputBytes: 1048576 } };
}
