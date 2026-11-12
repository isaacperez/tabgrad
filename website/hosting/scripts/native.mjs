import { Miniflare } from "miniflare";
import { resolve } from "node:path";

/** Start the provider's actual static asset worker on loopback. The required local
 * no-op user worker is unreachable, as in Wrangler's assets-only preview; there
 * is no request-handler script in the deployment configuration.
 * @param {string} directory @returns {Promise<{origin:string,close:()=>Promise<void>}>} */
export async function startNativeServer(directory) {
  const server = new Miniflare({ port: 0, cf: false, enableDevRegistry: false, workers: [{
    legacy: { serviceWorkerScript: "addEventListener('fetch', () => { throw new Error('Unexpected user worker execution'); });" },
    config: { name: "static-site", compatibilityDate: "2026-11-10", env: {},
      assets: { directory: resolve(directory), htmlHandling: "auto-trailing-slash", notFoundHandling: "404-page" } },
  }] });
  try { return { origin: (await server.ready).origin, close: () => server.dispose() }; }
  catch (error) { await server.dispose(); throw error; }
}
