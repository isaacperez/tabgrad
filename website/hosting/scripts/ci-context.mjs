import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { publicationOrigin } from "./inventory.mjs";

/** Ordinary CI produces only an unpublished test payload. A real-origin build
 * must be an explicitly enabled, first-attempt manual main run.
 * @param {Record<string,string|undefined>} env @returns {void} */
export function buildContext(env) {
  if (env.TABGRAD_WEBSITE_MODE === "check") return;
  if (env.TABGRAD_WEBSITE_MODE !== "publish" || env.TABGRAD_WEBSITE_ENABLED !== "true"
    || env.GITHUB_EVENT_NAME !== "workflow_dispatch" || env.GITHUB_REF !== "refs/heads/main"
    || env.GITHUB_RUN_ATTEMPT !== "1" || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "")
    || !["true", "false"].includes(env.TABGRAD_WEBSITE_INITIAL ?? "")) throw new Error("Website preparation is not admitted");
  publicationOrigin(env.TABGRAD_SITE_URL);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) buildContext(process.env);
