import { createServer } from "node:http";
import { realpathSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { websiteRoot } from "./config.mjs";
import { writeChanged } from "./files.mjs";
import { contentType, deliveryHeaders } from "./delivery.mjs";

/** Serve only an inspected output tree; never the checkout or a directory listing.
 * @param {string} root @returns {import('node:http').Server}
 */
export function createPreviewServer(root) {
  const output = realpathSync(resolve(root));
  return createServer(async (request, response) => {
    if (!["GET", "HEAD"].includes(request.method ?? "")) { response.writeHead(405); response.end("Method not allowed"); return; }
    try {
      const url = new URL(request.url, "http://localhost");
      let path = decodeURIComponent(url.pathname);
      if (path.includes("\0") || path.includes("\\") || path.split("/").some((part) => part.startsWith("."))) throw new Error("Invalid route");
      if (path.endsWith("/")) path += "index.html";
      const destination = await realpath(resolve(output, "." + path));
      if (!destination.startsWith(output + sep)) throw new Error("Invalid route");
      if ((await stat(destination)).isDirectory()) {
        const index = await realpath(resolve(destination, "index.html"));
        if (!index.startsWith(output + sep) || !(await stat(index)).isFile()) throw new Error("Invalid route");
        response.writeHead(301, { Location: url.pathname + "/" + url.search, "Cache-Control": "no-cache" });
        response.end(); return;
      }
      const bytes = await readFile(destination);
      response.writeHead(200, { "Content-Type": contentType(destination), ...deliveryHeaders(path, path.endsWith(".html") ? bytes.toString("utf8") : "") });
      response.end(request.method === "HEAD" ? undefined : bytes);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
      response.end(request.method === "HEAD" ? undefined : "Not found");
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createPreviewServer(resolve(websiteRoot, "dist"));
  const index = process.argv.indexOf("--port");
  const port = index < 0 ? 4322 : Number(process.argv[index + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid preview port");
  server.listen(port, "127.0.0.1", async () => {
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/`;
    await writeChanged(resolve(websiteRoot, ".generated/preview-state.json"), JSON.stringify({ pid: process.pid, url }) + "\n");
    console.log(url);
  });
  process.once("SIGINT", () => server.close());
  process.once("SIGTERM", () => server.close());
}
