import { createHash } from "node:crypto";
import { createServer, request } from "node:http";
import { request as secureRequest } from "node:https";
import { connect } from "node:net";
import { rootCertificates } from "node:tls";
import { PackageArtifactError } from "./package-artifact.mjs";

/** Explicit URL rules shared by the plan and every redirect before a request. */
export function registryEndpoint(text, originOnly = false, code = "REGISTRY_PLAN_INVALID") {
  let url;
  try { url = new URL(text); } catch { /* Reject below. */ }
  if (!(url !== undefined && !url.username && !url.password && !url.search && !url.hash
    && (url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1"))
    && (!originOnly || url.href === `${url.origin}/`))) {
    throw new PackageArtifactError(code, "Registry endpoints must be explicit credential-free HTTPS origins, or loopback HTTP fixtures.");
  }
  return url;
}

/** Read raw bounded archive bytes before npm parses or extracts any package. */
export async function downloadRegistryArchive(initial, plan, byteLength) {
  const observation = { requests: 0, origins: [], locations: [] };
  const seen = new Set(), visited = new Set();
  const deadline = performance.now() + plan.clientTimeoutMs;
  let current = initial;
  try {
    for (;;) {
      const url = registryEndpoint(current, false, "REGISTRY_ENDPOINT_REJECTED");
      if (!plan.allowedOrigins.includes(url.origin) || visited.has(url.href)) {
        throw new PackageArtifactError("REGISTRY_ENDPOINT_REJECTED", "Registry archive redirect is not admitted or repeats a visited URL.");
      }
      visited.add(url.href);
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining <= 0) throw new PackageArtifactError("REGISTRY_DOWNLOAD_TIMEOUT", "Registry archive acquisition exceeded its deadline.");
      observeOrigin(observation, seen, url.origin);
      observation.locations.push(createHash("sha256").update(url.href).digest("hex"));
      const result = await archiveResponse(url, remaining, byteLength);
      if (result.redirect !== undefined) { current = new URL(result.redirect, url).href; continue; }
      return { bytes: result.bytes, observation, urls: [...visited] };
    }
  } catch (error) { error.registryDownload = observation; error.registryDownloadURLs = [...visited]; throw error; }
}

function archiveResponse(url, timeout, byteLength) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0, completion;
    const finish = (error, result) => {
      if (completion !== undefined) return;
      completion = { error, result };
      client.destroy();
    };
    const client = (url.protocol === "https:" ? secureRequest : request)(url, {
      method: "GET", agent: false, ca: rootCertificates, rejectUnauthorized: true,
      headers: { accept: "application/octet-stream", "accept-encoding": "identity" },
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && typeof response.headers.location === "string") {
        finish(undefined, { redirect: response.headers.location }); return;
      }
      if (response.statusCode !== 200 || (response.headers["content-encoding"] !== undefined
        && response.headers["content-encoding"].trim().toLowerCase() !== "identity") || (response.headers["content-length"] !== undefined
        && response.headers["content-length"] !== String(byteLength))) {
        finish(new PackageArtifactError("REGISTRY_DOWNLOAD_FAILED", "Registry archive response status or declared length differs from the admitted request."));
        return;
      }
      response.on("data", bytes => {
        received += bytes.length;
        if (received > byteLength) {
          finish(new PackageArtifactError("ARCHIVE_MISMATCH", "Registry archive exceeds the admitted byte length."));
        } else chunks.push(bytes);
      });
      response.on("end", () => {
        if (received !== byteLength) finish(new PackageArtifactError("ARCHIVE_MISMATCH", "Registry archive byte length differs from the admitted identity."));
        else finish(undefined, { bytes: Buffer.concat(chunks) });
      });
      response.on("error", cause => finish(downloadFailure(cause)));
    });
    const timer = setTimeout(() => {
      finish(new PackageArtifactError("REGISTRY_DOWNLOAD_TIMEOUT", "Registry archive acquisition exceeded its deadline."));
    }, timeout);
    client.once("close", () => {
      clearTimeout(timer);
      if (completion === undefined) reject(downloadFailure());
      else if (completion.error !== undefined) reject(completion.error);
      else resolve(completion.result);
    });
    client.once("error", cause => finish(downloadFailure(cause)));
    client.end();
  });
}

function downloadFailure(cause) {
  const error = new PackageArtifactError("REGISTRY_DOWNLOAD_FAILED", "Registry archive response did not complete.");
  error.cause = cause;
  return error;
}

/** Origin guard for this read-only npm client, not a general network sandbox. */
export async function registryTransport(origins, timeout) {
  const allowed = new Set(origins);
  const sockets = new Set();
  const observations = { requests: 0, rejected: 0, origins: [] };
  const seen = new Set();
  const server = createServer((incoming, outgoing) => {
    let url;
    try { url = new URL(incoming.url); } catch { /* Reject below. */ }
    if (incoming.method !== "GET" || url?.protocol !== "http:" || url.username || url.password
      || !allowed.has(url.origin) || incoming.headers.authorization || incoming.headers["proxy-authorization"]) {
      observations.rejected += 1;
      outgoing.writeHead(403).end();
      return;
    }
    observeOrigin(observations, seen, url.origin);
    const upstream = request(url, { method: "GET", headers: { accept: incoming.headers.accept ?? "application/json",
      "accept-encoding": incoming.headers["accept-encoding"] ?? "identity" }, timeout }, response => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
      response.on("error", () => outgoing.destroy());
    });
    upstream.on("socket", socket => trackSocket(sockets, socket));
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => outgoing.destroy());
    outgoing.on("close", () => upstream.destroy());
    upstream.end();
  });
  server.on("connection", socket => trackSocket(sockets, socket));
  server.on("connect", (incoming, client, head) => {
    let url;
    try { url = new URL(`https://${incoming.url}`); } catch { /* Reject below. */ }
    if (url === undefined || url.username || url.password || url.pathname !== "/" || url.search || url.hash
      || !allowed.has(url.origin) || incoming.headers.authorization || incoming.headers["proxy-authorization"]) {
      observations.rejected += 1;
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    observeOrigin(observations, seen, url.origin);
    const upstream = connect({ host: url.hostname, port: Number(url.port || 443) });
    trackSocket(sockets, upstream);
    upstream.setTimeout(timeout, () => upstream.destroy());
    upstream.on("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  return { url: `http://127.0.0.1:${server.address().port}`, observations,
    assertAllowed() {
      if (observations.rejected !== 0) throw new PackageArtifactError("REGISTRY_ENDPOINT_REJECTED", "The npm client requested an unadmitted endpoint or method.");
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

function trackSocket(sockets, socket) {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
}

function observeOrigin(observations, seen, origin) {
  observations.requests += 1;
  if (!seen.has(origin)) {
    seen.add(origin);
    observations.origins.push(createHash("sha256").update(origin).digest("hex"));
  }
}
