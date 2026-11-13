import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { preparePayload } from "./payload.mjs";
import { buildContext } from "./ci-context.mjs";

const [source, destination, previous] = process.argv.slice(2);
if (!source || !destination || process.argv.length > 5) throw new Error("Use: prepare.mjs output new-payload [previous-payload]");
const checked = JSON.parse(await readFile(resolve("website/.generated/verified-files.json"), "utf8"));
const production = process.env.TABGRAD_WEBSITE_MODE === "publish";
buildContext(process.env);
if (production && Boolean(previous) !== (process.env.TABGRAD_WEBSITE_INITIAL === "false")) throw new Error("Predecessor selection changed");
if (checked.release && checked.recipeRevision !== process.env.GITHUB_SHA) throw new Error("Website recipe changed");
const { digest, manifest } = await preparePayload(source, destination, {
  checked, origin: process.env.TABGRAD_SITE_URL, revision: checked.release ? checked.revision : process.env.GITHUB_SHA ?? checked.revision, previous, production,
  rollback: process.env.TABGRAD_WEBSITE_ROLLBACK === "true",
});
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `delivery_sha256=${digest}\n`);
const current = new Set(checked.files.map(file => file.path));
console.log(JSON.stringify({ deliverySha256: digest, files: manifest.files.length + 1, revision: manifest.revision, retained: manifest.files.filter(file => !current.has(file.path) && file.path !== "_headers").length }));
