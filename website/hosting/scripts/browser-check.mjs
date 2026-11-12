import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { startNativeServer } from "./native.mjs";
import { verifyPayload } from "./payload.mjs";
import { repositoryRoot, websiteRoot } from "../../scripts/config.mjs";

const kind = process.argv[2];
if (!["cpu", "gpu"].includes(kind)) throw new Error("Use: browser-check.mjs cpu|gpu");
const payload = resolve(process.env.TABGRAD_WEBSITE_PAYLOAD ?? resolve(websiteRoot, ".generated/delivery"));
await verifyPayload(payload, { production: false });
const server = await startNativeServer(payload);
try {
  const script = kind === "gpu" ? "gpu-browser-check.mjs" : "browser-check.mjs";
  const child = spawn(process.execPath, [resolve(websiteRoot, "scripts", script)], {
    cwd: repositoryRoot, env: { ...process.env, TABGRAD_WEBSITE_NATIVE_ORIGIN: server.origin }, stdio: "inherit",
  });
  const interrupt = () => child.kill("SIGTERM");
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    process.exitCode = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", code => done(code ?? 1)); });
  } finally { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); }
} finally { await server.close(); }
