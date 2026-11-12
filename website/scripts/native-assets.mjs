import { relative } from "node:path";

/** Optional test-only bridge to native static serving. Fixtures and report ingress
 * remain in the existing browser harness; every actual app/resource response is
 * fetched from the native server and retains its observed policy, not a rebuilt one.
 * @param {string|undefined} origin @param {string} root
 * @returns {{read:(path:string)=>Promise<Buffer>|undefined,headers:(path:string)=>Record<string,string>}} */
export function nativeAssets(origin, root) {
  const responses = new Map();
  if (origin && !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error("Native test origin must be loopback");
  return {
    read: origin ? async path => {
      const name = relative(root, path).replaceAll("\\", "/");
      if (name.startsWith("..")) throw new Error("Native request outside output");
      const url = "/" + name;
      const response = await fetch(new URL(url, origin));
      if (response.status !== 200) throw new Error(`Native asset did not load: ${url}`);
      const headers = {};
      for (const key of ["content-type", "content-security-policy", "cross-origin-opener-policy", "cross-origin-embedder-policy", "cache-control", "etag", "x-content-type-options", "referrer-policy"]) {
        const value = response.headers.get(key);
        if (value !== null) headers[key] = value;
      }
      responses.set(url.replace(/\/$/, "") || "/", headers);
      return Buffer.from(await response.arrayBuffer());
    } : undefined,
    headers(path) {
      const headers = responses.get(path.replace(/\/$/, "") || "/");
      if (!headers) throw new Error(`Native policy was not observed: ${path}`);
      return headers;
    },
  };
}
