import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { sha256 } from "../../scripts/files.mjs";
import { manifestName, verifyPayload } from "./inventory.mjs";

/** Missing configuration and re-runs are inert. This is a local context check;
 * the protected GitHub environment and its admitted reviewers remain required.
 * @param {Record<string,string|undefined>} env @returns {{revision:string,digest:string,initial:boolean}} */
export function publicationContext(env) {
  if (env.TABGRAD_WEBSITE_ENABLED !== "true" || env.TABGRAD_WEBSITE_MODE !== "publish"
    || env.GITHUB_EVENT_NAME !== "workflow_dispatch" || env.GITHUB_REF !== "refs/heads/main"
    || env.GITHUB_RUN_ATTEMPT !== "1" || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "")
    || !/^[a-f0-9]{64}$/.test(env.TABGRAD_DELIVERY_SHA256 ?? "")
    || !["true", "false"].includes(env.TABGRAD_WEBSITE_INITIAL ?? "")) throw new Error("Website publication is not admitted");
  return { revision: env.GITHUB_SHA, digest: env.TABGRAD_DELIVERY_SHA256, initial: env.TABGRAD_WEBSITE_INITIAL === "true" };
}

/** @param {unknown} value @returns {{account_id:string,name:string}} */
export function hostingAccount(value) {
  if (!value || typeof value !== "object" || Object.keys(value).sort().join() !== "account_id,name"
    || !/^[a-f0-9]{32}$/.test(value.account_id) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(value.name)) throw new Error("Invalid private hosting configuration");
  return value;
}

/** JSON parser diagnostics may quote their input. Never retain the private
 * original in a public error, stack or cause.
 * @param {string|undefined} input @returns {{account_id:string,name:string}} */
function parseHostingAccount(input) {
  try { return hostingAccount(JSON.parse(input ?? "null")); }
  catch { throw new Error("Invalid private hosting configuration"); }
}

/** Observe only the currently served identity, with a deadline and bounded body.
 * No credentials, redirects or cache reuse are allowed at this public boundary.
 * @param {string} origin @returns {Promise<string>} */
export async function liveDigest(origin) {
  const response = await fetch(new URL(manifestName, origin), { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (response.status !== 200 || !response.body) throw new Error("Live delivery identity is unavailable");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    // A manifest lists at most 20,000 paths and their fixed hashes; this is a
    // transport bound, not an assertion that every allowed path fills it.
    if (bytes > 8 * 1024 * 1024) throw new Error("Live delivery manifest exceeds its transfer bound");
    chunks.push(chunk);
  }
  return sha256(Buffer.concat(chunks));
}

/** A single credential-bearing command, followed only by observations. Once the
 * call starts, any exception or unconfirmed result is unknown: never retry here.
 * Injected operations let local tests inspect this order without using an account.
 * @param {string} root @param {Record<string,string|undefined>} env
 * @param {{deploy:(config:object)=>Promise<number>,observe:(origin:string)=>Promise<string>,record:(value:object)=>Promise<void>}} operations
 * @returns {Promise<object>} */
export async function publishWebsite(root, env, { deploy, observe, record }) {
  const context = publicationContext(env);
  const { manifest, digest } = await verifyPayload(root, { digest: context.digest });
  if (manifest.revision !== context.revision || manifest.origin !== env.TABGRAD_SITE_URL) throw new Error("Publication source or origin changed");
  const account = parseHostingAccount(env.TABGRAD_HOST_CONFIG_JSON);
  if (!env.CLOUDFLARE_API_TOKEN?.trim()) throw new Error("A separately admitted hosting credential is required");
  if (context.initial !== (manifest.previous === null)) throw new Error("Initial publication and predecessor disagree");
  if (!context.initial && await observe(manifest.origin) !== manifest.previous) throw new Error("The live website changed since preparation");
  const config = { ...account, compatibility_date: "2026-11-10", workers_dev: false, preview_urls: false,
    assets: { directory: resolve(root), html_handling: "auto-trailing-slash", not_found_handling: "404-page" } };
  const receipt = { revision: manifest.revision, deliverySha256: digest, state: "unknown", attempted: true, commandExit: null };
  await record(receipt);
  try {
    receipt.commandExit = await deploy(config);
    if (receipt.commandExit !== 0) throw new Error("Hosting command did not complete successfully");
    if (await observe(manifest.origin) !== digest) throw new Error("Published delivery has not been confirmed");
    receipt.state = "confirmed";
    await record(receipt);
    return receipt;
  } catch {
    await record(receipt);
    throw new Error("Website publication result is unknown; inspect before another publication");
  }
}

/** Keep native diagnostics/configuration outside the public payload and Actions
 * log. The official CLI's own internal transfer/retry behavior is not replaced;
 * there is no outer retry or automatic repeat of an uncertain deployment.
 * @param {object} config @param {string} directory @returns {Promise<number>} */
async function deploy(config, directory) {
  const configPath = join(directory, "wrangler.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const binary = resolve("website/hosting/node_modules/wrangler/bin/wrangler.js");
  const child = spawn(process.execPath, [binary, "deploy", "--config", configPath], { env: {
    PATH: process.env.PATH, TMPDIR: directory, XDG_CONFIG_HOME: join(directory, "config"), CI: "true",
    WRANGLER_SEND_METRICS: "false", CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
  }, stdio: ["ignore", "ignore", "ignore"] });
  return await new Promise((done, reject) => { child.once("error", reject); child.once("exit", code => done(code ?? 1)); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, receiptPath] = process.argv.slice(2);
  if (!root || !receiptPath || process.argv.length !== 4) throw new Error("Use: publisher.mjs payload receipt.json");
  const directory = await mkdtemp(join(tmpdir(), "tabgrad-website-publisher-"));
  try {
    const result = await publishWebsite(root, process.env, { deploy: config => deploy(config, directory), observe: liveDigest,
      record: receipt => writeFile(receiptPath, JSON.stringify(receipt) + "\n", { mode: 0o600 }) });
    console.log(JSON.stringify(result));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
