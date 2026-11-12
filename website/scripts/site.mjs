import { spawn } from "node:child_process";
import { prepareContent } from "./prepare-content.mjs";
import { prepareAssets } from "./prepare-assets.mjs";
import { websiteRoot } from "./config.mjs";
import { join } from "node:path";

process.env.ASTRO_TELEMETRY_DISABLED = "1";
const command = process.argv[2];
if (!["dev", "build", "check"].includes(command)) throw new Error("Use: node scripts/site.mjs dev|build|check");
const [major, minor, patch] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && (minor < 23 || (minor === 23 && patch < 4)))) throw new Error("Website setup requires Node 22.23.4 or later.");

console.log(await prepareContent());
await prepareAssets();
const args = [join(websiteRoot, "node_modules/.bin/astro"), command];
// Cached Markdown can retain obsolete Expressive Code asset URLs after theme changes.
if (command === "build") args.push("--force");
if (command === "dev") args.push("--host", "127.0.0.1", "--port", "4321", "--ignore-lock");
const child = spawn(process.execPath, args, { cwd: websiteRoot, env: process.env, stdio: "inherit" });
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
process.once("SIGINT", () => child.kill("SIGINT"));
process.once("SIGTERM", () => child.kill("SIGTERM"));
